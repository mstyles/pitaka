# Ebook render view (reader)

## Context
Pitaka can import EPUBs and full-text search them, but there's no way to actually read a book or see a search hit in context. This adds a reader view: a library list to open books, a continuous-scroll chapter reader with a chapter sidebar, and click-through from search results that jumps to and flashes the matching paragraph. It also fixes chapter titles, which are currently the raw XHTML file path (README limitation #3). Highlights/notes/bookmarks UI is out of scope.

Rendering is built from `content_blocks` (plain-text paragraphs). No HTML is kept during parsing, so every block renders as a `<p>` with no formatting or images. That's fine for this POC.

## 1. Chapter titles: `ebook_research_core/src/epub.rs`, `db.rs`
- `extract_paragraphs` returns `Vec<(bool, String)>`, where the bool is true for blocks from `h1`/`h2`. `depth_stack` becomes `Vec<(is_block, is_heading)>`, and the flag is pushed with the text on `End`. Splitting and offset logic stay the same.
- `ParsedChapter` gets `pub title: String`. In `parse_epub`, it's the first heading block's text, or `full_path` if the chapter has no heading.
- `db::load_book` inserts `chapter.title` into `chapters.title` instead of `file_name`.
- No schema change and no backfill: books already in the library keep the file path as their title until re-imported.

## 2. Read APIs: logic in `db.rs`, thin wrappers in `commands.rs`
Follow the existing `search`/`search_library` pattern (core function returns `anyhow::Result`; the command locks `state.conn` and maps errors to `String`).
- `list_books(conn) -> Vec<BookSummary { id, title, author, chapter_count }>`: `books LEFT JOIN chapters GROUP BY b.id ORDER BY added_at DESC`.
- `get_book_chapters(conn, book_id) -> Vec<ChapterSummary { id, idx, title }>`: `ORDER BY idx`.
- `get_chapter_content(conn, chapter_id) -> ChapterContent { chapter_id, chapter_idx, chapter_title, book_id, blocks: Vec<ContentBlockRow { id, block_idx, text }> }`: one `query_row` on `chapters`, then blocks `ORDER BY block_idx` (uses the existing `idx_content_blocks_chapter` index).
- Add `book_id` and `chapter_id` to `SearchResult`, selected as `b.id, ch.id` in the existing search query. The frontend then has everything it needs to jump to a hit without another command.
- Re-export the new functions and types from `ebook_research_core/src/lib.rs`. Register `list_books`, `get_book_chapters`, `get_chapter_content` in `generate_handler!` in `src-tauri/src/lib.rs`.

## 3. Frontend (plain `useState`, no router or new dependencies)
- **`src/types.ts`** (new): TS versions of `BookSummary`, `ChapterSummary`, `ContentBlockRow`, `ChapterContent`, `SearchResult` (with the new `book_id` and `chapter_id`).
- **`src/LibraryView.tsx`** (new): the current `App.tsx` body (import button, search form, results), plus a book list from `invoke("list_books")`, fetched on mount and again after a successful import. Clicking a book row calls `onOpenBook(id)`. Clicking a search result `<li>` calls `onOpenSearchResult(r)`. The snippet `<mark>` rendering stays unchanged.
- **`src/App.tsx`**: holds `reader: { bookId, chapterId?, focusBlockId? } | null`.
  - Renders `<LibraryView>` inside `<div hidden={reader != null}>`. It stays mounted, so the search query and results are still there after coming back from the reader.
  - Renders `<ReaderView … onBack={() => setReader(null)} />` only when `reader` is set, so every open is a fresh mount and no remount key is needed.
- **`src/ReaderView.tsx`** (new):
  - On mount, `get_book_chapters` loads the chapter list. The active chapter is `chapterId` if one was passed, otherwise the first chapter.
  - When the active chapter changes, call `get_chapter_content`, render blocks as `<p id={"block-" + id} className="reader-paragraph">`, and reset the scroll pane's `scrollTop` to 0 (the pane is held in a ref).
  - When content loads and `focusBlockId` is set: `scrollIntoView({block: "center"})`, add the `flash-highlight` class, then clear it after about 2s with a `setTimeout` that's cleaned up on unmount.
  - Layout: a sidebar with a "← Library" button and a list of chapter buttons (active one bold, label is `title ?? "Chapter N"`), next to a scrollable content column.
- **`src/App.css`**: add `.reader` (full-height flex row, `text-align: left`), `.reader-sidebar` (about 220px wide, scrolls, right border), `.reader-chapter-list button` (plain, full width, left-aligned, `.active` bold), `.reader-content` (flex 1, `overflow-y: auto`, inner column max-width about 720px), `.reader-paragraph` (line-height 1.6, background transition), `.flash-highlight` (the existing `#ffe08a`), `.book-list` and `.book-row` (styled like `.results`, with hover and pointer cursor), and `.results li { cursor: pointer }`. The reader must not sit inside `.container`, which has centered, top-padded landing-page styles.

## 4. Tests: `ebook_research_core/tests/integration.rs`, plus an `epub.rs` unit test
Note: `test.epub`'s spine starts with `nav.xhtml` (its `<h2>` is "Test Book of Research"), so it will parse as a chapter too. Find chapters by title instead of assuming `chapters[0]`.
- Parsed titles include "Chapter One: Beginnings" and "Chapter Two: Deeper Waters".
- After `load_book`: `list_books` returns 1 row whose `chapter_count` equals `parsed.chapters.len()`. `get_book_chapters` returns the titles in idx order. `get_chapter_content` returns blocks in `block_idx` order, and the count matches that chapter's parsed paragraphs.
- A search hit's `book_id` and `chapter_id` match the inserted rows, and `get_chapter_content(hit.chapter_id)` contains `hit.content_block_id`.
- `#[cfg(test)]` unit test in `epub.rs`: `extract_paragraphs("<body><h1>T</h1><p>x</p></body>")` flags the heading, and HTML with no heading gives all `false`, so the chapter falls back to the file path.

## Verification
1. `cargo test -p ebook_research_core`
2. `npx tsc --noEmit`
3. `npm run tauri dev` (needs the webkit2gtk system libs from the README; if they're not installed, say so rather than claiming the UI works):
   - import `test.epub`: the library shows the title, author and chapter count;
   - open the book: the sidebar shows real chapter titles;
   - switch chapters: content swaps and scroll resets to the top;
   - "← Library": the previous search results are still there;
   - search "attention" and click a hit: the reader opens on the right chapter, scrolls to the paragraph and flashes it;
   - check dark mode is still legible.

## Implementation notes (differences from this plan)
Built in commit db22d01. Where the code differs from the plan above:
- The search-hit flash class is `.flash` with a translucent amber (`rgba(255, 208, 0, 0.35)`), not a solid `#ffe08a`, so dark-mode text stays readable.
- `ReaderView` ignores responses from earlier chapter loads (a `cancelled` flag in the effect cleanup), so clicking chapters quickly always ends on the last one clicked. This also covers StrictMode running effects twice in dev.
- The scroll effect runs only when new chapter content arrives, so clearing the flash doesn't reset the scroll position.
- `.reader` is `position: fixed; inset: 0` so it fills the window regardless of the default body margin.
- The reader UI was verified in Chrome against mocked `invoke` responses. `npm run tauri dev` builds and launches, but the app hasn't been clicked through inside the Tauri window.
