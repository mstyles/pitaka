# Import a directory of books

## Context
Books can only be imported one at a time: "Import EPUB…" opens a file picker with `multiple: false`, and `BooksView.importBook` calls `import_book` once. Bringing an existing collection in (a folder of downloads, or a Calibre library laid out as `Author/Title/file.epub`) means one dialog per book. This is the roadmap item "Import a whole directory of books in one go, instead of one file at a time".

The feature: an "Import folder…" button picks a directory, every `.epub` under it (recursively) is imported, the Books screen shows "Importing 3 of 40…" as it goes, and ends with a summary of what was imported, what was already in the library, and what failed and why.

Out of scope: watching a folder for new books, re-indexing changed files (limitation 4 is unchanged: a changed file at an imported path still fails, and is reported as a failure here), importing formats other than EPUB, and multi-select in the file picker.

Ruled out:
- One core `import_directory` command that imports everything and returns a report. It would hold `state.conn` for the whole run (minutes for a big folder), stalling every other command, and progress would need a new event. Instead the core only *finds* the files, and the frontend calls the existing `import_book` once per file, so the lock is released between books, progress is a plain state update, and stopping part-way is a flag check.
- Top-level files only. A Calibre library has no EPUBs at its top level, so it would import nothing.
- A hand-written recursive `std::fs::read_dir`. It's easy without symlinks, but following linked folders (e.g. `~/Books/Kindle` linked to another drive) needs loop detection, and Windows junctions have their own quirks (`docs/plans/windows-support.md`). The `walkdir` crate handles both; it was approved for this, and `walkdir 2.5.0` is already in `Cargo.lock` through Tauri's crates, so the workspace builds nothing new.

## 1. Core: finding the files — `Cargo.toml`, `db/import.rs`, `db/mod.rs`, `lib.rs`
- `ebook_research_core/Cargo.toml`: `walkdir = "2"` (resolves to the 2.5.0 already locked).
- `pub fn find_epubs(dir: &str) -> Result<EpubScan>`, in `import.rs` beside `import_book` (it touches no DB, but it belongs to the import area and that's where the command list looks for it).
- `#[derive(Serialize, Debug, PartialEq, Eq)] pub struct EpubScan { pub paths: Vec<String>, pub unreadable: Vec<String> }`: `paths` are the EPUBs found, `unreadable` the paths walkdir couldn't read (a folder like `lost+found` when a drive's root is picked, or a broken link named `*.epub`), so one bad entry doesn't sink the whole scan.
- Before walking, `std::fs::metadata(dir)`: on error `bail!("couldn't read {dir}: {e}")`; if it isn't a directory `bail!("{dir} isn't a folder")`. (Checked: given a file, walkdir just yields that file.)
- The walk: `WalkDir::new(dir).follow_links(true).sort_by_file_name().into_iter().filter_entry(|e| e.depth() == 0 || !is_hidden(e))`, where `is_hidden` means the name starts with `.`. The `depth() == 0` exception is needed because otherwise picking a hidden folder itself would find nothing (checked).
- Hidden entries skipped by `filter_entry`: folders like `.Trash-1000` and `.caltrash` aren't walked, and macOS `._Book.epub` AppleDouble files (not EPUBs, so each would be a parse failure) aren't returned.
- A file counts when `entry.file_type().is_file()` (with `follow_links`, a link to a file reports the target's type) and its extension is `epub`, compared case-insensitively, so `B.EPUB` is found.
- Errors, checked against walkdir 2.5.0 with a scratch tree: a link back to an ancestor (`sub/loop -> ..`) is an `Err` with `loop_ancestor()` set, and is skipped silently, since it's the expected result of following links. Any other `Err` (a `chmod 000` folder gives `PermissionDenied`, a broken link gives `NotFound`) pushes `err.path()` onto `unreadable` and the walk carries on.
- Following links to a sibling folder visits the same books twice (checked: `other/c.epub` and `sub/sibling/c.epub` both come back). Keep a `HashSet` of `std::fs::canonicalize` results and keep only the first path for each, so a folder linked into the tree twice isn't counted twice as "already in library". If `canonicalize` fails, keep the path; `import_book` will report the error.
- Paths are returned as `to_string_lossy()` strings (what `import_book` takes), in walk order: sorted by name within each folder, depth-first, so imports run in a predictable order and tests can compare exact lists. A non-UTF-8 file name would be mangled by `to_string_lossy` and then fail to open; it's reported as a failed import with the OS error, which is acceptable for a rare case.
- No `same_file_system`: following a link onto another drive is the point. No `max_depth` either; loop detection already bounds the walk.
- Re-export `find_epubs` and `EpubScan` from `db/mod.rs` (the `pub use import::{…}` line) and `lib.rs`.

## 2. Tauri commands — `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- `find_epubs(dir: String) -> Result<EpubScan, String>`: `#[tauri::command]`, no state needed, `db::find_epubs(&dir).map_err(|e| e.to_string())`. Frontend: `invoke("find_epubs", { dir })`. Register in `generate_handler!`.
- Make `import_book` `async` and run its body on `tauri::async_runtime::spawn_blocking`, as `search_chapters` already does, taking `app: AppHandle` and reaching `AppState` through `app.try_state`. Per the Tauri docs a non-async command runs on the main thread, so today the window can't repaint while a book parses; for one book that's a brief freeze, but in a folder import the "Importing 3 of 40…" line would only update in jumps. Its signature to the frontend (`path` in, `ImportOutcome` out) doesn't change.
- Semantic indexing is untouched: each newly imported book still calls `index_in_background`, whose threads queue on `state.indexing`, so a 40-book import parks up to 40 threads that index one at a time. The `indexing` mutex isn't FIFO, so books may index out of import order; the progress line names the book, so that's fine. Note this in limitation 9.
- The directory picker is `open({ directory: true })` from `@tauri-apps/plugin-dialog`, covered by the `dialog:default` capability already granted (it includes `allow-open`), so no capability change.

## 3. Frontend — `src/types.ts`, `src/BooksView.tsx`, `src/App.tsx`, `src/App.css`
- `types.ts`: `export type EpubScan = { paths: string[]; unreadable: string[] };`.
- The import keeps running when you leave the Books screen. `BooksView` is unmounted on every screen change, so the loop can't live there; it goes in a `useFolderImport(onLibraryChanged)` hook exported from `BooksView.tsx` and called in `App`, which stays mounted, the same way `useIndexing` already follows indexing across screens.
- The hook's state, `FolderImport | null`: `{ dir, total, done, imported, already, failures: { path, error }[], running, stopped }`. `null` until the first folder import. It returns `{ folderImport, startFolderImport(dir), stopFolderImport() }`.
- `startFolderImport(dir)` (the folder is picked in `BooksView` and handed in):
  1. Sets `{ dir, total: 0, done: 0, running: true, … }` — `BooksView` shows `Looking for books in ${dir}…` while `total` is 0 and it's running — then `invoke<EpubScan>("find_epubs", { dir })`. On error the state ends with that error as `scanError`, shown as `Import failed: <err>`. The scan's `unreadable` paths seed `failures` with the error `couldn't be read`.
  2. For each path, breaks if `stopRef.current` is set; else `invoke<ImportOutcome>("import_book", { path })`, then a functional `setFolderImport` adding to `done` and to `imported`, `already` or `failures`.
  3. At the end, sets `running: false` and calls `onLibraryChanged()` once if `imported > 0`. Once, not per book: `SearchView` re-runs its last search whenever `libraryVersion` changes while it's on screen, so bumping per book would reshuffle the Search screen's results under you for the whole import. A search started mid-import already sees the books imported so far, since it queries the live library.
- `stopFolderImport()` sets `stopRef.current = true`; the loop ends after the current book (an `import_book` already in flight can't be cancelled, and each book is its own transaction, so nothing is half-imported).
- A second folder import can't start while one runs (the buttons are disabled, and `startFolderImport` returns early as a guard). A single-file import also waits, since both report on the same status row.
- `App.tsx`: `const { folderImport, startFolderImport, stopFolderImport } = useFolderImport(() => setLibraryVersion((v) => v + 1));`, passed to `BooksView` as props. A finished summary stays until the next import starts; it isn't dismissed on leaving the screen as a finished indexing run is, since the failures list is something you may come back to read.
- `BooksView`:
  - A second button beside "Import EPUB…": `<button onClick={importFolder}>Import folder…</button>` (secondary style; the primary stays on the single-file import). `importFolder` is just `const dir = await open({ directory: true, multiple: false })`, returning on null, then `startFolderImport(dir)`.
  - While `folderImport.running`: both import buttons disabled, a "Stop" button in the row, and the status line `Importing ${done + 1} of ${total}…`.
  - When it's done, the status line is built from the non-zero parts: `Imported 12 books, 3 already in library, 2 failed` (singular "1 book"; a `Stopped after 5 of 40: ` prefix when stopped; `Nothing new: 40 already in library` when that's all there was; `No EPUB files in ${dir}` for an empty scan).
  - The existing `importStatus` (single-file import, remove) and the folder import share the row: whichever happened last is shown, so starting a folder import clears `importStatus` and a single import or a remove after a finished folder import replaces its summary.
  - `useEffect(() => { refreshBooks(); }, [folderImport?.imported])`, so the list fills in as books land while the screen is open; on returning to the screen the mount-time `refreshBooks` already catches up.
  - Remove buttons stay enabled during an import: the next `import_book` doesn't depend on any other book.
  - Failures are listed under the row in `<ul className="import-failures">`, one `<li>` per file: the path relative to the picked folder (strip the `dir` + `/` prefix), then `: ` and the error. The list clears when the next import of either kind starts.
- Progress is shown only on the Books screen; other screens don't show it (a nav bar indicator is left for later, if it's missed).
- `App.css`: `.import-failures` — small text in `--text-muted`, error-coloured path, `max-height: 12rem; overflow-y: auto` so 50 failures don't push the book list off screen.

## 4. Mock backend and fixtures — `src/test/mockBackend.ts`, `db/ui_fixtures.rs`
- Check in `ebook_research_core/tests/fixtures/epub-dir/`: `a.epub` and `Nested/b.EPUB` (zero-byte, since the scan never opens them), `notes.txt`, `._a.epub`, `.hidden/c.epub`. `ui_fixtures_are_current` adds `find_epubs: find_epubs("tests/fixtures/epub-dir")` to `library.json`; relative paths keep the file stable across machines.
- Mock: `case "find_epubs": return data.find_epubs`; `plugin:dialog|open` returns a new `openDir` option (default `"/books/folder"`) when `args.options?.directory`, else `openPath` as now.
- Mock `import_book` gains `importErrors?: Record<string, string>` (reject that path with that message); any other path behaves as today: the fixture book is added the first time, `import_again` after.

## 5. Tests
- Unit tests in `import.rs` (tempdir under `std::env::temp_dir()` with a unique name, removed at the end, as `skips_duplicate_imports` does with its files):
  - `find_epubs_walks_subfolders`: on the checked-in `tests/fixtures/epub-dir`, `paths == ["tests/fixtures/epub-dir/Nested/b.EPUB", "tests/fixtures/epub-dir/a.epub"]` (names sort bytewise, so `Nested` comes before `a`), `unreadable` empty. The hidden `._a.epub` and `.hidden/c.epub` and `notes.txt` aren't returned. Symlinks aren't checked in, as they don't survive a Windows checkout; the tests below make them in a tempdir.
  - `find_epubs_follows_linked_folders` (`#[cfg(unix)]`): a tempdir with `a.epub`, `other/c.epub`, `linked -> <a second tempdir holding d.epub>`, `sub/loop -> ..` and `sub/again -> ../other`. `paths == [a.epub, linked/d.epub, other/c.epub]` (c.epub once, under its first-walked path), `unreadable` empty, and it terminates.
  - `find_epubs_reports_unreadable_paths` (`#[cfg(unix)]`, skipped when running as root, where `chmod 000` doesn't block reads): `locked/` with mode `000` and a broken link `gone.epub -> nowhere` both land in `unreadable`, and `a.epub` is still found. Mode restored before cleanup.
  - `find_epubs_walks_a_hidden_root`: picking `.hidden/` itself returns its `c.epub`.
  - Errors: a missing dir gives "couldn't read", a file path gives "isn't a folder".
- Integration (`tests/integration.rs`) `imports_every_book_in_a_folder`: a tempdir with `test.epub` copied to `one/test.epub` and `two/copy.epub`, plus `bad.epub` containing `not a zip`. Importing each path from `find_epubs` gives one new book, one `already_imported` with the same `book_id`, and one error; `list_books` has exactly one book.
- Frontend (`src/Books.test.tsx`), with `find_epubs` returning `["/books/folder/a/test.epub", "/books/folder/b/copy.epub", "/books/folder/bad.epub"]` and `importErrors: { "/books/folder/bad.epub": "invalid Zip archive" }`:
  - "Import folder…" calls `find_epubs` with `{ dir: "/books/folder" }`, then `import_book` for the three paths in order, and shows `Imported 1 book, 1 already in library, 1 failed` and `bad.epub: invalid Zip archive` in the failures list.
  - Cancelling the folder picker calls nothing.
  - An empty scan shows `No EPUB files in /books/folder`.
  - Clicking Stop while the first `import_book` is pending (a mock option that holds it on a promise) means no second `import_book` call, and the status starts `Stopped after 1 of 3`.
  - Navigating to Bookmarks while the first `import_book` is pending, releasing it, then coming back to Books: all three paths were imported, the summary and failures list are shown, and the imported book is in the list.
  - The import buttons are disabled while it runs, and enabled again after.

## 6. README
- Feature list: mention importing a whole folder.
- "What's actually verified": the scan's unit tests, the integration test, the frontend tests, and what was or wasn't clicked through in the Tauri window.
- Known limitations: under 4, a changed book at an imported path fails in a folder import too (listed with the reason). Under 9, books imported together are indexed one at a time in no particular order.
- Roadmap: move "Import a whole directory of books in one go" to Done.
- Project tree: `BooksView.tsx <- import (file or folder), book list, remove`.

## Verification
1. `cargo test -p ebook_research_core`, `cargo clippy --workspace --all-targets`, `npx tsc --noEmit`, `npm test`.
2. `npm run dev:mock`: import the folder, check the progress line, the summary and the failures list, and that leaving and returning to Books mid-import shows it still going.
3. `npm run tauri dev`: import `~/Documents/books` and check the window repaints between books (the `spawn_blocking` change), that Stop ends after the current book, that switching to the reader mid-import doesn't stop it, and that books already in the library are counted rather than duplicated.
