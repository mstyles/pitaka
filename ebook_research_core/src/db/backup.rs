//! Backing the whole library up to one `.pitaka` file and restoring it.
//! The file is a zip of a `manifest.json`, saying what it holds and which
//! Pitaka wrote it, and a deflated snapshot of `library.db`.

use super::{prepare, schema_version, BUSY_TIMEOUT};
use anyhow::{anyhow, bail, Context, Result};
use rusqlite::backup::{Backup, Progress, StepResult};
use rusqlite::{Connection, ErrorCode, MAIN_DB};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// The layout of the backup file. A backup with a higher one is refused.
const FORMAT: i64 = 1;
const MANIFEST_ENTRY: &str = "manifest.json";
const LIBRARY_ENTRY: &str = "library.db";
/// Where a restore extracts the backup's library, next to `library.db`.
const RESTORE_FILE: &str = "library-restore.db";
/// The library as it was before the latest restore, next to `library.db`.
pub const BEFORE_RESTORE_FILE: &str = "library-before-restore.pitaka";
/// Pages copied into the live library per step of a restore.
const PAGES_PER_STEP: i32 = 1024;

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct LibraryCounts {
    pub books: i64,
    pub bookmark_folders: i64,
    pub bookmarks: i64,
    pub highlights: i64,
    pub notes: i64,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct BackupManifest {
    pub format: i64,
    /// The Pitaka that wrote the backup, from the app's own version.
    pub app_version: String,
    /// The library's `user_version` when it was backed up.
    pub schema_version: i64,
    /// UTC, as `YYYY-MM-DDTHH:MM:SSZ`.
    pub created_at: String,
    pub counts: LibraryCounts,
}

pub fn library_counts(conn: &Connection) -> Result<LibraryCounts> {
    Ok(conn.query_row(
        "SELECT (SELECT COUNT(*) FROM books), (SELECT COUNT(*) FROM bookmark_folders),
                (SELECT COUNT(*) FROM bookmarks), (SELECT COUNT(*) FROM highlights),
                (SELECT COUNT(*) FROM notes)",
        [],
        |row| {
            Ok(LibraryCounts {
                books: row.get(0)?,
                bookmark_folders: row.get(1)?,
                bookmarks: row.get(2)?,
                highlights: row.get(3)?,
                notes: row.get(4)?,
            })
        },
    )?)
}

/// A scratch file that is deleted when dropped, unless kept.
struct TempFile {
    path: PathBuf,
    keep: bool,
}

impl TempFile {
    /// Removes any file left at `path` by an earlier run.
    fn new(path: PathBuf) -> Self {
        let _ = fs::remove_file(&path);
        Self { path, keep: false }
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// The live library's file, or `None` for an in-memory one.
fn db_file(conn: &Connection) -> Option<PathBuf> {
    conn.path().filter(|p| !p.is_empty()).map(PathBuf::from)
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map_or_else(|| path.to_string(), |n| n.to_string_lossy().into_owned())
}

fn not_a_backup(name: &str) -> anyhow::Error {
    anyhow!("{name} isn't a Pitaka backup")
}

fn damaged(name: &str) -> anyhow::Error {
    anyhow!("{name} is damaged and can't be restored")
}

fn newer_version(app_version: &str) -> anyhow::Error {
    anyhow!(
        "this backup is from a newer version of Pitaka ({app_version}); update the app, then restore it"
    )
}

/// Writes the whole library to `dest`, replacing any file there. A failed
/// backup leaves `dest` as it was.
pub fn backup_library(conn: &Connection, dest: &str, app_version: &str) -> Result<BackupManifest> {
    if let Some(live) = db_file(conn) {
        let same = match (fs::canonicalize(dest), fs::canonicalize(&live)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        if same {
            bail!("choose a different file from the library itself");
        }
    }
    write_backup(conn, dest, app_version).with_context(|| format!("couldn't write {dest}"))
}

fn write_backup(conn: &Connection, dest: &str, app_version: &str) -> Result<BackupManifest> {
    // `VACUUM INTO` won't write over a file, so both go to scratch files
    // first, and the finished zip is renamed onto `dest`.
    let snapshot = TempFile::new(PathBuf::from(format!("{dest}.snapshot")));
    let mut partial = TempFile::new(PathBuf::from(format!("{dest}.partial")));
    conn.execute("VACUUM INTO ?1", [snapshot.path.to_string_lossy()])?;

    let manifest = BackupManifest {
        format: FORMAT,
        app_version: app_version.to_string(),
        schema_version: conn.query_row("PRAGMA user_version", [], |row| row.get(0))?,
        created_at: conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now')", [], |row| {
            row.get(0)
        })?,
        counts: library_counts(conn)?,
    };

    let mut zip = ZipWriter::new(File::create(&partial.path)?);
    // First and stored, so it's read without touching the large entry.
    zip.start_file(
        MANIFEST_ENTRY,
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )?;
    zip.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
    let size = fs::metadata(&snapshot.path)?.len();
    zip.start_file(
        LIBRARY_ENTRY,
        SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(1))
            .large_file(size >= 1 << 32),
    )?;
    io::copy(&mut File::open(&snapshot.path)?, &mut zip)?;
    zip.finish()?.sync_all()?;
    fs::rename(&partial.path, dest)?;
    partial.keep = true;
    Ok(manifest)
}

/// What a backup holds, without extracting it. Fails for a file that
/// isn't a backup, and for one from a newer Pitaka.
pub fn read_backup_manifest(src: &str) -> Result<BackupManifest> {
    let mut zip = open_backup(src)?;
    read_manifest(&mut zip, &file_name(src))
}

fn open_backup(src: &str) -> Result<ZipArchive<File>> {
    let file = File::open(src).with_context(|| format!("couldn't open {src}"))?;
    ZipArchive::new(file).map_err(|_| not_a_backup(&file_name(src)))
}

fn read_manifest(zip: &mut ZipArchive<File>, name: &str) -> Result<BackupManifest> {
    let mut json = String::new();
    zip.by_name(MANIFEST_ENTRY)
        .map_err(|_| not_a_backup(name))?
        .read_to_string(&mut json)
        .map_err(|_| not_a_backup(name))?;
    let manifest: BackupManifest = serde_json::from_str(&json).map_err(|_| not_a_backup(name))?;
    if manifest.format > FORMAT || manifest.schema_version > schema_version() {
        return Err(newer_version(&manifest.app_version));
    }
    Ok(manifest)
}

/// Replaces the whole library with the backup at `src`, after checking
/// the backup's copy and saving the current library as
/// [`BEFORE_RESTORE_FILE`] beside it. Every connection open on the
/// library sees the restored one. Returns what it now holds.
pub fn restore_library(
    conn: &mut Connection,
    src: &str,
    app_version: &str,
) -> Result<LibraryCounts> {
    let name = file_name(src);
    let mut zip = open_backup(src)?;
    let manifest = read_manifest(&mut zip, &name)?;

    let extracted = TempFile::new(match db_file(conn) {
        Some(live) => live.with_file_name(RESTORE_FILE),
        None => std::env::temp_dir().join(format!("pitaka-restore-{}.db", std::process::id())),
    });
    {
        let mut entry = zip
            .by_name(LIBRARY_ENTRY)
            .map_err(|_| not_a_backup(&name))?;
        let mut out = File::create(&extracted.path)
            .with_context(|| format!("couldn't create {}", extracted.path.display()))?;
        // A bad deflate stream or checksum is `InvalidData`; anything else
        // is about the disk, not the backup.
        if let Err(e) = io::copy(&mut entry, &mut out) {
            return Err(if e.kind() == io::ErrorKind::InvalidData {
                damaged(&name)
            } else {
                anyhow::Error::new(e).context(format!(
                    "couldn't extract the library to {}",
                    extracted.path.display()
                ))
            });
        }
    }

    // Checked and upgraded in memory, so nothing touches the live library
    // until the copy is known to be good. Nothing here may leave a
    // transaction open: the copy into the live file would wait on it.
    let mut staging = Connection::open_in_memory()?;
    staging
        .restore(MAIN_DB, &extracted.path, None::<fn(Progress)>)
        .map_err(|e| match e.sqlite_error_code() {
            Some(ErrorCode::NotADatabase) => not_a_backup(&name),
            _ => damaged(&name),
        })?;
    let has_books: bool = staging
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'books')",
            [],
            |row| row.get(0),
        )
        .map_err(|_| not_a_backup(&name))?;
    if !has_books {
        return Err(not_a_backup(&name));
    }
    if let Err(e) = prepare(&mut staging) {
        use rusqlite_migration::{Error, MigrationDefinitionError};
        // Only reached when the manifest was edited by hand.
        return Err(match e.downcast_ref::<Error>() {
            Some(Error::MigrationDefinition(MigrationDefinitionError::DatabaseTooFarAhead)) => {
                newer_version(&manifest.app_version)
            }
            _ => e.context(format!("couldn't upgrade {name}")),
        });
    }
    check_integrity(&staging).map_err(|_| damaged(&name))?;

    if let Some(live) = db_file(conn) {
        let before = live.with_file_name(BEFORE_RESTORE_FILE);
        backup_library(conn, &before.to_string_lossy(), app_version)
            .context("couldn't save the current library before restoring")?;
    }

    copy_into(&staging, conn)?;
    library_counts(conn)
}

fn check_integrity(conn: &Connection) -> Result<()> {
    let result: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if result != "ok" {
        bail!("integrity check failed: {result}");
    }
    for table in ["content_fts", "content_fts_exact"] {
        conn.execute(
            &format!("INSERT INTO {table}({table}) VALUES('integrity-check')"),
            [],
        )?;
    }
    Ok(())
}

/// Copies `src` over the live library with SQLite's backup API, through
/// its locking, giving up after [`BUSY_TIMEOUT`] of waiting rather than
/// retrying forever as `run_to_completion` does.
fn copy_into(src: &Connection, live: &mut Connection) -> Result<()> {
    let backup = Backup::new(src, live)?;
    let deadline = Instant::now() + BUSY_TIMEOUT;
    loop {
        match backup.step(PAGES_PER_STEP)? {
            StepResult::Done => return Ok(()),
            StepResult::Busy | StepResult::Locked => {
                if Instant::now() >= deadline {
                    bail!("the library is busy; try again in a moment");
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::import::load_book;
    use super::super::test_util::{block_ids, err_of, one_chapter_book};
    use super::super::*;
    use super::*;

    /// A folder of its own under the temp dir, removed when dropped.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(test: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("pitaka-test-{test}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A book with a folder holding one paragraph, a highlight with a note
    /// on another and a note on the first; returns the book's id.
    fn annotated_library(conn: &mut Connection, title: &str) -> i64 {
        let book = one_chapter_book(title, &["The zebra grazes.", "A second paragraph."]);
        let book_id = load_book(conn, &format!("/books/{title}.epub"), title, &book).unwrap();
        let blocks = block_ids(conn, book_id);
        let folder = create_bookmark_folder(conn, "Zebras").unwrap();
        add_bookmark(conn, folder.id, blocks[0]).unwrap();
        let highlight = add_highlight(conn, blocks[1], 0, 8, "yellow").unwrap();
        add_highlight_note(conn, highlight.id, "Why second?").unwrap();
        add_paragraph_note(conn, blocks[0], "About zebras.").unwrap();
        book_id
    }

    fn write_zip(path: &str, entries: &[(&str, &[u8])]) {
        let mut zip = ZipWriter::new(File::create(path).unwrap());
        for (name, data) in entries {
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            zip.start_file(*name, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    fn manifest_json(format: i64, schema_version: i64) -> Vec<u8> {
        serde_json::to_vec(&BackupManifest {
            format,
            app_version: "0.9.0".to_string(),
            schema_version,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            counts: LibraryCounts {
                books: 1,
                bookmark_folders: 0,
                bookmarks: 0,
                highlights: 0,
                notes: 0,
            },
        })
        .unwrap()
    }

    fn fts_ok(conn: &Connection) {
        check_integrity(conn).unwrap();
    }

    #[test]
    fn backup_then_restore_round_trips() {
        let dir = Scratch::new("round-trip");
        let mut conn = open_db(&dir.path("library.db")).unwrap();
        let book_id = annotated_library(&mut conn, "Old");
        crate::db::update_book_details(&conn, book_id, "Edited", "Author").unwrap();
        let folder_id = list_bookmark_folders(&conn).unwrap()[0].id;
        let counts = library_counts(&conn).unwrap();
        let annotations =
            serde_json::to_value(list_book_annotations(&conn, book_id).unwrap()).unwrap();
        let bookmarks =
            serde_json::to_value(list_folder_bookmarks(&conn, folder_id).unwrap()).unwrap();

        let backup = dir.path("backup.pitaka");
        backup_library(&conn, &backup, "1.0.0").unwrap();
        delete_book(&conn, book_id).unwrap();
        rename_bookmark_folder(&conn, folder_id, "Renamed").unwrap();
        let other = one_chapter_book("Other", &["Lions roar."]);
        load_book(&mut conn, "/books/other.epub", "other", &other).unwrap();

        assert_eq!(
            restore_library(&mut conn, &backup, "1.0.0").unwrap(),
            counts
        );
        assert_eq!(library_counts(&conn).unwrap(), counts);
        let books = list_books(&conn).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].title.as_deref(), Some("Edited"));
        assert_eq!(
            serde_json::to_value(list_book_annotations(&conn, book_id).unwrap()).unwrap(),
            annotations
        );
        assert_eq!(
            serde_json::to_value(list_folder_bookmarks(&conn, folder_id).unwrap()).unwrap(),
            bookmarks
        );
        assert_eq!(list_bookmark_folders(&conn).unwrap()[0].name, "Zebras");
        let hits = search(&conn, "zebra", SearchMode::Stemmed, None, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(search(&conn, "lions", SearchMode::Stemmed, None, 10)
            .unwrap()
            .is_empty());
        fts_ok(&conn);
        assert!(!Path::new(&dir.path(RESTORE_FILE)).exists());
    }

    #[test]
    fn backup_is_a_compressed_zip_with_a_manifest() {
        let dir = Scratch::new("zip-layout");
        let mut conn = open_db(&dir.path("library.db")).unwrap();
        annotated_library(&mut conn, "Zip");
        let backup = dir.path("backup.pitaka");
        let written = backup_library(&conn, &backup, "1.2.3").unwrap();

        let mut zip = ZipArchive::new(File::open(&backup).unwrap()).unwrap();
        assert_eq!(zip.len(), 2);
        assert_eq!(zip.by_index(0).unwrap().name(), MANIFEST_ENTRY);
        let library = zip.by_index(1).unwrap();
        assert_eq!(library.name(), LIBRARY_ENTRY);
        assert_eq!(library.compression(), CompressionMethod::Deflated);
        assert!(library.compressed_size() < library.size());
        drop(library);

        let manifest = read_backup_manifest(&backup).unwrap();
        assert_eq!(manifest, written);
        assert_eq!(manifest.format, 1);
        assert_eq!(manifest.app_version, "1.2.3");
        assert_eq!(manifest.schema_version, 6);
        assert_eq!(manifest.counts, library_counts(&conn).unwrap());
        let shape: String = manifest
            .created_at
            .chars()
            .map(|c| if c.is_ascii_digit() { '9' } else { c })
            .collect();
        assert_eq!(shape, "9999-99-99T99:99:99Z");
    }

    #[test]
    fn restore_is_seen_by_another_connection() {
        let dir = Scratch::new("other-connection");
        let path = dir.path("library.db");
        let mut conn = open_db(&path).unwrap();
        annotated_library(&mut conn, "Kept");
        let backup = dir.path("backup.pitaka");
        backup_library(&conn, &backup, "1.0.0").unwrap();
        let other = one_chapter_book("Added later", &["Lions roar."]);
        load_book(&mut conn, "/books/later.epub", "later", &other).unwrap();

        let second = open_db(&path).unwrap();
        assert_eq!(list_books(&second).unwrap().len(), 2);
        restore_library(&mut conn, &backup, "1.0.0").unwrap();
        let titles: Vec<_> = list_books(&second)
            .unwrap()
            .into_iter()
            .map(|b| b.title)
            .collect();
        assert_eq!(titles, vec![Some("Kept".to_string())]);
    }

    #[test]
    fn backup_replaces_an_existing_file() {
        let dir = Scratch::new("replace");
        let path = dir.path("library.db");
        let mut conn = open_db(&path).unwrap();
        annotated_library(&mut conn, "Twice");
        let backup = dir.path("backup.pitaka");
        backup_library(&conn, &backup, "1.0.0").unwrap();
        backup_library(&conn, &backup, "1.0.1").unwrap();
        assert_eq!(read_backup_manifest(&backup).unwrap().app_version, "1.0.1");
        assert!(!Path::new(&format!("{backup}.partial")).exists());
        assert!(!Path::new(&format!("{backup}.snapshot")).exists());

        let err = err_of(backup_library(&conn, &path, "1.0.0"));
        assert!(err.contains("different file"), "{err}");
    }

    #[test]
    fn restore_saves_the_previous_library() {
        let dir = Scratch::new("before-restore");
        let mut conn = open_db(&dir.path("library.db")).unwrap();
        let backup = dir.path("backup.pitaka");
        backup_library(&conn, &backup, "1.0.0").unwrap();
        annotated_library(&mut conn, "Current");
        let before = library_counts(&conn).unwrap();

        restore_library(&mut conn, &backup, "1.0.0").unwrap();
        assert_eq!(library_counts(&conn).unwrap().books, 0);
        let saved = read_backup_manifest(&dir.path(BEFORE_RESTORE_FILE)).unwrap();
        assert_eq!(saved.counts, before);
    }

    #[test]
    fn restore_rejects_bad_files() {
        let dir = Scratch::new("bad-files");
        let mut conn = open_db(&dir.path("library.db")).unwrap();
        annotated_library(&mut conn, "Safe");
        let counts = library_counts(&conn).unwrap();
        let good = dir.path("good.pitaka");
        backup_library(&conn, &good, "1.0.0").unwrap();
        let mut library = Vec::new();
        ZipArchive::new(File::open(&good).unwrap())
            .unwrap()
            .by_name(LIBRARY_ENTRY)
            .unwrap()
            .read_to_end(&mut library)
            .unwrap();

        let text = dir.path("notes.pitaka");
        fs::write(&text, "not a zip").unwrap();
        let no_manifest = dir.path("no-manifest.pitaka");
        write_zip(&no_manifest, &[(LIBRARY_ENTRY, &library)]);
        let no_library = dir.path("no-library.pitaka");
        write_zip(&no_library, &[(MANIFEST_ENTRY, &manifest_json(1, 6))]);
        let newer_schema = dir.path("newer-schema.pitaka");
        write_zip(
            &newer_schema,
            &[
                (MANIFEST_ENTRY, &manifest_json(1, 99)),
                (LIBRARY_ENTRY, &library),
            ],
        );
        let newer_format = dir.path("newer-format.pitaka");
        write_zip(
            &newer_format,
            &[
                (MANIFEST_ENTRY, &manifest_json(2, 6)),
                (LIBRARY_ENTRY, &library),
            ],
        );
        // Stored, so the library's bytes sit in the file as they are; one
        // flipped there no longer matches the entry's checksum.
        let corrupt = dir.path("corrupt.pitaka");
        write_zip(
            &corrupt,
            &[
                (MANIFEST_ENTRY, &manifest_json(1, 6)),
                (LIBRARY_ENTRY, &library),
            ],
        );
        let mut bytes = fs::read(&corrupt).unwrap();
        let header = bytes
            .windows(16)
            .position(|w| w == b"SQLite format 3\0")
            .unwrap();
        bytes[header + 2000] ^= 0xff;
        fs::write(&corrupt, bytes).unwrap();

        for (path, expected) in [
            (&text, "isn't a Pitaka backup"),
            (&no_manifest, "isn't a Pitaka backup"),
            (&no_library, "isn't a Pitaka backup"),
            (&newer_schema, "newer version"),
            (&newer_format, "newer version"),
            (&corrupt, "damaged"),
        ] {
            let err = err_of(restore_library(&mut conn, path, "1.0.0"));
            assert!(err.contains(expected), "{path}: {err}");
            assert_eq!(library_counts(&conn).unwrap(), counts);
        }
        for path in [&newer_schema, &newer_format] {
            let err = err_of(read_backup_manifest(path));
            assert!(err.contains("newer version of Pitaka (0.9.0)"), "{err}");
        }
        assert!(!Path::new(&dir.path(BEFORE_RESTORE_FILE)).exists());
        assert!(!Path::new(&dir.path(RESTORE_FILE)).exists());
    }

    #[test]
    fn restore_upgrades_an_older_backup() {
        let dir = Scratch::new("older-backup");
        let old_path = dir.path("old.db");
        let book_id = {
            let mut old = Connection::open(&old_path).unwrap();
            old.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
            migrations().to_version(&mut old, 5).unwrap();
            let book = one_chapter_book("Old schema", &["The zebra grazes."]);
            let book_id = load_book(&mut old, "/books/old.epub", "old", &book).unwrap();
            let block = block_ids(&old, book_id)[0];
            add_highlight(&old, block, 4, 9, "green").unwrap();
            book_id
        };
        let backup = dir.path("old.pitaka");
        write_zip(
            &backup,
            &[
                (MANIFEST_ENTRY, &manifest_json(1, 5)),
                (LIBRARY_ENTRY, &fs::read(&old_path).unwrap()),
            ],
        );

        let mut conn = open_db(&dir.path("library.db")).unwrap();
        restore_library(&mut conn, &backup, "1.0.0").unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 6);
        let annotations = list_book_annotations(&conn, book_id).unwrap();
        assert_eq!(annotations.len(), 1);
        assert_eq!(annotations[0].text, "zebra");
    }
}
