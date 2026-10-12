# Edit a book's title and author

## Context
A book's title and author are whatever the importer found: the OPF's `<dc:title>`/`<dc:creator>` for an EPUB, `/Info`, XMP or the largest text on the first pages for a PDF. When that's missing or wrong — a PDF titled from its running header, an EPUB whose creator is "Unknown" or a publisher, an author filed as "Hanh, Thich Nhat" next to one filed as "Thich Nhat Hanh" — the Books screen, its filter and title sort, the Search picker, search results, bookmark folders and the reader's sidebar all show it, and there's no fix short of editing `library.db` by hand. This is the roadmap item "Edit a book's title and author from the library, for books whose metadata is missing or wrong".

This adds an **Edit** button to each row on the Books screen that turns the row into a small form with Title and Author fields.

Out of scope:
- Writing the change back to the EPUB or PDF. The file is never touched, as with Remove.
- Keeping the original metadata to "reset" to, or keeping edits when a book is removed and re-imported. Both need a migration (an `original_title`/`original_author` pair or an edits table keyed by `file_hash`) for a case that's rare; removing and re-importing already loses bookmarks (limitation 5, roadmap "Keep bookmarks when a book is removed and re-imported"), and edits can join that item.
- Editing chapter titles, other fields (language, series), or several books at once.
- Editing from the reader's sidebar. One place is enough to start; the Books screen is where the wrong title is noticed among the others.

Ruled out:
- Separate `rename_book` and `set_book_author` commands: two commands, two mock routes and two buttons for what is one form and one `UPDATE`.
- A dialog for the form: `@tauri-apps/plugin-dialog` has no text input, and a modal would be the app's first. The folder screen's inline Rename form (`FolderView.tsx`) is the existing pattern.

Checked with Python's SQLite 3.46.1 against migrations 001–006: there are no triggers or foreign keys on `books` other than the children's `ON DELETE CASCADE`, so `UPDATE books SET title = ?, author = ?` leaves the book's chapters, blocks and highlights alone, a stemmed search joined to `books` returns the new title and a `NULL` author straight away, and the FTS5 `integrity-check` passes on both indexes. Every query that shows a book's title or author (`list_books`, `search`, `list_folder_bookmarks`, `list_annotated_books`, `search_chapters`) reads it from `books` at query time; nothing copies it, and chapter embeddings don't include it, so there's nothing to re-index. It must be a plain `UPDATE`: `INSERT OR REPLACE` deletes the row first and would cascade away the whole book.

Imports are de-duplicated by `file_hash`, so importing the same file again returns the existing row with its edited title, rather than overwriting it. The integration test pins that (§6).

## 1. Core: `ebook_research_core/src/db/library.rs`, `db/mod.rs`, `lib.rs`
- `pub fn update_book_details(conn: &Connection, book_id: i64, title: &str, author: &str) -> Result<()>` in `library.rs`, beside `list_books` (the module's doc comment becomes "The library's books, their chapters and a chapter's text", since it's no longer read-only).
- Each field is trimmed, and runs of whitespace (including newlines pasted from a PDF) collapse to one space. An empty field is stored as `NULL`, which the UI already shows as "Untitled" / "Unknown author" and sorts last, the same as a book that imported with none. So clearing a junk author is possible, and there's no "can't be empty" error to explain.
- Over 500 chars after trimming: `bail!("title is too long (500 characters at most)")` / `"author is too long …"`. A guard against pasting a paragraph by mistake, not a real limit on titles.
- SQL: `UPDATE books SET title = ?1, author = ?2 WHERE id = ?3`. If no row changed, `bail!("no book with id {book_id}")`, as `delete_book` does.
- A private `fn clean_field(value: &str) -> Option<String>` does the trim, collapse and empty-to-`None`.
- Re-export `update_book_details` from `db/mod.rs`'s `pub use library::{…}` and from `lib.rs`.
- No migration, no change to `BookSummary`, so `src/types.ts` and `src/test/fixtures/library.json` are unchanged.

## 2. Tauri command: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- `update_book_details(book_id: i64, title: String, author: String, state) -> Result<(), String>`: lock `state.conn`, call `db::update_book_details`, map the error with `to_string()`. Doc comment: ``/// Frontend calls: `invoke("update_book_details", { bookId: 1, title: "…", author: "…" })`. An empty field clears it. The book's file isn't changed.``
- Add it to `generate_handler!` after `delete_book`.

## 3. Mock backend: `src/test/mockBackend.ts`
- `case "update_book_details"`: throw `no book with id ${id}` for an unknown id; otherwise replace that book in `books` with `title`/`author` cleaned the same way as the core (trim, collapse whitespace, `""` → `null`). A small `cleanField` helper beside the other helpers.
- Two routes would show the old title: `search_library` returns the fixture hits' recorded `book_title`, and `list_folder_bookmarks` returns the copy `add_bookmark` took when the passage was bookmarked. Map both to `{ ...h, book_title: books.find((b) => b.id === h.book_id)?.title ?? null }` when returning, as the core reads it at query time. `list_annotated_books` already reads `books`; the demo's `search(inScope, …)` is handed `books`, so check it takes the title from there.
- No fixture entry: the command returns nothing. The demo gets editing through the same mock, kept in memory for the page's lifetime like its bookmarks.

## 4. Books screen: `src/BooksView.tsx`, `src/App.css`
- State `editing: { id: number; title: string; author: string } | null`. Messages go to the existing `importStatus` line, as Remove's do.
- Each row gets an **Edit** button before Remove, styled and revealed on hover like `.book-remove` (`.book-edit` joins those selectors), with `e.stopPropagation()` because the row opens the book.
- While a row is being edited, it renders instead of the title and meta spans a `<form className="book-edit-form">` with two inputs — `aria-label="Title"` (autofocused, `placeholder="Untitled"`) and `aria-label="Author"` (`placeholder="Unknown author"`) — then **Save** (submit) and **Cancel**. The row's `onClick` does nothing while editing, and its Index/Edit/Remove buttons are hidden. Escape in either input cancels. Only one row edits at a time; Edit on another row replaces the form.
- The inputs start from the stored values (`b.title ?? ""`, `b.author ?? ""`), so a missing title starts empty rather than as the word "Untitled".
- Save calls `invoke("update_book_details", { bookId, title, author })`, then `setEditing(null)`, `setImportStatus(`Updated "${newTitle ?? "Untitled"}"`)`, `onLibraryChanged()` (so the kept-mounted Search screen re-runs its last search and reloads its picker with the new title) and `refreshBooks()`. The list re-sorts by the new title, so the row may move; that's expected. On failure the form stays open with the typed values and the status reads `Saving failed: ${err}`.
- Nothing unsaved survives leaving the screen: `editing` is local state, cleared when `BooksView` unmounts.
- CSS: `.book-edit-form` is a flex row (`flex: 1`, `gap: 0.5em`, wrapping below 600px) with the title input `flex: 2` and the author `flex: 1`, using the existing input styles and tokens. No new tokens.

## 5. Other screens
- No code change. The reader loads `list_books` when it opens a book, Bookmarks & notes reloads its lists on mount, `FolderView` remounts, and the Search screen re-runs on `libraryVersion`. The reader can't be open on the Books screen at the same time (`App` hides it while reading).

## 6. Tests
- `library.rs` `#[cfg(test)]`, using `one_chapter_book` and `load_book` from `test_util`:
  - `update_book_details_changes_title_and_author`: load a book titled "Old" with author "X", add a highlight, update to `"  The   New\nTitle "` / `"Hanh, Thich Nhat"`; `list_books` shows `Some("The New Title")` and `Some("Hanh, Thich Nhat")`, the book's chapter count and highlight count are unchanged, and `search(.., "zebra", Stemmed, None, 10)` hits carry `book_title == Some("The New Title")`.
  - `empty_fields_clear_title_and_author`: updating to `""` / `"   "` stores `None` for both.
  - `update_book_details_rejects_unknown_and_overlong`: an unknown id errors with "no book with id"; a 501-char title errors with "too long" and leaves the stored title as it was; exactly 500 is accepted.
- `tests/integration.rs` `edited_details_survive_reimporting_the_same_file`: import `test.epub`, update its title to "Renamed" and author to "", import `test.epub` again: `already_imported` is true, the same `book_id`, and `list_books` still shows "Renamed" with no author.
- `src/Books.test.tsx`:
  - Edit on Test Book of Research shows Title and Author inputs filled with its values; changing the title to "Zen Research" and the author to "" then Save calls `update_book_details` with `{ bookId, title: "Zen Research", author: "" }`, the row shows "Zen Research" and "Unknown author", the status reads `Updated "Zen Research"`, and with title sort it's now after A Long Book for Scrolling.
  - Cancel and Escape leave the row as it was and make no call; clicking inside the form doesn't open the reader.
  - A failing `update_book_details` (`fail: { update_book_details: "database is locked" }`) keeps the form open with the typed title and shows `Saving failed: database is locked`.
  - After renaming, the filter finds the book by its new title and not its old one.
- `src/Search.test.tsx`: with "neural networks" searched, rename Test Book of Research on the Books screen, return to Search: the results' meta lines and the "Search in" picker show the new title.
- `src/Demo.test.tsx`: unchanged; run it to confirm.
- `ui_fixtures_are_current` should pass untouched.

## 7. README
- Feature list: a bullet, or a clause on the import bullet, saying a book's title and author can be corrected from the Books screen, without changing the file.
- "What's actually verified": under the Books screen entry, Edit and its form, covered by `Books.test.tsx`/`Search.test.tsx` and checked in `npm run dev:mock`; under `library.rs`, `update_book_details` with its cleaning rules and that re-importing the same file keeps the edit.
- Known limitations: limitation 5 (removing a book loses its bookmarks, highlights and notes) gains "and any title or author you edited".
- Roadmap: tick "Edit a book's title and author from the library".
- Per the site-copy memory, no change to `site/` until the release that ships it.

## Verification
1. `cargo test -p ebook_research_core`, `cargo clippy --workspace --all-targets`, `npx tsc --noEmit`, `npm test`, `npm run format:check`.
2. `npm run dev:mock`: edit a title and author, clear an author, cancel with Escape, check the Search picker and a folder's passages show the new title.
3. `npm run tauri dev` on the real library: fix a PDF's title and a "Hanh, Thich Nhat" author, check the Books filter, Search results and the reader's sidebar.
