//! Importing books from EPUB files and removing them from the library.

use crate::epub::{parse_epub, ParsedBook};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use walkdir::{DirEntry, WalkDir};

fn file_hash(path: &str) -> Result<String> {
    let bytes = std::fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct ImportOutcome {
    pub book_id: i64,
    /// True if a book with identical file contents was already in the
    /// library (from any path), in which case nothing was imported.
    pub already_imported: bool,
}

/// Imports an EPUB unless a book with the same file contents is already in
/// the library. The file is hashed before it's parsed, so duplicates are
/// cheap to skip.
pub fn import_book(conn: &mut Connection, epub_path: &str) -> Result<ImportOutcome> {
    let hash = file_hash(epub_path)?;

    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM books WHERE file_hash = ?1 ORDER BY id LIMIT 1",
            params![hash],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(book_id) = existing {
        return Ok(ImportOutcome {
            book_id,
            already_imported: true,
        });
    }

    let path_taken: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM books WHERE file_path = ?1)",
        params![epub_path],
        |row| row.get(0),
    )?;
    if path_taken {
        bail!(
            "{epub_path} is already in the library, but the file has changed since it was \
             imported. Remove the book from the library, then import it again."
        );
    }

    let parsed = parse_epub(epub_path)?;
    let book_id = load_book(conn, epub_path, &hash, &parsed)?;
    Ok(ImportOutcome {
        book_id,
        already_imported: false,
    })
}

/// What `find_epubs` found under a folder.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct EpubScan {
    /// The EPUB files, in walk order: sorted by name within each folder,
    /// depth first.
    pub paths: Vec<String>,
    /// Entries that couldn't be read (a folder without permission, a broken
    /// link), skipped so one bad entry doesn't sink the whole scan.
    pub unreadable: Vec<String>,
}

/// Finds every `.epub` file under `dir`, recursively, for importing a whole
/// folder one book at a time. Linked folders are followed; hidden files and
/// folders (`.Trash-1000`, macOS `._Book.epub` files) are skipped, and a book
/// reachable by two paths is returned once.
pub fn find_epubs(dir: &str) -> Result<EpubScan> {
    match std::fs::metadata(dir) {
        Err(e) => bail!("couldn't read {dir}: {e}"),
        Ok(meta) if !meta.is_dir() => bail!("{dir} isn't a folder"),
        Ok(_) => {}
    }

    let mut scan = EpubScan {
        paths: Vec::new(),
        unreadable: Vec::new(),
    };
    let mut seen = HashSet::new();
    let walk = WalkDir::new(dir)
        .follow_links(true)
        .sort_by_file_name()
        .into_iter()
        // Depth 0 is the picked folder itself, which may be hidden.
        .filter_entry(|e| e.depth() == 0 || !is_hidden(e));
    for entry in walk {
        let entry = match entry {
            Ok(entry) => entry,
            // Expected when following links; the folder is walked already.
            Err(err) if err.loop_ancestor().is_some() => continue,
            Err(err) => {
                if let Some(path) = err.path() {
                    scan.unreadable.push(path.to_string_lossy().into_owned());
                }
                continue;
            }
        };
        let is_epub = entry
            .path()
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("epub"));
        if !entry.file_type().is_file() || !is_epub {
            continue;
        }
        // A folder linked into the tree twice yields the same books twice.
        let real = std::fs::canonicalize(entry.path()).unwrap_or_else(|_| entry.path().into());
        if seen.insert(real) {
            scan.paths.push(entry.path().to_string_lossy().into_owned());
        }
    }
    Ok(scan)
}

fn is_hidden(entry: &DirEntry) -> bool {
    entry.file_name().to_string_lossy().starts_with('.')
}

/// Inserts a parsed book, its chapters, and its paragraphs in one
/// transaction, so a failure part-way leaves nothing behind. Returns the new
/// book_id.
pub(super) fn load_book(
    conn: &mut Connection,
    epub_path: &str,
    hash: &str,
    parsed: &ParsedBook,
) -> Result<i64> {
    let tx = conn.transaction()?;

    tx.execute(
        "INSERT INTO books (file_path, file_hash, title, author, format, last_indexed_at)
         VALUES (?1, ?2, ?3, ?4, 'epub', datetime('now'))",
        params![epub_path, hash, parsed.title, parsed.author],
    )?;
    let book_id = tx.last_insert_rowid();

    for (chapter_idx, chapter) in parsed.chapters.iter().enumerate() {
        tx.execute(
            "INSERT INTO chapters (book_id, idx, title) VALUES (?1, ?2, ?3)",
            params![book_id, chapter_idx as i64, chapter.title],
        )?;
        let chapter_id = tx.last_insert_rowid();

        for (block_idx, (start, end, text)) in chapter.paragraphs.iter().enumerate() {
            tx.execute(
                "INSERT INTO content_blocks
                 (book_id, chapter_id, block_idx, char_start, char_end, text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    book_id,
                    chapter_id,
                    block_idx as i64,
                    *start as i64,
                    *end as i64,
                    text
                ],
            )?;
        }
    }

    tx.commit()?;
    Ok(book_id)
}

/// Removes a book and everything that belongs to it from the library. The
/// EPUB file on disk is left alone. Chapters, content blocks and annotations
/// go with it via `ON DELETE CASCADE`, and the `content_blocks_ad` trigger
/// drops its text from both search indexes, so this relies on the
/// `foreign_keys` pragma that `open_db` turns on.
pub fn delete_book(conn: &Connection, book_id: i64) -> Result<()> {
    let deleted = conn.execute("DELETE FROM books WHERE id = ?1", params![book_id])?;
    if deleted == 0 {
        bail!("no book with id {book_id}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_util::*;
    use crate::db::*;

    #[test]
    fn file_hash_is_lowercase_hex_sha256() {
        // Stored hashes detect re-imports, so the format must not drift.
        let path = std::env::temp_dir().join(format!("pitaka-hash-{}", std::process::id()));
        std::fs::write(&path, "abc").unwrap();
        let hash = file_hash(path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            hash,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn delete_book_leaves_other_books_alone() {
        let mut conn = open_db(":memory:").unwrap();
        let a = one_chapter_book("A", &["zebra alpha", "zebra beta"]);
        let b = one_chapter_book("B", &["zebra gamma"]);
        let gone = load_book(&mut conn, "/a.epub", "ha", &a).unwrap();
        let kept = load_book(&mut conn, "/b.epub", "hb", &b).unwrap();
        conn.execute(
            "INSERT INTO highlights (book_id, content_block_id, start_offset, end_offset)
             SELECT book_id, id, 0, 5 FROM content_blocks WHERE book_id = ?1 LIMIT 1",
            [gone],
        )
        .unwrap();

        delete_book(&conn, gone).unwrap();

        let ids: Vec<i64> = list_books(&conn).unwrap().iter().map(|b| b.id).collect();
        assert_eq!(ids, vec![kept]);
        for table in ["chapters", "content_blocks", "highlights"] {
            let sql = format!("SELECT COUNT(*) FROM {table} WHERE book_id = ?1");
            let orphans: i64 = conn.query_row(&sql, [gone], |r| r.get(0)).unwrap();
            assert_eq!(orphans, 0, "{table} rows should go with the book");
        }
        assert_eq!(get_book_chapters(&conn, kept).unwrap().len(), 1);
        for mode in [SearchMode::Stemmed, SearchMode::Exact] {
            let hits = search(&conn, "zebra", mode, 10).unwrap();
            assert_eq!(hits.len(), 1, "{mode:?}");
            assert_eq!(hits[0].book_id, kept, "{mode:?}");
        }
        for fts in ["content_fts", "content_fts_exact"] {
            let sql = format!("INSERT INTO {fts}({fts}, rank) VALUES ('integrity-check', 1)");
            conn.execute(&sql, [])
                .unwrap_or_else(|e| panic!("{fts} integrity check failed: {e}"));
        }
    }

    /// A fresh folder under the system temp dir, removed when dropped.
    #[cfg(unix)]
    struct TempDir(std::path::PathBuf);

    #[cfg(unix)]
    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("pitaka-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }

        fn add(&self, file: &str) {
            let path = self.0.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"").unwrap();
        }

        fn str(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }

    #[cfg(unix)]
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The scan's paths relative to `root`, for comparing exact lists.
    #[cfg(unix)]
    fn relative(paths: &[String], root: &TempDir) -> Vec<String> {
        let prefix = format!("{}/", root.str());
        paths
            .iter()
            .map(|p| p.strip_prefix(&prefix).unwrap_or(p).to_string())
            .collect()
    }

    /// A path as `find_epubs` prints it: `root` as given, then each level
    /// below it joined with the OS separator, which is `\` on Windows.
    fn walked(root: &str, parts: &[&str]) -> String {
        let mut path = std::path::PathBuf::from(root);
        path.extend(parts);
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn find_epubs_walks_subfolders() {
        let scan = find_epubs("tests/fixtures/epub-dir").unwrap();
        assert_eq!(
            scan,
            EpubScan {
                // Bytewise order puts `Nested` before `a`.
                paths: vec![
                    walked("tests/fixtures/epub-dir", &["Nested", "b.EPUB"]),
                    walked("tests/fixtures/epub-dir", &["a.epub"]),
                ],
                unreadable: vec![],
            }
        );
    }

    #[test]
    fn find_epubs_walks_a_hidden_root() {
        let scan = find_epubs("tests/fixtures/epub-dir/.hidden").unwrap();
        assert_eq!(
            scan.paths,
            vec![walked("tests/fixtures/epub-dir/.hidden", &["c.epub"])]
        );
    }

    #[cfg(unix)]
    #[test]
    fn find_epubs_follows_linked_folders() {
        use std::os::unix::fs::symlink;
        let root = TempDir::new("scan-links");
        let elsewhere = TempDir::new("scan-links-target");
        root.add("a.epub");
        root.add("other/c.epub");
        elsewhere.add("d.epub");
        symlink(&elsewhere.0, root.0.join("linked")).unwrap();
        std::fs::create_dir(root.0.join("sub")).unwrap();
        symlink("..", root.0.join("sub/loop")).unwrap();
        symlink("../other", root.0.join("sub/again")).unwrap();

        let scan = find_epubs(root.str()).unwrap();
        assert_eq!(
            relative(&scan.paths, &root),
            ["a.epub", "linked/d.epub", "other/c.epub"]
        );
        assert!(scan.unreadable.is_empty(), "{:?}", scan.unreadable);
    }

    #[cfg(unix)]
    #[test]
    fn find_epubs_reports_unreadable_paths() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = TempDir::new("scan-unreadable");
        root.add("a.epub");
        root.add("locked/b.epub");
        let locked = root.0.join("locked");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        symlink("nowhere", root.0.join("gone.epub")).unwrap();
        // Root reads a mode 000 folder anyway, so there's nothing to check.
        let as_root = std::fs::read_dir(&locked).is_ok();

        let scan = find_epubs(root.str());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        if as_root {
            return;
        }
        let scan = scan.unwrap();
        assert_eq!(relative(&scan.paths, &root), ["a.epub"]);
        assert_eq!(relative(&scan.unreadable, &root), ["gone.epub", "locked"]);
    }

    #[test]
    fn find_epubs_needs_a_readable_folder() {
        let err = find_epubs("tests/fixtures/no-such-dir").unwrap_err();
        assert!(err.to_string().contains("couldn't read"), "{err}");
        let err = find_epubs("tests/fixtures/epub-dir/a.epub").unwrap_err();
        assert!(err.to_string().contains("isn't a folder"), "{err}");
    }

    #[test]
    fn delete_unknown_book_is_an_error() {
        let conn = open_db(":memory:").unwrap();
        let err = delete_book(&conn, 42).expect_err("deleting a missing book should fail");
        assert!(err.to_string().contains("no book with id 42"), "{err}");
    }
}
