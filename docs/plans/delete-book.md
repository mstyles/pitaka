# Delete a book

## Context
There's no way to remove a book from the library. Imports are de-duped by `file_hash`, so a book imported while the parser had a bug (e.g. *Understanding Our Mind*, before `<div>` paragraphs were read) can't be re-imported after the fix: the import returns the old, broken copy as "Already in library". Today the only workaround is editing `library.db` by hand. This is README limitation 8.

"Delete" here means removing the book from the library. The EPUB file on disk is never touched, and the UI says "Remove" to make that clear.

Soft delete (a `deleted_at` column) was ruled out: it needs a migration, every query would have to filter it, and the soft-deleted row would still match the file hash and block re-import. A hard delete needs no schema change.

## 1. Why one `DELETE` is enough
- Every child table references `books(id)` with `ON DELETE CASCADE`: `chapters`, `content_blocks`, `bookmarks`, `highlights`, `notes`. `open_db` turns on `PRAGMA foreign_keys` for each connection.
- Rows removed by a cascade still fire the `content_blocks_ad` trigger, so both `content_fts` and `content_fts_exact` drop the book's text.
- Checked against migrations 001 + 002 in `sqlite3`: deleting one of two books removed its chapters, blocks and highlights; stemmed and exact search for a shared word went from 3 hits to 1; the FTS5 `integrity-check` passed on both indexes.
- A single statement is atomic, so no explicit transaction is needed.

## 2. Core: `db.rs`, `lib.rs`
- `pub fn delete_book(conn: &Connection, book_id: i64) -> Result<()>` runs `DELETE FROM books WHERE id = ?1`. If no row was deleted, `bail!` with "no book with id {book_id}", so a stale UI gets a clear error instead of silently doing nothing.
- Export `delete_book` from `lib.rs`.
- Update the changed-file error in `import_book` (limitation 5) to say the book can be removed from the library and imported again, since that's now possible.

## 3. Tauri command: `commands.rs`, `lib.rs`
- `delete_book(book_id: i64, state)` locks the connection and calls `db::delete_book`. Frontend: `invoke("delete_book", { bookId })`.
- Add it to `generate_handler!`.

## 4. Frontend: `LibraryView.tsx`
- A "Remove" button on each book row. The row's `onClick` opens the book, so the button calls `e.stopPropagation()`.
- Confirm with `ask` from `@tauri-apps/plugin-dialog`: `Remove "<title>" from the library? The EPUB file won't be deleted.` with a warning kind. `ask` is covered by the `dialog:default` capability that's already granted (`allow-ask` is now an alias for `allow-message`), so no capability change.
- On success: `refreshBooks()`, drop any search results with that `book_id` (clicking one would open a book that's gone), and set the status line to `Removed "<title>"`. On failure, show `Remove failed: <err>` in the same place.
- The reader can't be open at the same time: `App` hides `LibraryView` while reading, so there's no open-book case to handle.

## 5. Tests
- Integration (`tests/integration.rs`): import `test.epub`, delete it, then check `list_books` is empty, search for "neural networks" returns nothing in both modes, and importing `test.epub` again gives `already_imported: false`.
- Deleting an unknown id returns an error.
- Unit test in `db.rs` (it can call the private `load_book`): load two small hand-built `ParsedBook`s that share a word, delete the first, and check the second's chapters and search hits are untouched.

## 6. README
- Remove limitation 8 (it's last, so nothing needs renumbering).
- Update limitation 5 to say a changed file can be re-imported by removing the book first.
- Move "Delete a book from the library" from Next up to Done.

## Verification
1. `cargo test -p ebook_research_core`
2. `npx tsc --noEmit`
3. `cargo build --workspace`
4. `npm run tauri dev`: remove *Understanding Our Mind*, check the confirmation mentions the file isn't deleted and cancelling keeps the book. Re-import `~/Documents/books/understandingourmind.epub` and check it shows 66 chapters and a search for `sarvabijaka` (chapter 1) finds it.

## Implementation notes (differences from this plan)
- The `db.rs` unit test also adds a highlight to the deleted book and runs the FTS5 `integrity-check` on both indexes. With `PRAGMA foreign_keys` switched off in `open_db` it fails, so it guards the cascade the delete relies on.
- The integration test also checks that deleting the same book twice fails.
- The Remove button sits at the right of each book row; `.book-title` now takes the spare width and the row centres its items vertically.
- Steps 1–3 of verification pass. The Tauri window hasn't been clicked through yet (step 4).
