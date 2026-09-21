# Bookmark folders

## Context
There's no way to keep a passage once you've found it. When preparing a talk you want to gather the relevant paragraphs from several books in one place and review them together, e.g. a folder named "Know your limit - Oct 10 2026". This adds bookmarks grouped into named folders: bookmark a paragraph from the reader into one or more folders, and review a folder's passages from the library, each one click away from its place in the book. It's the bookmarks half of the "Highlights, notes and bookmarks UI" roadmap item; the `bookmarks` table from migration 001 has never been written to by the app.

Decisions:
- A bookmark is a whole paragraph (`content_blocks.id`), which the reader can already scroll to and flash like a search hit. Bookmarking part of a paragraph is the highlights feature.
- Folders span the whole library, since a talk draws on several books. Folder names are unique, ignoring case.
- A paragraph can be in any number of folders, at most once per folder. Every bookmark is in a folder; there's no "Unfiled" bucket.
- Folders are listed newest first. Passages in a folder are listed in the order they were added.
- Deleting a folder deletes its bookmarks, after a confirmation. The passages stay in their books.
- `bookmarks.label` stays in the schema but unused.

Out of scope: reordering passages within a folder, notes on bookmarks, highlights, export, and keeping bookmarks when a book is removed and re-imported. Bookmarks cascade with their paragraphs, so removing a book deletes its bookmarks from every folder; for now the Remove dialog warns with a count and README gets a limitation.

Alternatives ruled out:
- A separate `bookmark_folder_items` join table between folders and bookmarks. One `bookmarks` row per (folder, paragraph) pair already gives many-to-many, with nothing to clean up when the last folder goes.
- `ALTER TABLE bookmarks ADD COLUMN folder_id`. SQLite can only add it as nullable, so "every bookmark is in a folder" would be enforced only in Rust. Rebuilding the table gets `NOT NULL` and the `UNIQUE` constraint.
- Storing the passage text on the bookmark so it survives re-import. It's the right fix for that limitation, but re-attaching bookmarks to a re-imported book needs its own design.

## 1. Schema: `migrations/003_bookmark_folders.sql`, `db.rs`
```sql
CREATE TABLE bookmark_folders (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Any bookmarks written before folders existed go into one "Bookmarks" folder.
INSERT INTO bookmark_folders (name)
    SELECT 'Bookmarks' WHERE EXISTS (SELECT 1 FROM bookmarks);

CREATE TABLE bookmarks_new (
    id               INTEGER PRIMARY KEY,
    folder_id        INTEGER NOT NULL REFERENCES bookmark_folders(id) ON DELETE CASCADE,
    book_id          INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    content_block_id INTEGER NOT NULL REFERENCES content_blocks(id) ON DELETE CASCADE,
    label            TEXT,             -- unused for now
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (folder_id, content_block_id)
);
INSERT OR IGNORE INTO bookmarks_new (id, folder_id, book_id, content_block_id, label, created_at)
    SELECT b.id, (SELECT id FROM bookmark_folders), b.book_id, b.content_block_id, b.label, b.created_at
    FROM bookmarks b;
DROP TABLE bookmarks;
ALTER TABLE bookmarks_new RENAME TO bookmarks;

-- The reader looks bookmarks up by paragraph; deleting a book cascades through it too.
CREATE INDEX idx_bookmarks_block ON bookmarks(content_block_id);
```
- List it as `M::up(include_str!("../migrations/003_bookmark_folders.sql"))` in `migrations()`.
- No other table references `bookmarks`, so dropping and renaming it is safe.
- Checked in `sqlite3` against 001 + 002 + 003 with `PRAGMA foreign_keys = ON`, inside a transaction as `rusqlite_migration` runs it:
  - On an empty `bookmarks` table no folder is created. With one old row, it lands in a "Bookmarks" folder. `foreign_key_check` and `integrity_check` are clean.
  - The same paragraph goes into two folders. A second insert into the same folder hits the `UNIQUE` constraint, and `INSERT OR IGNORE` changes 0 rows. A folder named `know YOUR limit - oct 10 2026` is rejected next to `Know your limit - Oct 10 2026`. A bookmark for folder 99 fails the foreign key, even with `OR IGNORE`.
  - Deleting a book removes its bookmarks from every folder, and the folders stay. Deleting a folder removes only its own bookmarks. The FTS5 `integrity-check` still passes.
  - The reader's per-chapter query plans as `idx_content_blocks_chapter` then `idx_bookmarks_block`.
- `COLLATE NOCASE` only folds ASCII, so "Ä" and "ä" count as different names. That's fine here.

## 2. Core: `db.rs`, `lib.rs`
Types (`#[derive(Serialize, Debug)]`):
- `BookmarkFolder { id, name, created_at: String, bookmark_count: i64 }`
- `FolderBookmark { id, folder_id, content_block_id, book_id, book_title: Option<String>, chapter_id, chapter_idx, chapter_title: Option<String>, text: String }`
- `BlockBookmark { content_block_id, folder_id }`
- `BookSummary` gains `bookmark_count: i64`. It's the number of `bookmarks` rows for the book across all folders, via a `(SELECT COUNT(*) FROM bookmarks bm WHERE bm.book_id = b.id)` column in `list_books`.

Folders:
- `create_bookmark_folder(conn, name: &str) -> Result<BookmarkFolder>`:
  - Trims the name, and bails with "folder name can't be empty" if nothing is left.
  - If `SELECT EXISTS(... WHERE name = ?1)` finds a match (the column's `NOCASE` applies), bails with `a folder named "{name}" already exists`.
  - Inserts and returns the folder with `bookmark_count: 0`, so the reader popover can add to it straight away.
- `rename_bookmark_folder(conn, folder_id, name: &str) -> Result<()>`: the same trim, empty and duplicate checks, with the duplicate check excluding `id = folder_id` so changing only the case works. Bails with "no folder with id {folder_id}" if no row was updated.
- `delete_bookmark_folder(conn, folder_id) -> Result<()>`: `DELETE FROM bookmark_folders WHERE id = ?1`, which cascades to its bookmarks. Bails with "no folder with id {folder_id}" if nothing was deleted, like `delete_book`.
- `list_bookmark_folders(conn) -> Result<Vec<BookmarkFolder>>`: `LEFT JOIN bookmarks ... GROUP BY f.id ORDER BY f.created_at DESC, f.id DESC`. `created_at` only has one-second resolution, so `id` breaks ties, as in `list_books`.

Bookmarks:
- `add_bookmark(conn, folder_id, content_block_id) -> Result<i64>`:
  - Bails with "no folder with id {folder_id}" if the folder is missing.
  - Looks up the paragraph's `book_id` with `query_row(...).optional()`, and bails with "no paragraph with id {content_block_id}" if it's missing.
  - Then runs `INSERT OR IGNORE`, taking `book_id` from `content_blocks` so it can't disagree, and returns the row's id.
  - Adding a paragraph that's already in the folder returns the existing id rather than an error, so a double click is harmless.
- `remove_bookmark(conn, folder_id, content_block_id) -> Result<()>`: deletes by the pair. Bails with "that passage isn't in this folder" if nothing was deleted.
- `list_folder_bookmarks(conn, folder_id) -> Result<Vec<FolderBookmark>>`:
  - Joins `bookmarks → content_blocks → chapters → books` and filters on `bm.folder_id = ?1`.
  - Ordered by `bm.id`, i.e. the order the passages were added.
  - Bails with "no folder with id" when the folder doesn't exist, so an empty folder and a stale id aren't confused.
- `get_chapter_bookmarks(conn, chapter_id) -> Result<Vec<BlockBookmark>>`: `SELECT bm.content_block_id, bm.folder_id FROM content_blocks cb JOIN bookmarks bm ON bm.content_block_id = cb.id WHERE cb.chapter_id = ?1`.

Export all eight functions and the three new types from `lib.rs`.

## 3. Tauri commands: `commands.rs`, `src-tauri/src/lib.rs`
- Thin wrappers following the existing pattern, each with a doc comment showing its `invoke` call:
  - `create_bookmark_folder { name }`
  - `rename_bookmark_folder { folderId, name }`
  - `delete_bookmark_folder { folderId }`
  - `list_bookmark_folders`
  - `add_bookmark { folderId, contentBlockId }`
  - `remove_bookmark { folderId, contentBlockId }`
  - `list_folder_bookmarks { folderId }`
  - `get_chapter_bookmarks { chapterId }`
- Add all eight to `generate_handler!`.
- Update the `commands.rs` line in README's project-structure tree.

## 4. Frontend types and navigation: `types.ts`, `App.tsx`
- `types.ts`:
  - Add `BookmarkFolder`, `FolderBookmark` and `BlockBookmark`, mirroring the Rust types.
  - Add `bookmark_count` to `BookSummary`.
- `App.tsx`:
  - Pass `active={reader == null}` to `LibraryView`, so it can refetch counts after the reader has changed bookmarks.
  - Add an `onOpenBookmark(b: FolderBookmark)` handler that calls `setReader({ bookId: b.book_id, chapterId: b.chapter_id, focusBlockId: b.content_block_id })`. It uses the same path as a search hit.

## 5. Reader: `ReaderView.tsx`, `BookmarkPopover.tsx` (new)
- State in `ReaderView`:
  - `folders: BookmarkFolder[]`, loaded with `list_bookmark_folders` on mount.
  - `blockFolders: Map<number, Set<number>>`, loaded with `get_chapter_bookmarks` whenever `activeChapterId` changes. It reuses the `cancelled` guard of the content effect.
  - `popoverBlockId: number | null`.
- Each paragraph becomes `<div className="reader-block">` holding the existing `<p id="block-…">` and a `<button className="bookmark-toggle" aria-label="Bookmark this passage">`.
  - The button is an inline SVG bookmark shape (no icon dependency). It sits in the left margin of `.reader-text`.
  - It's hidden until the paragraph is hovered or focused.
  - While the paragraph is in any folder it stays visible and filled (`.bookmark-toggle.bookmarked`).
  - Clicking it sets `popoverBlockId`.
- `BookmarkPopover` props: `{ contentBlockId, folders, checkedFolderIds, onChanged, onClose }`. It opens below the button.
  - Heading "Add to folder". Below it, one checkbox per folder, newest first, labelled with the folder name.
  - Ticking a folder calls `add_bookmark`, unticking calls `remove_bookmark`, then `onChanged()`. `ReaderView` then refetches `get_chapter_bookmarks`, and `list_bookmark_folders` for the counts.
  - Below the list, a "New folder…" input: Enter calls `create_bookmark_folder` and then `add_bookmark` into the new folder. With no folders yet, this input is all the popover shows.
  - Errors appear inside the popover, e.g. `a folder named "…" already exists`.
  - Escape, or a `mousedown` outside the popover, calls `onClose`. The listener is removed on unmount.
- Only one popover is open at a time, and switching chapter closes it.

## 6. Library: `LibraryView.tsx`, `FolderView.tsx` (new), `App.css`
- `LibraryView`:
  - Gains `openFolderId: number | null` and `folders: BookmarkFolder[]`.
  - `refreshFolders()` runs on mount, after a book is removed, and in an effect when `active` becomes true. `refreshBooks()` also runs in that effect so bookmark counts are current.
  - When `openFolderId` is set, it renders `<FolderView>` in place of its usual content. `LibraryView` stays mounted while reading, so "← Back" from the reader lands back on the folder.
- A "Bookmarks" section between the book list and the search form:
  - One `.folder-row` per folder showing `name` and `N passages` ("1 passage" for one). Clicking a row opens the folder.
  - A "New folder name" input and a "Create" button that call `create_bookmark_folder`. Errors go to the existing status line.
  - With no folders: "No bookmark folders yet. Create one here, or bookmark a passage while reading."
- Remove-book dialog: when `bookmark_count > 0`, it reads `Remove "<title>" from the library? Its N bookmark(s) will be deleted too. The EPUB file won't be deleted.` Otherwise it's unchanged.
- `FolderView` props: `{ folderId, active, onBack, onOpenBookmark, onChanged }`.
  - It loads `list_folder_bookmarks` and the folder's name, taken from `list_bookmark_folders` passed down, and refetches when `active` becomes true.
  - Header: "← Library", the folder name, "Rename" and "Delete".
  - "Rename" swaps the name for an input with Save/Cancel, and calls `rename_bookmark_folder`.
  - "Delete" uses `ask`: `Delete the folder "<name>" and its N bookmarks? The passages stay in their books.` (kind `warning`). Then it calls `delete_bookmark_folder` and `onBack()`.
  - Each passage is a `.folder-passage` with a meta line `<book title> — <chapter title ?? "Chapter N">`, the full paragraph text, and a "Remove" button. The button uses `stopPropagation` and calls `remove_bookmark`.
  - Clicking a passage calls `onOpenBookmark`.
  - Empty state: "No passages yet. Open a book and click the bookmark icon beside a paragraph."
  - `onChanged` makes `LibraryView` refresh folder counts after a rename, remove or delete.
- `App.css`:
  - Add `.reader-block` (`position: relative`) and `.bookmark-toggle`: absolute in the left margin, `opacity: 0` with `.reader-block:hover` / `:focus-within` showing it, and `.bookmarked` always visible and filled.
  - Add `.bookmark-popover`: absolute, above the text, with a border and shadow, and a background that works in both colour schemes.
  - Style `.folder-row` like `.book-row`, and `.folder-passage` like `.results li`.

## 7. Tests
Unit tests in `db.rs` (in-memory DB, books from `one_chapter_book` + `load_book`):
- `migration_003_moves_old_bookmarks_into_a_folder`:
  - `migrations().to_version(&mut conn, 2)`, load a book, and insert an old-style `bookmarks` row.
  - `to_latest`, then `list_bookmark_folders` is one folder named "Bookmarks" with `bookmark_count == 1`.
  - `list_folder_bookmarks` returns that paragraph.
- `bookmark_folder_names`:
  - Creating `"  Talk  "` stores `"Talk"`.
  - `""` and `"   "` fail with "can't be empty", and `"talk"` fails with "already exists".
  - Renaming "Talk" to "TALK" succeeds, and renaming a second folder to "talk" fails.
  - Renaming or deleting id 42 fails with "no folder with id 42".
- `bookmark_folders_list_newest_first`: create "A" then "B", and the listed names are `["B", "A"]`.
- `bookmarks_in_several_folders`:
  - Bookmark paragraph 1 into folders A and B, and paragraph 2 into A. Adding paragraph 1 to A again returns the same id.
  - `get_chapter_bookmarks` returns the three (block, folder) pairs.
  - A's `list_folder_bookmarks` is paragraphs 1 then 2, with the right `book_title`, `chapter_title` and `text`.
  - Adding to a missing folder or paragraph fails with the messages above.
  - `remove_bookmark(A, 1)` leaves B's copy, and removing it again fails.
- `deleting_folder_or_book_removes_bookmarks`:
  - Deleting folder A leaves B's bookmark of the same paragraph.
  - `list_books` reports `bookmark_count` for each book.
  - `delete_book` removes the book's bookmarks from every folder, the folders still list with `bookmark_count == 0`, and `list_folder_bookmarks` is empty.

Integration (`tests/integration.rs`):
- Import `test.epub`, find the "Chapter One: Beginnings" chapter by title, and create the folder "Know your limit - Oct 10 2026".
- Bookmark the chapter's first block. `list_folder_bookmarks` returns one entry whose `book_title` is "Test Book of Research", whose `chapter_title` matches, and whose `text` equals that block's text from `get_chapter_content`.
- `delete_book`, then the folder is still listed, with 0 bookmarks.

## 8. README
- "What's actually verified":
  - The `db.rs` bullet gains bookmark folders: create/rename/delete, a paragraph in several folders, and cascades from both folder and book deletion.
  - The `integration.rs` bullet gains the bookmark round trip.
  - The `ReaderView` bullet gains the bookmark icon and popover, and the `LibraryView` bullet gains the folder list and folder view.
  - The UI sentence says what has and hasn't been clicked through.
- New known limitation 6: bookmarks point at paragraphs, so removing a book (including to re-import it after a parser fix) deletes its bookmarks from every folder, and the Remove dialog only warns with a count. Bookmarks cover whole paragraphs, and passages can't be reordered within a folder.
- Roadmap:
  - Done: add "Bookmark paragraphs into named folders".
  - Later: the existing item becomes "Highlights and notes UI (the `highlights` and `notes` tables already exist in the schema)". Add "Reorder passages within a bookmark folder" and "Keep bookmarks when a book is removed and re-imported (limitation 6)".
- Schema migrations section: no change.

## Verification
1. `cargo test -p ebook_research_core`
2. `cargo clippy --workspace --all-targets`
3. `npx tsc --noEmit`
4. `npm run tauri dev`, against the existing library (which upgrades it to migration 003):
   - Open *Understanding Our Mind*, hover a paragraph, and bookmark it into a new folder "Know your limit - Oct 10 2026". Bookmark a second paragraph from another book into the same folder and into a second folder.
   - Check the icons stay filled after switching chapters and back.
   - In the library, check both folders' counts. Open the folder, and check its passages are in the order added. Click one, check the reader lands on it and flashes it, and check "← Library" returns to the folder.
   - Rename the folder, and try a duplicate name in different case.
   - Remove a passage, and delete the second folder: the passage should still be in the first.
   - Check the Remove-book dialog shows the bookmark count, and cancel it.
   - Check the popover and icons in dark mode.
