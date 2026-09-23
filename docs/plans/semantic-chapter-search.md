# Semantic chapter search

## Context
FTS5 answers "where does this word appear". It cannot answer "which chapters are about this". Measured against the real library (3 books, 125 chapters, 5,208 paragraphs), ten natural-language thematic queries went through `search()` exactly as the app builds them — every word quoted and implicitly ANDed: **four returned zero results** ("grief and losing someone you love", "why does meditation help with suffering", "interconnectedness of all things", "dealing with difficult emotions"), and the rest returned paragraph hits on incidental word co-occurrence. Rewriting the same queries with `OR` returns 1,116–3,865 blocks, i.e. the whole library ranked by stopword statistics. There is no query formulation that makes FTS5 do this job.

This addresses the README roadmap item "Semantic search, so related terms match without being on a curated list". Note the roadmap line conflates two features: inferring transliteration variants (a term-level job, which this plan does **not** do) and retrieving by meaning (a passage-level job, which it does). Limitation 7's curated list stays exactly as it is and keeps handling the Pali/Sanskrit technical vocabulary, which is what it is good at. The two are complementary: semantic finds the chapter, keyword finds the line.

**Chapter-level, not paragraph-level**, for three reasons that each removed a blocker:
- A chapter result needs no highlighted snippet, so the `[`/`]` delimiters from `snippet()`, the `<mark>` substitution in `SearchView.tsx`, and the demo's BM25 port are all untouched. A paragraph-level semantic mode would have had to synthesise a highlight for text that matches no words.
- A chapter hit opens at the chapter, so nothing depends on `content_block_id`. Bookmarks, `get_chapter_content` and the reader's centre-and-flash behaviour are unaffected.
- 25% of `content_blocks` in the real library are under 30 chars (1,323 of 5,208) — headings and verse lines that embed to noise. Chunking over chapter text skips them as index entries while keeping their words in the chunk.

Out of scope for v1: a backfill (see §3), int8 vector quantisation, any ANN index, paragraph-level semantic search, inferring variant pairs, and the browser demo (see below).

Alternatives ruled out:
- **Chapter centroid** (mean of the chapter's chunk vectors). Chapter sizes span 23 to 221,484 chars — median 5,688, p90 21,494 — and 103 of 125 chapters exceed any bundled model's context window, so a centroid is unavoidable if the chapter is one vector. Rejected because a long chapter's centroid drifts to the corpus mean while a 200-char front-matter page produces a sharp vector, so front matter would systematically outrank real chapters. **Max over chunks** is length-robust and, as a bonus, identifies *which* chunk matched, which §5 needs.
- **ONNX Runtime (`ort`)** instead of candle. Faster and better at int8, but it links a C++ library into a project whose entire build is `cargo build` plus system webkit2gtk, and whose macOS/Windows Tauri builds are already untested. candle is pure Rust and cross-compiles like any crate.
- **A remote embedding API.** Contradicts "nothing is uploaded anywhere", the fourth bullet of the README.
- **`sqlite-vec` or any ANN index.** A 50-book library is ~20,000 chunks; brute-force cosine over 384-dim f32 is microseconds. No extension loading, no new storage engine.
- **Shipping the demo a semantic mode.** The demo has no Rust and no SQLite; `src/demo/search.ts` is a hand-port asserted byte-identical to the core for 34 cases. Embeddings cannot be ported that way, and the *query* would need a ~25MB WASM model in a page that currently ships 216KB of JSON. The Chapters scope is hidden when unavailable (§6), which is exactly the demo's state.

### What was checked, and how
A throwaway candle harness outside the workspace (scratchpad `spike/`, not committed) indexed the real library — 1,207 chunks over 113 chapters — and ran the ten queries against two candidate models. Also a `sanity` probe embedding five deliberately unrelated sentences to measure whether a model discriminates at all.

- **`thenlper/gte-small` is unusable here and was rejected on evidence.** It orders correctly but inside a 0.03-wide band (anger↔anger-practice 0.983, anger↔"quantum chromodynamics" 0.952, anger↔"the recipe calls for two cups of flour" 0.956). Over the full library every one of the ten queries returned the *same five chunks* at 0.93–0.95. The mean of its unit vectors has norm 0.987, i.e. every vector points essentially the same direction.
- **The cause is dtype.** `thenlper/gte-small` ships F16 safetensors; loaded as F32 the range collapses, loaded natively as F16 attention overflows to NaN. `BAAI/bge-small-en-v1.5` and `sentence-transformers/all-MiniLM-L6-v2` ship F32 and both behave. Tensor key names and BERT config are otherwise identical between gte-small and MiniLM, so this is not a naming or architecture mismatch. **A model must ship F32 safetensors to be a candidate**, and any candidate must pass the sanity probe before being chosen — benchmark tables did not predict this.
- **`BAAI/bge-small-en-v1.5` with CLS pooling separates cleanly**: anger↔anger-practice 0.823, ↔grief 0.525, ↔"quantum chromodynamics" 0.495, ↔recipe 0.438 — a 0.39 spread against gte's 0.03 and MiniLM's 0.16.
- **Quality over the real library: 7 of 10 queries good, 3 weak.** "interconnectedness of all things" returned Indra's net from the Avatamsaka and the leaf that cannot exist independently of branch, trunk and roots; "dealing with difficult emotions" returned "BEING PRESENT WITH STRONG EMOTIONS" as its top hit; "impermanence and change" returned the passage naming cyclic impermanence. All three return **nothing** from FTS5 today. Weak: "the illusion of a separate self" (top hit was about watching a sunset, and it missed the anattā material these books are full of), "grief and losing someone you love" and "letting go of attachment" returned generic suffering passages.
- **A Table of Contents chunk won "the nature of consciousness"** at 0.817, beating real chapters — "Table of Contents Title Page Introduction Welcome Fifty Verses on the Nature of Consciousness PART I - Store C". Front matter is keyword-dense. This drives the exclusion rule in §2. The EPUB 3 nav-document skip does not catch it, because this book's contents page is an ordinary spine item.
- **Indexing is minute-scale, not free.** 574s for 1,207 chunks — about 10 minutes for three books — at single-item, unbatched CPU inference. Batching should win 5–10×, but this is a progress-reported operation, not a silent one.
- **Score range is narrow and has no natural zero.** Good hits scored 0.66–0.82 with top-vs-median spreads of 0.12–0.19. Cosine always returns a ranked list, so without a floor "No results" would become unreachable. §4 sets one, explicitly uncalibrated.
- **The cascade chain works.** Applying 001–003 plus the candidate 004 to an in-memory SQLite with `PRAGMA foreign_keys = ON`, inserting a book → chapter → chunk row and deleting the book leaves zero `chunk_embeddings` rows: `books` → `chapters` → `chunk_embeddings` cascades through two hops.
- `src/test/mockBackend.ts:217` throws `unmocked command: <cmd>`, so both new commands need mock routes and a fixture entry (§7).

## Build order and check-ins
The numbered sections below are in dependency order, which is not the same as review order — they differ enormously in how much of each can be verified. Six stages, grouped by what actually checks them:

1. **Schema and pure logic** — §3's migration, plus `chunks()`, `is_indexable()`, the f32↔BLOB round-trip and `rank_chunks()` from §2 and §4, all deliberately outside the feature gate so the default `cargo test -p ebook_research_core` and clippy cover them (tests 1–7).
2. **The model boundary** — §1's cargo feature and §2's `Embedder`, including the F32-weights guard. Checked by the sanity probe, test 10, not by CI.
3. **Indexing** — §4's `index_book`, its per-chapter transactions and the progress callback.
4. **Search** — the rest of §4: `search_chapters`, preview slicing and `MIN_SCORE`, with tests 8 and 9.
5. **Tauri commands** — §5.
6. **Frontend** — §6 and §7, with tests 11–15.

**Stop for review after 1, 2, 4 and 6.** After 1 because migration 004 cannot be edited once it has run against a real library — it is the only irreversible step in this plan. After 2 because it answers "does the model load and discriminate in-tree at all", the stage most likely to fail for reasons outside this code, as gte-small did. **After 4 because it is the go/no-go**: everything before it is infrastructure, and stage 4 is where it becomes clear whether the app reproduces the spike's 7-of-10 — if it does not, stages 5 and 6 are wasted work. After 6 to ship. Stages 3 and 5 are mechanical and fall out of the stages either side of them.

**Most of this feature is invisible to CI, by design.** Stage 1 runs in the normal pipeline; stages 2–4 sit behind the cargo feature and are partly `#[ignore]`d so no CI job ever downloads a model, and stage 5 is `commands.rs`, which the README already records as untested by anything. Roughly two-thirds of the feature therefore lands without automated coverage, which makes the stage-2 sanity probe and a real Tauri-window walk at the end load-bearing rather than optional extras.

**Stage 6 can move earlier if that is useful.** It depends on the command *shape*, not on any of the Rust working: `src/test/mockBackend.ts` is the contract, so the frontend can be built and walked in `npm run dev:mock` against fixtures before stage 2 exists. Worth pulling forward to judge the interaction before committing to ten-minute index runs.

## 1. The feature gate: `Cargo.toml` × 2
- A `semantic` feature on `ebook_research_core`, **off by default**, enabling `candle-core`, `candle-nn`, `candle-transformers`, `tokenizers` and `hf-hub` as optional dependencies. `src-tauri` gets a matching passthrough feature `semantic = ["ebook_research_core/semantic"]`, also off.
- Off by default because the spike showed the score floor needs calibration and indexing needs batching before this is ready for everyone, and because it defers the whole packaging question — a ~130MB model has to reach the user somehow, and there are no release builds yet. CI keeps running `cargo test -p ebook_research_core` without the feature, so the new crates never enter the default `Cargo.lock` resolution for the shipped build or the CI job.
- `cargo clippy --workspace --all-targets` must stay warning-free both with and without `--features semantic`; add the feature build to `.github/workflows/ci.yml` as a `cargo check -p ebook_research_core --features semantic` step only (not tests, which would download the model).

## 2. Core: chunking and embedding — new `ebook_research_core/src/semantic.rs`
**The module is always compiled; only `Embedder` and its candle/tokenizers/hf-hub imports sit behind `#[cfg(feature = "semantic")]`.** Everything else here — chunking, the front-matter filter, and the f32↔BLOB encoding in §4 — is pure logic over text and bytes that needs neither the model nor the feature to be correct, so gating it would put it beyond the reach of the default CI run for no benefit. This is what makes stage 1 of the build order reviewable on its own.

- `pub const MODEL_REPO: &str = "BAAI/bge-small-en-v1.5";` and `pub const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";` — the prefix is applied to queries only, never to stored chunks. bge is asymmetric; omitting it degrades results for a reason that looks like model weakness.
- `pub struct Embedder { model: BertModel, tokenizer: Tokenizer, device: Device }` with:
  - `pub fn load() -> Result<Self>` — `hf_hub::api::sync::Api` fetches `config.json`, `tokenizer.json` and `model.safetensors` into the standard HF cache, so the first run needs network and later ones don't. Truncation set to 512 tokens. Weights load as `DTYPE` (F32); `bail!` with "the embedding model must ship F32 weights" if the safetensors header reports F16, so the gte-small failure mode is a clear error rather than silently bad results.
  - `pub fn embed(&self, text: &str) -> Result<Vec<f32>>` — CLS pooling (`out.i((.., 0))`, **not** mean; bge is trained for CLS), then L2-normalise so cosine is a plain dot product.
  - `pub fn embed_query(&self, query: &str) -> Result<Vec<f32>>` — `embed(&format!("{QUERY_PREFIX}{query}"))`.
- `pub fn chunks(text: &str) -> Vec<(usize, usize)>` — returns `(char_start, char_end)` pairs, 1600 chars with 200 overlap, split on char boundaries (the corpus has Pali diacritics, so byte slicing would panic). 1600 chars ≈ 400 tokens, comfortably inside bge's 512 window; the overlap keeps a sentence that straddles a boundary intact in one chunk. Offsets are stored so §5 can slice the preview back out of chapter text without duplicating it.
- `pub fn is_indexable(blocks: &[String]) -> bool` — the front-matter and contents-page filter, returning false when:
  - the joined text is under 200 chars (dedications, half-titles — 12 of the real library's 125 chapters), or
  - there are ≥ 10 blocks and their median length is under 40 chars (a contents page or an index: many short entries).

  A heuristic, chosen because it describes the shape of a list page rather than matching on the words "Table of Contents", which is title-dependent and language-dependent. §8 asserts it against a synthetic contents chapter. Expect to tune it; it is deliberately a pure function over block text so tuning needs no re-import to test.

## 3. Schema: `ebook_research_core/migrations/004_chunk_embeddings.sql`
Listed in `migrations()` in `db.rs` after 003. Applied unconditionally — the table exists whether or not the feature is compiled in, so a library moves between builds without a schema difference, and `migrations_are_valid` covers it in the default CI run.

```sql
CREATE TABLE chunk_embeddings (
  id          INTEGER PRIMARY KEY,
  chapter_id  INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  book_id     INTEGER NOT NULL REFERENCES books(id)    ON DELETE CASCADE,
  chunk_idx   INTEGER NOT NULL,
  char_start  INTEGER NOT NULL,
  char_end    INTEGER NOT NULL,
  model       TEXT    NOT NULL,
  dim         INTEGER NOT NULL,
  vec         BLOB    NOT NULL,
  UNIQUE(chapter_id, chunk_idx)
);
CREATE INDEX idx_chunk_embeddings_book ON chunk_embeddings(book_id);
```

`book_id` is denormalised alongside `chapter_id` so §4 can count indexed books and join without touching `chapters`. `model` is stored per row so a later model change can be detected rather than silently mixing incompatible vectors. `vec` is little-endian f32, `dim * 4` bytes — 1,536 bytes per chunk, ~1.8MB for the real library. int8 quantisation would cut that 4× and is deliberately deferred; at this size it buys nothing.

**No backfill.** Books already in the library are absent from chapter search until removed and re-imported. This matches how the project already behaves (limitation 4: parser and title fixes apply only on import) and avoids a migration that cannot run without the model present. The cost is that absence is silent, which §6 fixes by stating the indexed count in the UI rather than by hiding it.

## 4. Core: indexing and search — `db.rs` (feature-gated blocks)
- `pub fn index_book(conn: &mut Connection, book_id: i64, embedder: &Embedder, progress: &mut dyn FnMut(usize, usize)) -> Result<()>` — reads each chapter's blocks via the existing `get_chapter_content` query, skips chapters failing `is_indexable`, chunks the joined text, embeds each chunk and inserts the rows. **One transaction per chapter, not per book**, so a ten-minute index is interruptible and what completed stays; a chapter with no rows is simply not searchable. `progress(done, total)` is called per chapter.
- `import_book` is unchanged and stays fast: indexing runs *after* `load_book` commits, never inside its transaction, so a minutes-long embedding pass never holds a write lock. The Tauri layer (§5) sequences import-then-index.
- `pub struct ChapterMatch { book_id, book_title: Option<String>, chapter_id, chapter_idx, chapter_title: Option<String>, score: f32, preview: String }` — `#[derive(Serialize)]`. Deliberately **not** `SearchResult`: there is no `snippet`, no `[`/`]` convention and no `rank`, and `score` is positive-is-better, the opposite of `bm25()`. Keeping them separate is what stops the two conventions leaking into each other.
- `pub const MIN_SCORE: f32 = 0.60;` — results below it are dropped so "No results" stays meaningful. **Uncalibrated**: the spike's good hits ran 0.66–0.82 and its weakest kept hit was 0.703, but no nonsense query was measured. §8 adds that measurement and the constant moves to whatever it shows. Calibrating it properly is a follow-up, tracked in §9 — 0.60 is good enough to ship behind the feature flag, not good enough to trust.
- `pub fn search_chapters(conn: &Connection, query: &str, embedder: &Embedder, limit: i64) -> Result<Vec<ChapterMatch>>` — embeds the query with `embed_query`, streams every `chunk_embeddings` row, and keeps per `chapter_id` the single best dot product and that chunk's `(char_start, char_end)`. Sorts descending, drops anything under `MIN_SCORE`, truncates to `limit`, then fetches each winner's chapter and book titles and slices `preview` (~200 chars) out of the chapter text at the winning chunk's offsets. Brute force over every row is intentional — see the ANN note in Context.
- `pub fn semantic_status(conn: &Connection) -> Result<SemanticStatus>` with `pub struct SemanticStatus { available: bool, indexed_books: i64, total_books: i64 }`. `indexed_books` is `SELECT COUNT(DISTINCT book_id) FROM chunk_embeddings`. Defined **outside** the feature gate, returning `available: false` when the feature is off, so the frontend has one unconditional command to ask.

## 5. Tauri: `src-tauri/src/commands.rs`, `lib.rs`
- `semantic_status(state) -> Result<SemanticStatus, String>` — thin wrapper, registered unconditionally.
- `search_chapters(query: String, state) -> Result<Vec<ChapterMatch>, String>` — `limit = 20` (chapters, not paragraphs, so a shorter list than search's 50). Without the feature it returns `Err("semantic search isn't available in this build")`; the frontend never calls it in that state, so this is a guard, not a user-facing string.
- The `Embedder` is loaded once and held in the managed state beside `conn`, as `Mutex<Option<Embedder>>`, built lazily on first use so launching the app doesn't pay the model load.
- `import_book` gains the indexing pass after the core import returns, emitting a Tauri event `semantic_index_progress` with `{ book_id, done, total }` so §6 can show progress. Import still returns its `ImportOutcome` as soon as the book is in the library; indexing continues behind the event.
- Both commands added to `generate_handler!` in `src-tauri/src/lib.rs`.

## 6. Frontend: `src/types.ts`, `SearchView.tsx`, `App.css`
- `types.ts`: mirror `ChapterMatch` and `SemanticStatus` field-for-field in snake_case.
- `SearchView.tsx` gains `scope: "passages" | "chapters"` as a segmented control above the existing box. **`exactWords`, `LastSearch.exact` and `toggleExactWords` are untouched** — they belong to the passages scope, which keeps its "Exact words" checkbox; the checkbox is hidden in the chapters scope, where it has no meaning. The scope control itself is hidden entirely when `semantic_status().available` is false, which is the demo's and the default build's state, so neither shows a control that cannot work.
- Chapter results render as their own list: book title and chapter title (or `Chapter {chapter_idx + 1}`, matching the passages fallback), then the preview as **plain escaped text** — no `dangerouslySetInnerHTML`, no `<mark>`. Clicking opens the reader at `chapter_id` with back label "← Search results", reusing the existing reader-target path in `App.tsx`.
- Under the results, when `indexed_books < total_books`: "*{indexed} of {total} books indexed for chapter search. Remove and re-import a book to include it.*" — the honest substitute for a backfill, so a missing book is stated rather than silently absent.
- While indexing runs, the `semantic_index_progress` event drives "*Indexing {title} for chapter search… {done}/{total} chapters*" on the Books screen. Given ~10 minutes for three books, silent indexing would look like a hang.
- `App.css`: the segmented control and the chapter-result card reuse the existing Paper tokens; no new colours.

## 7. Fixtures and the mock: `src/test/mockBackend.ts`, `src/test/fixtures/library.json`
- Routes for `semantic_status` and `search_chapters` in the mock's `switch`, since it throws `unmocked command` otherwise.
- `library.json` gains a `semantic_status` object and a `chapter_matches` map keyed by query, written by `ui_fixtures_are_current` from real `db.rs` output. The fixture's default `semantic_status` is `available: false`, so **every existing test is unchanged** and the scope control simply doesn't render; the new tests override it via the mock's existing per-test hooks.
- Regenerate with `UPDATE_UI_FIXTURES=1 cargo test -p ebook_research_core ui_fixtures`. The demo fixture (`src/demo/library.json`) is untouched — the demo has no semantic mode.

## 8. Tests
Core unit tests in `semantic.rs` and `db.rs`. **None of tests 1–7 is feature-gated** — they cover the pure logic and the schema, both of which are compiled unconditionally per §2, so all of them run in the default `cargo test -p ebook_research_core` and in CI:
1. `chunks_cover_the_text_with_overlap` — offsets are contiguous-with-overlap, the last ends at the char length, a 1600-char text is one chunk, a 3000-char one is two, and a text with Pali diacritics (`saṃsāra`, `paṭicca`) chunks without panicking and round-trips through `chars().skip(start).take(end - start)`.
2. `contents_pages_are_not_indexable` — `is_indexable` is false for a synthetic 20-block chapter of 25-char entries and for a 150-char dedication, true for a normal 3,000-char chapter of 200-char blocks.
3. `vectors_round_trip_as_blobs` — a `Vec<f32>` to little-endian BLOB and back is bit-identical, and a wrong-length BLOB is a clean error not a panic.
4. `max_over_chunks_picks_the_best_chapter` — inserts hand-written unit vectors for two chapters directly into `chunk_embeddings` and calls the scoring half of `search_chapters` with a hand-written query vector, asserting the chapter owning the single best chunk wins even when the other chapter's chunks have a higher *mean*. **No model needed**, so this runs without a download; split the scoring loop into a `fn rank_chunks(...)` taking a query vector to make it reachable.
5. `below_the_floor_returns_nothing` — a query vector orthogonal to every stored vector returns an empty `Vec`, so "No results" is reachable.
6. `deleting_a_book_removes_its_embeddings` — the cascade verified above, as a test rather than a claim. The table exists in every build, feature or not.
7. `migrations_are_valid` already covers 004 by construction.

Integration (`tests/integration.rs`), `#[cfg(feature = "semantic")]` **and** `#[ignore]` so it never runs in CI or a plain `cargo test`:
8. `semantic_search_finds_a_chapter_by_meaning` — indexes `test.epub`, queries a phrase that appears nowhere in it verbatim, and asserts the right chapter comes back above `MIN_SCORE`. Found by title, not index, since the spine starts with `nav.xhtml`.
9. `nonsense_queries_score_below_the_floor` — **this is the measurement that calibrates `MIN_SCORE`**: index the demo book and assert a deliberately off-corpus query ("quarterly earnings guidance for the fiscal year") scores below the floor while the spike's known-good queries score above it. Adjust the constant to whatever this shows and record the numbers in the README.

10. `the_model_discriminates_unrelated_text` — the spike's sanity probe, kept rather than thrown away. Embeds five deliberately unrelated sentences and asserts the model separates them: "how to work with anger" must score nearer "a practice for calming anger and irritation" (spike: 0.823) than "quantum chromodynamics and the strong nuclear force" (0.495) or "the recipe calls for two cups of flour" (0.438), and the mean of the five unit vectors must have norm below 0.85 (bge: 0.78, gte-small: 0.99). **This is the only test here that would have caught gte-small**, which loads without error, passes every structural test, and returns the same five chunks for every query. Re-run it whenever `MODEL_REPO` changes.

Frontend (`src/*.test.tsx`), against the mock:
11. The scope control is absent when `semantic_status.available` is false, and existing passage-search tests are unaffected.
12. With it available, switching to Chapters runs `search_chapters`, renders book and chapter titles with the preview as text, and hides the "Exact words" checkbox.
13. Clicking a chapter result opens the reader at that chapter, and "← Search results" returns with the query and scope intact.
14. The "{indexed} of {total} books indexed" line appears only when the counts differ.
15. A chapter query returning nothing renders "No results", not an empty list.

## 9. README
- **Known limitations**: a new entry — semantic chapter search covers only books imported while the feature was compiled in, with no backfill; the model is downloaded on first use and needs network once; results are chapter-level so there is no highlighting; the score floor is calibrated against one small corpus; front-matter filtering is a heuristic; and 3 of 10 spike queries were weak.
- **Roadmap**: tick "Semantic search…" as done *for the chapter case*, and add "Later" items for paragraph-level semantic search and for inferring variant pairs, which this does not do.
- **Roadmap — the no-backfill escape hatch**: an "Index this book" action, so a book already in the library can be added in place. §3's no-backfill decision is right for v1, but it leaves remove-and-re-import as the only route in, and that deletes the book's bookmarks (limitation 6) — a steep price to pay for a search feature. An explicit per-book action is the cheaper answer than a migration-time backfill: it needs no schema change, reuses `index_book` from §4 and the progress event from §5, and runs only when the user asks for it. Added to the README roadmap now so the gap is tracked rather than quietly carried by the "{indexed} of {total} books indexed" line in §6.
- **Follow-up — calibrate `MIN_SCORE` against a real corpus**: the 0.60 floor in §4 is a placeholder derived from ten queries over three books by one author, and test 9 only pins it against a single deliberately off-corpus query. That is enough to ship behind the feature flag; it is not enough to trust the "No results" state, because the spike cannot say which way 0.60 errs — too high silently hides good chapters, too low makes "No results" unreachable, and both failures look like "semantic search is a bit rubbish" from the outside. The measurement that would settle it is the score distribution over a wider query set and a more varied library, and in particular over queries that are *plausibly* on-topic but genuinely unanswered by the books — the case where a floor earns its keep, and the one case neither the spike nor test 9 covers. Until that exists the constant is tuning, not a threshold, and the README limitation should say so in those words.
- **What's actually verified**: the spike numbers above — the FTS5 baseline (4 of 10 thematic queries return nothing), bge-small's separation against gte-small's collapse and why, the 7-of-10 quality result with the three weak queries named, the TOC finding, and the 574s/1,207-chunk indexing rate.
- **Project structure**: `semantic.rs` in the core crate's file list.
- **Schema migrations**: 004 in the list.
