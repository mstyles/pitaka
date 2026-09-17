# Exact-word search

## Context
Search runs against one FTS5 index, `content_fts`, with `tokenize='porter unicode61'`. The porter stemmer is applied to both the indexed text and the query, so "running", "runs" and "run" all match each other. Quoting a phrase only fixes word order; each word is still stemmed. There's no way to search for words exactly as typed.

This adds a strict "exact words" mode backed by a second FTS5 index without the stemmer (option 1 of three considered; the others were a trigram index for substring matching, and an unindexed `instr`/`LIKE` scan). Case and diacritics are still ignored in both modes: stripping diacritics is preferred, so `samsara` should match `saṃsāra`.

Adding the index to existing libraries needs a schema change, and `open_db` currently only runs `schema.sql` when the DB file is new. So this also introduces schema migrations. Rebuilding the existing index is acceptable (small solo project, iterating quickly).

## 1. Migrations: `rusqlite_migration`
- `rusqlite_migration` is the usual choice with rusqlite: migrations listed as `M::up(include_str!(…))`, version tracked in `PRAGMA user_version`, each migration applied in a transaction. `refinery` (its own history table, several drivers), `sqlx migrate` and Diesel migrations were ruled out as heavier or tied to a different DB library.
- `schema.sql` becomes `migrations/001_initial.sql` as-is. Every DB, new or existing, goes through the same migration list, so the "is the file new?" check in `open_db` goes away.
- Libraries created before versioning have the 001 schema but `user_version = 0`, so 001 would fail on `CREATE TABLE books`. `open_db` checks once: if `user_version = 0` and `books` exists, set the version to 1 before migrating.

## 2. Search indexes: `migrations/002_search_indexes.sql`
- Drop `content_fts` and recreate it with `tokenize='porter unicode61 remove_diacritics 2'`. Both `remove_diacritics 1` (the default) and `2` fold `saṃsāra` → `samsara` and `Ānanda` → `ananda`, composed or decomposed; only `2` folds letters with more than one diacritic (e.g. `ṝ` → `r`).
- Create `content_fts_exact` over the same `content_blocks` with `tokenize='unicode61 remove_diacritics 2'` and its own insert/delete/update triggers.
- Rebuild both indexes from existing text with `INSERT INTO <table>(<table>) VALUES('rebuild')`, so no re-import is needed.

## 3. Core search API: `db.rs`, `lib.rs`
- `#[derive(Deserialize, Clone, Copy)] #[serde(rename_all = "lowercase")] pub enum SearchMode { Stemmed, Exact }`, with a method returning the table name as a fixed string.
- `search(conn, query, mode, limit)`. The table name goes into the SQL with `format!`, which is safe because it only comes from the enum. Same query otherwise, with `snippet()` and `bm25()` on the chosen table.
- FTS5 query syntax (quotes, OR, `word*`) works the same in both modes; `learn*` in exact mode is still a prefix search.
- Export `SearchMode` from `lib.rs`.

## 4. Tauri command: `commands.rs`
- `search_library(query: String, mode: SearchMode, …)` passes `mode` through.

## 5. Frontend: `types.ts`, `LibraryView.tsx`
- `export type SearchMode = "stemmed" | "exact";`
- An "Exact words" checkbox in the search form. `invoke("search_library", { query, mode })`. Toggling it re-runs the search if there's a query, so the two modes are easy to compare.
- No `ReaderView` changes: jumping to a hit only uses `content_block_id`.

## 6. Tests: `tests/integration.rs`, `db.rs`
- Existing calls pass `SearchMode::Stemmed`.
- Against `test.epub`: stemmed `network` hits, exact `network` doesn't, exact `networks` hits 2; stemmed `learn` hits, exact `learn` doesn't, exact `learning` does.
- Unversioned-library upgrade: create a DB from 001 only and insert a book; `open_db` sets the version, and exact search finds the old text (so the index was rebuilt). Reopen to check the second open is a no-op.
- Diacritics: `samsara` matches `saṃsāra`.
- `validate()` on the migration list.

## 7. Known bugs: committed record
- Keep a committed list of known bugs. Start with: punctuation in an unquoted query (`don't`, `a-b`) makes FTS5 throw an error, in both modes. Fix later by quoting terms before searching.
- The README's "UI hasn't been clicked through in Tauri" line is stale (it has been, with no bugs found); update it.

## Verification
1. `cargo test -p ebook_research_core`
2. `npx tsc --noEmit`
3. `cargo build --workspace`
4. `npm run tauri dev`: tick "Exact words" and check `learn` stops matching "learning" while `learning` still does.

## Implementation notes (differences from this plan)
Built in commits 037ba8f (search + migrations) and 1a255c3 (dependency upgrade). Where the code differs from the plan above:
- Known bugs went into the README's existing "Known limitations" list (item 6) instead of a new `KNOWN_ISSUES.md`, so there's one list. The recorded errors were confirmed by running the queries: `don't` → `syntax error near "'"`, `self-aware` → `no such column: aware`, `a.b` → `syntax error near "."`.
- Migrations live in `ebook_research_core/migrations/`. The `PRAGMA foreign_keys = ON` line was removed from 001 (it's a no-op inside a migration transaction; `open_db` sets it per connection).
- Since 002 drops `content_fts` anyway, it recreates the three existing triggers to update both indexes, rather than adding a second set of triggers for the exact index.
- The upgrade test also checks `ananda` and `ṝ` → `r` in both modes, stemmed-only `wander` → "Wandering", and that exact search still ignores case (`NEURAL`).
- 037ba8f pinned `rusqlite_migration` to `~1.2` to match the existing rusqlite 0.31. Nothing else in the tree constrains SQLite, so 1a255c3 upgraded to rusqlite 0.40.2 and `rusqlite_migration` 2.6.0 with no code changes (bundled SQLite 3.45 → 3.53.2).
- There was no `library.db` on the dev machine, so the migration wasn't run against a real library; the upgrade test covers the same path.
- Steps 1–3 of verification pass. The "Exact words" toggle hasn't been clicked through in the Tauri window yet.
