# Back up and restore the library

## Context
Everything a reader builds up in Pitaka (imported books, bookmark folders and their passages, highlights, notes, edited titles and authors, the chapter-search index) lives in one SQLite file, `library.db` in the app data folder. Nothing in the app copies it, so moving to a new computer or reinstalling means either finding that file by hand or starting over: re-importing every book and losing every note. This adds **Back up…** and **Restore…** to the Books screen. A backup is a single `.pitaka` file: a zip holding a `manifest.json` and the compressed library. Restoring it on any install gives back the library exactly as it was.

It's a whole-library snapshot, not an export of the notes alone. The reader only uses `library.db`, which holds every paragraph's text. Book files are read once at import and are only used after that to de-duplicate re-imports (`import_book` matches on `file_hash`). So a restored library works without copying the EPUBs and PDFs, and nothing has to be matched up again. The library holds the books' text and indexes: a snapshot of the current 54-book library is 31 MB, and 16 MB once deflated. The manifest lets restore refuse a backup from a newer Pitaka before extracting anything. It also lets the confirmation dialog say what the backup holds and when it was made.

This addresses the roadmap item "Export bookmarks, notes and highlights" for its main purpose, keeping your studies safe. A readable export (Markdown of a book's highlights and notes) stays on the roadmap as its own item.

Out of scope:
- Merging a backup into an existing library. A restore replaces the whole library, and the previous library is saved first (§1).
- Scheduled or automatic backups, cloud sync, and encrypted backups. The zip crate's AES support could add encryption later.
- Backing up the downloaded embedding model. It lives in the Hugging Face cache, not `library.db`, and is downloaded again on first use.
- The browser demo. It has no filesystem, so both buttons report that backups need the desktop app, as Import does.

Ruled out:
- A JSON file of just the folders, bookmarks, highlights and notes, keyed by `file_hash` and paragraph position. The user has to re-import every book before restoring, a parser fix between versions can renumber paragraphs and leave notes unmatched, and it means writing an importer for every table. The user chose the whole-library backup.
- Gzip or zstd around the bare database file. That would mean a new crate, or a stream with nowhere to put the manifest. `zip` is already a dependency of the core crate (`epub.rs` reads EPUBs with it, and a test writes one with `ZipWriter`), and 8.6's default features include deflate.
- Deflate level 6. In Python, level 1 compressed the 31 MB snapshot to 16 MB in 0.8 s, and level 6 to 15 MB in 2.0 s. Unzipping took 0.3 s.
- Copying `library.db` with `std::fs::copy`. That can catch a write half-done, and it copies free pages. `VACUUM INTO` writes a consistent, compacted snapshot through SQLite.
- Restoring by renaming the backup over `library.db` and reopening it. The semantic index worker opens its own connection to `db_path` (`commands.rs` `index`), and an open connection would keep the old, unlinked file. SQLite's backup API writes the pages into the live file through its own locking, so every connection sees the restored library.

Checked with Python's SQLite 3.46.1 against a copy of the real library (54 books, `user_version` 6):
- `VACUUM INTO` writes a 31 MB file that keeps `user_version` 6. `integrity_check` returns `ok`, the FTS5 `integrity-check` passes on both `content_fts` and `content_fts_exact`, and `content_fts MATCH 'mind'` returns the same 8,093 rows as the original.
- `VACUUM INTO` onto an existing file fails with "output file already exists", so the core writes to a temporary file and renames it (§1).
- Loading a backup into a `:memory:` connection with the backup API, then copying from memory into a live file whose library had 3 books deleted, restores all 54 books. A second connection that was already open on the live file sees all 54 straight away, and both FTS integrity checks pass afterwards.
- With an uncommitted write open on the in-memory connection, the copy into the live file waited forever. So validation commits, or runs outside any transaction, before the copy, and the copy gives up after a time limit instead of retrying forever (§1).
- A file that isn't SQLite fails to open with "file is not a database".
- Deflate (Python `zipfile`) compressed the snapshot to 16 MB at level 1 and 15 MB at level 6 (see Ruled out).
- `rusqlite_migration` 2.6 returns `MigrationDefinitionError::DatabaseTooFarAhead` when `user_version` is above the latest migration, which is how a backup from a newer Pitaka is recognised.

## 1. Core: `ebook_research_core/src/db/backup.rs` (new), `db/mod.rs`, `lib.rs`, `index_queue.rs`, `Cargo.toml`
- `ebook_research_core/Cargo.toml`, two changes that need your OK:
  - rusqlite gains the `backup` feature (`features = ["bundled", "functions", "backup"]`). It's a feature of a crate we already depend on, with no new code from outside. `src-tauri` doesn't call the API, so its rusqlite line stays as it is.
  - `serde_json` stops being optional: drop `optional = true` and the `dep:serde_json` entry in `semantic`, and the now-redundant `[dev-dependencies]` line. The manifest needs it. It's already compiled into the app through `src-tauri`, so the build doesn't grow.
- `db/mod.rs`: move the body of `open_db` after `Connection::open` into `fn prepare(conn: &mut Connection) -> Result<()>`, which turns on foreign keys, runs `baseline_unversioned_db` and calls `migrations().to_latest`. `open_db` calls it, and so does the restore on its in-memory copy, so an older backup gets the same upgrade as an older `library.db`. Add `pub(crate) fn schema_version() -> i64`, the number of entries in `migrations()` (6 today), for the manifest and the newer-backup check.
- Types, all `#[derive(Serialize, Deserialize, Debug, PartialEq)]`:
  - `pub struct LibraryCounts { books, bookmark_folders, bookmarks, highlights, notes: i64 }`, read by `pub fn library_counts(conn) -> Result<LibraryCounts>` in one `SELECT (SELECT COUNT(*) FROM books), …` over the five tables. The status lines in §4 use it.
  - `pub struct BackupManifest { format: i64, app_version: String, schema_version: i64, created_at: String, counts: LibraryCounts }`. `format` is 1, so a later change to the file's layout can be refused cleanly. `app_version` is passed in by the caller (§2), because the release steps bump `src-tauri/Cargo.toml` and `package.json` but not the core crate. `schema_version` is the library's `user_version` at backup time. `created_at` comes from SQLite's `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`, so no date crate is needed.
- File layout: a zip with two entries. `manifest.json` (pretty-printed, stored) goes first, so it's read without touching the large entry. `library.db` is deflated at level 1 (`SimpleFileOptions::default().compression_method(Deflated).compression_level(Some(1))`, with `.large_file(true)` when the snapshot is 4 GiB or more). The extension stays `.pitaka`.
- `pub fn backup_library(conn: &Connection, dest: &str, app_version: &str) -> Result<BackupManifest>`:
  - If `dest` is the live database (`conn.path()`, after canonicalising both paths), fail with `bail!("choose a different file from the library itself")`.
  - Run `VACUUM INTO` to `<dest>.snapshot` (any stale one is removed first). Then write the zip to `<dest>.partial`, streaming the snapshot into the `library.db` entry with `std::io::copy`. Finish the zip, `sync_all`, rename it onto `dest`, and remove the snapshot. That replaces a file the user already agreed to overwrite in the save dialog, and a failed backup never leaves a half-written `dest`. On any error both temporary files are removed (a small guard struct that deletes its path on `Drop` unless disarmed), and the error carries the context ``"couldn't write {dest}"``.
  - Return the manifest.
- `pub fn read_backup_manifest(src: &str) -> Result<BackupManifest>`: open the zip and parse `manifest.json`. A file that isn't a zip, has no manifest, or whose manifest doesn't parse fails with `"{file name} isn't a Pitaka backup"`. A `format` above 1 or a `schema_version` above `schema_version()` fails with `"this backup is from a newer version of Pitaka ({app_version}); update the app, then restore it"`. Nothing is extracted.
- `pub fn restore_library(conn: &mut Connection, src: &str, app_version: &str) -> Result<LibraryCounts>`:
  1. `read_backup_manifest(src)`, which gives the same errors as above.
  2. Extract the `library.db` entry to a temporary file: `library-restore.db` next to the live database when `conn.path()` is a real file, otherwise `std::env::temp_dir()/pitaka-restore-<pid>.db`. The same `Drop` guard removes it however the restore ends. A missing `library.db` entry is "isn't a Pitaka backup". A failed or corrupt deflate stream (zip's CRC check) is `"{file name} is damaged and can't be restored"`.
  3. Load it into `let mut staging = Connection::open_in_memory()?` with `staging.restore(MAIN_DB, &extracted, None::<fn(Progress)>)`. The backup file itself is only read, so restoring never changes it. `SQLITE_NOTADB` and a missing `books` table (the same `sqlite_master` query as `baseline_unversioned_db`) are "isn't a Pitaka backup".
  4. Run `prepare(&mut staging)`. `DatabaseTooFarAhead` should already have been caught by the manifest check. If it still happens, because a manifest was edited by hand, it gets the same "newer version" message, found by downcasting the `rusqlite_migration::Error`.
  5. Check the copy: `PRAGMA integrity_check` must return `ok`, and `INSERT INTO content_fts(content_fts) VALUES('integrity-check')` must pass, and the same for `content_fts_exact`. Any failure is "is damaged and can't be restored". None of this runs inside a transaction (see Context).
  6. If `conn.path()` is a real file, write the current library to `library-before-restore.pitaka` in the same folder, using `backup_library`. That needs an app version, so `restore_library` takes `app_version: &str` as well. Only the latest one is kept. This is the undo, and the confirmation dialog names it.
  7. Copy the staging library into the live one with `Backup::new(&staging, conn)?`, stepping 1024 pages at a time. Busy or locked steps are retried every 50 ms until `BUSY_TIMEOUT` (30 s) has passed, then it fails with `"the library is busy; try again in a moment"`. That's why this doesn't use `run_to_completion`, which retries forever.
  8. Return `library_counts(conn)`.
- Re-export `backup_library`, `read_backup_manifest`, `restore_library`, `library_counts`, `BackupManifest` and `LibraryCounts` from `db/mod.rs` and `lib.rs`.
- `ebook_research_core/src/index_queue.rs`: add `pub fn is_busy(&self) -> bool`, true while a book is `current` or `waiting`. A run that has been stopped stays busy until the worker calls `finish`, so a chapter that is half-embedded can't write its vectors into a restored library, where the same chapter id may belong to another book.
- No migration.

## 2. Tauri commands: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- `app_version` is `app.package_info().version.to_string()`, the version in `src-tauri/Cargo.toml`, which the release steps bump.
- `backup_library(path: String, app: AppHandle, state) -> Result<BackupManifest, String>`: lock `state.conn`, call `db::backup_library`, map the error with `format!("{e:#}")`. Doc comment: ``/// Frontend calls: `invoke("backup_library", { path })`. Writes the whole library to one compressed file.``
- `read_backup_manifest(path: String) -> Result<BackupManifest, String>`: no lock is needed. The frontend calls it to fill in the confirmation dialog, and an unreadable or newer backup fails here, before anything is asked.
- `restore_library(path: String, app: AppHandle, state) -> Result<LibraryCounts, String>`: with the `semantic` feature, first fail with `"Stop indexing before restoring a backup"` if `state.index_queue.is_busy()`. Then lock `state.conn` mutably and call `db::restore_library`. Doc comment: the call, plus that it replaces the whole library after saving the old one as `library-before-restore.pitaka`.
- Add all three to `generate_handler!` after `update_book_details`. `dialog:default` already allows `save` and `open`, so the capabilities stay as they are.

## 3. Types and mock backend: `src/types.ts`, `src/test/mockBackend.ts`, `ui_fixtures.rs`, `src/demo/installDemo.ts`
- `types.ts`: `export type LibraryCounts = { books: number; bookmark_folders: number; bookmarks: number; highlights: number; notes: number }` and `export type BackupManifest = { format: number; app_version: string; schema_version: number; created_at: string; counts: LibraryCounts }`.
- `ui_fixtures.rs`: `ui_fixtures_are_current` writes a `backup_manifest` entry. It comes from `db::read_backup_manifest` on a backup of the fixture library made with app version `"0.0.0-fixture"`, with `created_at` replaced by a fixed `"2026-01-01T00:00:00Z"` so the file doesn't change on every run. Regenerate it with `UPDATE_UI_FIXTURES=1`.
- `mockBackend.ts`:
  - New options `savePath?: string | null` (default `"/backups/pitaka-backup.pitaka"`, `null` = cancelled) and `backupError?: string`.
  - `case "plugin:dialog|save"` returns `savePath`.
  - `case "backup_library"` throws `backupError` if it's set, and otherwise returns `fixtures.backup_manifest` with its counts worked out from the current mock state.
  - `case "read_backup_manifest"` throws `backupError` if it's set, and otherwise returns `fixtures.backup_manifest`.
  - `case "restore_library"` throws `backupError` if it's set, and otherwise resets `books`, folders, bookmarks, highlights and notes to the starting fixture data, as if restoring a backup of it, and returns `fixtures.backup_manifest.counts`.
  - All three go through the existing `fail` option.
- `installDemo.ts`: `backupError: "Backups need the desktop app. This demo keeps your highlights and notes until you close the page."`

## 4. Books screen: `src/BooksView.tsx`, `src/App.tsx`
- Two buttons in the import row, after **Import folder…**: **Back up…** and **Restore…**. Both are disabled while `importing`. **Restore…** is also disabled while `anyQueued`, with `title="Stop indexing to restore a backup"`.
- Back up: `save({ defaultPath: \`pitaka-backup-${yyyy-mm-dd}.pitaka\`, filters: [{ name: "Pitaka backup", extensions: ["pitaka"] }] })`. `null` cancels without a message. Then `importStatus` shows "Backing up…", and after that `Backed up 54 books, 3 bookmark folders, 12 highlights and 4 notes to /path/pitaka-backup-2026-10-12.pitaka` (from the returned manifest's counts), or `Backup failed: ${err}`. A `countsLine(c: LibraryCounts)` helper builds the list with `plural`, leaving out zero counts other than books.
- Restore: `open({ multiple: false, filters: [same] })`, then `read_backup_manifest`. A failure there shows `Restore failed: ${err}` and asks nothing. Otherwise: `ask("${fileName} was backed up on ${date} by Pitaka ${app_version} and holds ${countsLine(m.counts)}. Restoring replaces every book, bookmark folder, highlight and note in Pitaka with these. Your current library is saved first as library-before-restore.pitaka in Pitaka's data folder.", { title: "Restore backup?", kind: "warning", okLabel: "Restore", cancelLabel: "Cancel" })`. `${date}` is `created_at` shown with `toLocaleDateString(undefined, { dateStyle: "medium" })`. If confirmed, show "Restoring…", call `restore_library`, then show `Restored ${countsLine(c)}`, call `onLibraryReplaced()` and `refreshBooks()`. A failure shows `Restore failed: ${err}`, and the library is unchanged.
- `App.tsx`: pass `onLibraryReplaced`, which clears `openFolderId`, `openAnnotationsBookId` and `searchBookId`, calls `dismissFinished()` and bumps `libraryVersion`. Book and folder ids from before the restore mean nothing afterwards. The reader can't be open while the Books screen shows.
- No CSS changes: the buttons use the existing `.row` button styles.

## 5. Tests
- `db/backup.rs` `#[cfg(test)]`. Each test uses file-backed databases under `std::env::temp_dir()/pitaka-test-<test name>-<pid>`, removed at the end, and builds books with `test_util`.
  - `backup_then_restore_round_trips`: library A has a book, a folder with a bookmark, a highlight with a note, a paragraph note and an edited title. Back it up, then change A: remove the book, rename the folder, load another book. Restore. `library_counts` equals the counts before the backup, `list_books` shows the edited title, `list_book_annotations` and `list_folder_bookmarks` match what they returned before, `search(.., Stemmed, ..)` finds the book's word, and both FTS integrity checks pass. No `library-restore.db` is left next to A.
  - `backup_is_a_compressed_zip_with_a_manifest`: the backup opens with `zip::ZipArchive`, its entries are `manifest.json` then `library.db`, and `library.db` is `Deflated` with a compressed size below its uncompressed size. `read_backup_manifest` returns format 1, the `app_version` passed in, `schema_version` 6 and counts equal to `library_counts`, and `created_at` parses as `YYYY-MM-DDTHH:MM:SSZ`.
  - `restore_is_seen_by_another_connection`: open a second `open_db` on A before restoring. Afterwards it reads the restored `list_books`.
  - `backup_replaces_an_existing_file`: backing up twice to the same path succeeds, and no `.partial` or `.snapshot` file is left. Backing up to A's own path fails with "different file".
  - `restore_saves_the_previous_library`: after a restore, `library-before-restore.pitaka` next to A has a manifest with A's counts from before the restore.
  - `restore_rejects_bad_files`: each of these fails, A's `library_counts` is unchanged, and no `library-before-restore.pitaka` or `library-restore.db` is written:
    - a text file, a zip with no `manifest.json`, and a zip with a manifest but no `library.db` fail with "isn't a Pitaka backup";
    - a manifest with `schema_version` 99, and one with `format` 2, fail with "newer version" from `read_backup_manifest` as well as `restore_library`;
    - a backup whose `library.db` entry has one byte flipped (rewritten with `ZipWriter` and stored, so the CRC no longer matches) fails with "damaged".
  - `restore_upgrades_an_older_backup`: build a library with `migrations().to_version(5)`, give it a book and a highlight, and package it with a manifest saying `schema_version` 5. Restore it: `user_version` is 6 and the highlight is listed.
- `index_queue.rs`: `is_busy` is false when empty, true after `push`, true after `stop` until `finish`, then false.
- `tests/integration.rs` `restore_moves_a_library_to_a_new_install`: import `test.epub`, highlight a paragraph of the chapter found by title, note it, and back up with app version `"9.9.9"`. Open a fresh `open_db` on another temp file (the new install) and restore. `list_book_annotations` is the same, a search finds the chapter, and importing `test.epub` again returns `already_imported` with the same `book_id`.
- `src/Backup.test.tsx`:
  - Back up with `savePath: null` makes no `backup_library` call. With a path it calls `backup_library` with `{ path }` and shows "Backed up 3 books, … to /backups/pitaka-backup.pitaka".
  - Restore calls `read_backup_manifest`, and the `ask` message names the fixture's date ("1 Jan 2026" in the test's en-GB locale), "Pitaka 0.0.0-fixture" and its counts. Declining (`confirm: false`) makes no `restore_library` call. Confirming calls it, shows "Restored …" and lists the fixture books again after one was removed beforehand.
  - `fail: { read_backup_manifest: "this backup is from a newer version of Pitaka (0.9.0); …" }` shows `Restore failed: …`, never asks, and makes no `restore_library` call.
  - After restoring, Bookmarks & notes shows the folder list rather than a folder that was open before.
  - Restore is disabled while a book is queued for indexing (the `semantic` mock option).
- `src/Demo.test.tsx`: **Back up…** shows the demo's "Backups need the desktop app" message.

## 6. README
- Feature list: a bullet, "**Back up your library** to one file and restore it on another computer: books, folders, highlights and notes come back as they were, without the book files."
- "How it's built": a `db/backup.rs` entry and `IndexQueue::is_busy`. The entry covers the file layout (a zip with `manifest.json` and a deflated `library.db`), `VACUUM INTO` on the way out, and the way in: manifest check, extract, in-memory copy that is migrated and checked first, then the backup API. Plus the `library-before-restore.pitaka` undo.
- "What's actually verified": the core and integration tests above, `Backup.test.tsx`, the Python checks from Context, and whatever was walked in `npm run tauri dev`.
- Known limitations: limitation 5's "neither notes nor highlights are searchable or exportable" becomes "…searchable, or exportable except inside a whole-library backup". A new limitation: restoring replaces the library rather than merging. A backup holds the books' full text, unencrypted, so treat it as private. A restore briefly needs free space for the extracted library next to `library.db`.
- Roadmap: add and tick "Back up the library to one file and restore it". Reword the open item to "Export a book's highlights and notes as readable Markdown".
- Per the site-copy memory, no change to `site/` until the release that ships it.

## Verification
1. `cargo test -p ebook_research_core`, `cargo clippy --workspace --all-targets`, `npx tsc --noEmit`, `npm test`, `npm run format:check`.
2. `npm run dev:mock`: back up, remove a book, restore, then check the status lines, the confirmation dialog's date, version and counts, and that cancelling either dialog does nothing.
3. `npm run tauri dev` with `--features semantic`, on a copy of the real library: back up, add a highlight, restore (the highlight is gone and `library-before-restore.pitaka` has it), then restore a backup into a fresh install (`XDG_DATA_HOME` pointed at an empty folder) and open a book, search, and open a note. Note the backup's size and how long the backup and the restore take on the real library.
