# Pin the embedding model

## Context
Semantic chapter search downloads `BAAI/bge-small-en-v1.5` from the Hugging Face repo's `main` branch (`Embedder::load_repo` in `semantic.rs` calls `Api::model(MODEL_REPO)`). If the repo owner uploads new weights, fresh installs get them, and their query vectors would be compared against chunks embedded by the old weights. Nothing would catch that. `rank_chunks` in `db/semantic_index.rs` only checks that vector lengths match, and the `model` column that migration 004 added "so a later model change can be detected" is never read. This is the second Next up item, and the "model isn't pinned" bullet of limitation 9.

What was checked:
- The HF API (`/api/models/BAAI/bge-small-en-v1.5/revision/main`) gives commit `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`, last modified 2024-02-22. That's also the only snapshot in `~/.cache/huggingface/hub/models--BAAI--bge-small-en-v1.5`. Every vector stored so far came from that commit.
- hf-hub 0.4.3: `Repo::with_revision(id, RepoType::Model, sha)` downloads from that commit. Its cache lookup (`CacheRepo::get`) reads `refs/<revision>` to find the snapshot, though, and only `refs/main` exists today. So on the first run after this change an existing install would miss the cache and download the 130 MB model again, which needs a network connection. `CacheRepo::create_ref(sha)` is public and writes `refs/<sha>`, after which `get` finds the existing `snapshots/<sha>/` files.

Out of scope: re-indexing or backfilling books (that's the "Index this book" item in Later), a UI for choosing a model, and changing the model.

Ruled out: failing the whole search when any row has a different model. A single stale book would then break chapter search for the whole library. Skipping those rows, and not counting their books as indexed, keeps search working and shows the gap in the status line the Search screen already has.

## 1. Pin the revision: `semantic.rs`
- `pub const MODEL_REVISION: &str = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a";`, with a comment: change it together with `MODEL_REPO`, then re-run the ignored `the_model_discriminates_unrelated_text` probe and `semantic_eval`.
- `pub const MODEL_ID: &str = "BAAI/bge-small-en-v1.5@5c38ec7c405ec4b44b94cc5a9bb96e735b38267a";`, which is what new `chunk_embeddings.model` values hold. A test asserts it equals `format!("{MODEL_REPO}@{MODEL_REVISION}")`, since `concat!` can't take `const`s.
- `pub const COMPATIBLE_MODELS: &[&str] = &[MODEL_ID, MODEL_REPO];`. The bare repo name is what rows stored before this change say, and they came from the same commit (checked above), so they stay valid with no migration or rewrite.
- `load_repo(model_repo, revision)`: build `Repo::with_revision(model_repo, RepoType::Model, revision)`, call `Cache::default().repo(repo.clone()).create_ref(revision)` (ignoring its error, since a read-only cache only costs a download), then `Api::new()?.repo(repo)` and fetch as now. `load()` passes `MODEL_REVISION`. The fetch error context becomes "fetching {file} for {model_repo}@{revision}".

## 2. Store and check the model: `db/semantic_index.rs`
- `index_book` passes `MODEL_ID` to `store_chapter` instead of `MODEL_REPO`.
- `rank_chunks` gains `models: &[&str]` and reads only matching rows: `SELECT … FROM chunk_embeddings WHERE model IN (SELECT value FROM json_each(?1))` with the list as a JSON array. rusqlite's `bundled` SQLite has JSON1, so no `rarray` feature is needed. Checked: `json_each` filtering works in `sqlite3`; confirm under the bundled build in the unit tests. The dimension `bail!` stays: a matching model name with the wrong length means a corrupt row, not a model change.
- `search_chapters` passes `COMPATIBLE_MODELS`.
- `semantic_status` counts `indexed_books` as `COUNT(DISTINCT book_id) … WHERE model IN (…)` over the same list. A book indexed with another model then shows as not indexed, and the Search screen's "N of M books indexed" says so with no frontend change.
- `COMPATIBLE_MODELS` and `MODEL_ID` live outside the `semantic` feature, in `semantic.rs`'s always-compiled part, because `semantic_status` and `rank_chunks` are always compiled.

## 3. Tauri and frontend
- No change. `commands.rs` already calls `Embedder::load()`, `search_chapters` and `semantic_status` with the same signatures, and `SemanticStatus` keeps its fields, so `src/types.ts` and the UI fixtures stay as they are.

## 4. Tests
- `semantic_index.rs` unit tests: `insert_chunks` takes the model name. The existing tests insert `'test'` and call `rank_chunks(…, &["test"], …)`.
- New `rows_from_another_model_are_skipped`: chapter one's chunks are stored as `MODEL_ID` and chapter two's as `"other/model@abc"`, both on the query. `rank_chunks(…, COMPATIBLE_MODELS, …)` returns only chapter one, and `semantic_status` gives `indexed_books == 1` when the chapters belong to two books.
- New `legacy_rows_without_a_revision_still_rank`: rows stored as `MODEL_REPO` are returned for `COMPATIBLE_MODELS`.
- `semantic.rs`: `model_id_is_repo_at_revision` (the `format!` assertion above) and `revision_is_a_full_commit_sha` (40 lowercase hex chars, so a branch name can't be pinned by mistake).
- `tests/integration.rs` (ignored, needs the model): the `index_book` test's row check expects `MODEL_ID` instead of `MODEL_REPO`. Run the ignored tests once against the existing cache, offline (`HF_HUB_OFFLINE=1` isn't read by hf-hub 0.4, so run with the network off), to confirm the `create_ref` path reuses the cached snapshot instead of downloading.

## 5. README
- Limitation 9: remove the "isn't pinned to a version, and a model change isn't detected" bullet. Add one saying chunks from a different model are ignored, and their books count as not indexed until removed and re-imported.
- Remove the "Pin the embedding model…" item from Next up and add "Pin the embedding model to a Hugging Face commit and ignore vectors from any other model" to Done.
- "What's actually verified", semantic entry: the model is loaded at a pinned commit, a cached copy from before the pin is reused without a download (checked offline), and search and the indexed-books count only use rows from the pinned model.

## Verification
1. `cargo test -p ebook_research_core` and `--features semantic`, `cargo clippy --workspace --all-targets` (both feature sets), `npx tsc --noEmit`, `npm test`.
2. The ignored model tests with the network off, as above.
3. `npm run tauri dev -- --features semantic`: the Search screen still says all previously indexed books are indexed, and a chapter search still returns results.
