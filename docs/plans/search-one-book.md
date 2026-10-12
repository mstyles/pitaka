# Search within one book

## Context
Passage search always runs across the whole library. With 53 books imported, a term like "mindfulness" fills the 50-result cap from a dozen books, and the one you're reading may not appear at all. There's no way to ask "where does *this* book say X?" short of scrolling it. This adds a book scope to passage search: a picker on the Search screen ("All books" or one book), and a **Search this book** button in the reader's sidebar that opens the Search screen scoped to the open book.

Not on the roadmap or in the limitations list yet; the README gains a roadmap line for it (§7).

Out of scope: Chapters (search by meaning) stays library-wide, since a single book has few chapters and scoping it would touch `rank_chunks`; scoping to several books, an author or a bookmark folder; an in-reader find bar that highlights hits in place. Ruled out:
- Filtering library-wide results in the frontend: the 50-hit `LIMIT` is applied first, so a book whose hits rank below 50 others would show nothing.
- A separate `search_book` command beside `search_library`: two commands, two mock routes and two fixture paths for what is one `WHERE` clause.
- A search box inside the reader: it would duplicate `SearchView`'s results list, modes and highlighting, and lose the "← Search results" round trip the Search screen already has.

Checked with Python's SQLite 3.46.1 (the system `sqlite3` has no FTS5) against migrations 001–003 and 005, with 60 matching paragraphs in one book and 5 in another:
- `WHERE content_fts MATCH ?1 AND (?3 IS NULL OR cb.book_id = ?3) ... LIMIT ?2` applies the book filter before the limit: scoped to the small book it returns all 5, not the 0 that made it into the library-wide top 50.
- `bm25()` scores are the same scoped and unscoped (IDF is library-wide, so the filter changes which rows come back, not their scores). Scoped results are therefore exactly the library-wide results for that book, in the same order, up to the limit — which is what lets the mock simply filter its fixtures (§4).
- Query plan: `SCAN content_fts VIRTUAL TABLE INDEX 0:M1`, then `SEARCH cb USING INTEGER PRIMARY KEY`. The filter is applied per FTS match via the rowid join, so a scoped search costs about the same as an unscoped one. No index on `content_blocks(book_id)` is needed.

## 1. Core: `ebook_research_core/src/db/search.rs`
- `search` and `search_with_variants` gain `book_id: Option<i64>`, after `mode`:
  `pub fn search(conn: &Connection, query: &str, mode: SearchMode, book_id: Option<i64>, limit: i64) -> Result<Vec<SearchResult>>`. `None` searches the library as now.
- The SQL gets `AND (?3 IS NULL OR cb.book_id = ?3)` after `WHERE {fts} MATCH ?1`, and `params![fts_query, limit, book_id]`. One statement for both cases, so the scoped path can't drift from the library-wide one.
- An id with no book (removed meanwhile) returns `Ok(vec![])`, not an error: the frontend resets its scope when it notices (§5), and an empty list is what removing the book would leave anyway.
- Doc comment on `search`: "Searches the whole library, or only the book `book_id` when it's given."
- No schema change, no migration. `SearchResult` is unchanged, so `src/types.ts`'s `SearchResult` and the UI fixtures stay as they are.
- Existing callers pass `None`: `db/import.rs` (1), `db/ui_fixtures.rs` (2), `search.rs` tests (5), `tests/integration.rs` (17, mostly through its `hits` closure). Mechanical.

## 2. Tauri command: `src-tauri/src/commands.rs`
- `search_library(query: String, mode: SearchMode, book_id: Option<i64>, state)` → `db::search(&conn, &query, mode, book_id, 50)`. The doc comment's example becomes `invoke("search_library", { query, mode, bookId: 1 })`, with `bookId: null` (or omitted) for the whole library. Already registered in `generate_handler!`; no new command.

## 3. Types: `src/types.ts`
- No type changes. The new argument is passed inline in `invoke`.

## 4. Mock backend: `src/test/mockBackend.ts`
- `search_library`: read `const bookId = args.bookId as number | null | undefined`. With a `search` override (the demo), pass it `bookId == null ? books : books.filter((b) => b.id === bookId)`, so `src/demo/search.ts`'s `createSearch` needs no change. Otherwise filter the recorded hits by `h.book_id === bookId` as well as by the remaining books. Valid because scoped ranks equal library-wide ranks (checked above, and pinned by the core test in §8).
- No new fixture entry: the existing searches already split by book ("neural networks" hits only Test Book of Research, "quincunx" only A Long Book for Scrolling).

## 5. Search screen: `src/SearchView.tsx`, `src/App.tsx`
- `App` holds `const [searchBookId, setSearchBookId] = useState<number | null>(null)`, passed to `SearchView` as `bookId` / `onBookIdChange`. It lives in `App` because the reader sets it too (§6); like the query, it survives leaving the screen but not a restart.
- `SearchView` loads `list_books` when it becomes active and when `libraryVersion` changes (the same effect that re-runs stale searches), into `books` state. If `bookId` isn't among them (the book was removed), it calls `onBookIdChange(null)` before re-running, so the re-run searches the whole library instead of silently returning nothing.
- In the search form row, between the Search button and Exact words, when the scope is Passages and there's more than one book: `<select aria-label="Search in" className="search-book">` with `<option value="">All books</option>` then one option per book, `{title ?? "Untitled"}`, ordered with `sortBooks(books, "title")` from `BooksView.tsx` so it matches the Books screen. Hidden for Chapters, like Exact words. Hidden with one book or none, where there's nothing to narrow.
- `runSearch(q, exact, scope, bookId)` takes the book explicitly (as it does `exact`, so a just-changed value isn't read stale from props) and sends `{ query: q, mode, bookId }` for passages; `LastSearch` records `bookId` too, so a stale re-run repeats the same scope.
- Changing the picker calls `onBookIdChange(id)` and re-runs the current query straight away, as Exact words does.
- When `bookId` changes from outside (the reader, §6), an effect keyed on `bookId` switches the scope to Passages, focuses the box and re-runs the current query if there is one. It compares against a ref of the last `bookId` so it doesn't fire on mount or after the picker's own change already ran the search.
- Placeholder: `Search ${title ?? "Untitled"}…` while scoped, `Search your library…` otherwise.
- While scoped, each result's `.result-meta` shows only the chapter (`{chapter_title ?? `Chapter ${chapter_idx + 1}`}`); the book's title would repeat on every row.
- The count line is unchanged ("3 results", "No results"); the picker beside it says where.
- `src/App.css`: `.search-book { max-width: 16em; text-overflow: ellipsis; }` with the existing form control padding, border and colour tokens. No new tokens.

## 6. Reader: `src/ReaderView.tsx`, `src/App.tsx`
- New prop `onSearchBook: (bookId: number) => void`. Under `.reader-book` in the sidebar, a `<button className="reader-search-book">` with the Search screen's magnifier SVG and the text **Search this book**.
- `App` passes `onSearchBook={(id) => { setSearchBookId(id); setReader(null); navigate("search"); }}`. Results opened from there come back with "← Search results" as now.
- The demo gets this for free through the same `App`.

## 7. README
- Feature bullet "Search your whole library at once": add "or just one book, from the Search screen or the reader".
- "What's actually verified": under `src/SearchView.tsx`, the book picker and the reader's Search this book, covered by `Search.test.tsx` / `ReaderView.test.tsx` and checked in `npm run dev:mock`; under `search.rs`, that `book_id` limits results before the cap without changing ranks.
- Roadmap: add and tick "Search within a single book".
- Per the site-copy memory, no change to `site/` until the release that ships it.

## 8. Tests
- `search.rs` `#[cfg(test)]` `search_can_be_limited_to_one_book`: load two `one_chapter_book`s with `load_book`, the first with 5 paragraphs containing "dhamma", the second with 2. For both modes:
  - `search(.., None, 50)` returns 7 hits;
  - `search(.., Some(second), 50)` returns 2, all with `book_id == second`, and their `(content_block_id, rank, snippet)` equal the second book's hits in the unscoped results, in the same order;
  - `search(.., Some(second), 2)` with `limit` 2 still returns the second book's 2 hits, while `search(.., None, 2)` returns 2 hits from the first book — the filter is applied before the limit (give the first book's paragraphs the shorter text so they rank higher; assert that precondition first);
  - `search(.., Some(9999), 50)` is `Ok` and empty.
- `tests/integration.rs`: after importing `test.epub`, `search(&conn, "neural networks", Stemmed, Some(book_id), 10)` equals the unscoped hits, and with `Some(book_id + 1)` is empty.
- `src/Search.test.tsx`:
  - the existing `callsTo("search_library")` expectations gain `bookId: null`;
  - "Search in" lists All books, A Long Book for Scrolling, Test Book of Research, in that order;
  - search "neural networks" (2 results), choose A Long Book for Scrolling: the search re-runs with its id, shows "No results", and the placeholder reads "Search A Long Book for Scrolling…"; choose Test Book of Research: 2 results, whose meta lines don't contain the book title;
  - the picker is hidden in Chapters scope (with `semantic` available) and with a one-book library;
  - with the picker on A Long Book for Scrolling, removing that book from the Books screen and coming back resets it to All books and re-runs the search across the library.
- `src/ReaderView.test.tsx`: open A Long Book for Scrolling from the Books screen with "quincunx" already searched library-wide, click **Search this book**: the Search screen shows with the picker on that book, the box focused, and `search_library` called with `{ query: "quincunx", mode: "stemmed", bookId: 2 }`; opening the hit returns to the reader at it.
- `src/Demo.test.tsx`: no change expected; the one-book demo hides the picker. Run it to confirm.
- No fixture regeneration: `ui_fixtures_are_current` should pass untouched.

## Verification
1. `cargo test -p ebook_research_core`, `cargo clippy --workspace --all-targets`, `npx tsc --noEmit`, `npm test`, `npm run format:check`.
2. `npm run dev:mock`: pick a book, switch modes and scopes, Search this book from the reader, remove the scoped book.
3. `npm run tauri dev` against the 53-book library: "mindfulness" library-wide vs. scoped to one Thich Nhat Hanh book; a scoped search returns hits from a book absent from the library-wide 50.

## Implementation notes (differences from this plan)
- `LastSearch` doesn't record the book: a re-run after books change uses the current `bookId` (nulled if that book was removed), since every change of book already re-runs the search, so the two only differ when there was nothing to search.
- There was no `select` styling, so `select` joins `input` and `button` in the base control rules (border, radius, height, focus ring) rather than `.search-book` restating them.
- The `search` test helper finds the box by `/^Search .*…$/`, since the placeholder names the book while scoped.
- `Books.test.tsx` "shows a run that finished while away once" looked up a book's title with no selector; the mounted, hidden Search screen's picker now has an `<option>` with the same text, so it's scoped to `.book-title` like the file's other lookups.
