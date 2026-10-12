//! Book covers: the thumbnail stored for each book (migration 007), and
//! adding covers to books imported before Pitaka read them.

use super::import::file_hash;
use crate::cover::{cover_key, thumbnail};
use crate::epub::read_epub_cover;
use crate::pdf::read_pdf_cover;
use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::sync::Mutex;

/// Stores a book's cover: a thumbnail of `source` under the book's
/// format (`"epub"` or `"pdf"`), or `'none'` when there's no cover or it
/// can't be decoded.
pub(super) fn save_cover(
    conn: &Connection,
    book_id: i64,
    format: &str,
    source: Option<&[u8]>,
) -> Result<()> {
    // A thumbnail error is dropped on purpose: a broken cover image
    // shouldn't cost the book, which then gets a generated cover.
    let thumb = source.and_then(|bytes| thumbnail(bytes).ok());
    let (source, key) = match &thumb {
        Some(thumb) => (format, Some(cover_key(thumb))),
        None => ("none", None),
    };
    write_row(conn, book_id, source, thumb.as_deref(), key.as_deref())
}

/// Replacing is safe here, unlike on `books`: nothing references
/// `book_covers`, so there's nothing for the delete to cascade to.
fn write_row(
    conn: &Connection,
    book_id: i64,
    source: &str,
    thumb: Option<&[u8]>,
    key: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO book_covers (book_id, source, thumb, key)
         VALUES (?1, ?2, ?3, ?4)",
        params![book_id, source, thumb, key],
    )?;
    Ok(())
}

/// A book's cover thumbnail, a JPEG; `None` when it has none, or there's
/// no such book.
pub fn book_cover(conn: &Connection, book_id: i64) -> Result<Option<Vec<u8>>> {
    Ok(conn
        .query_row(
            "SELECT thumb FROM book_covers WHERE book_id = ?1",
            params![book_id],
            |row| row.get::<_, Option<Vec<u8>>>(0),
        )
        .optional()?
        .flatten())
}

/// What `backfill_covers` did.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct CoverBackfill {
    /// Books that had no cover row and were looked at.
    pub checked: i64,
    /// Of those, the books a cover was found for.
    pub found: i64,
}

/// Looks for the cover of every book that has no `book_covers` row: those
/// imported before migration 007, or restored from an older backup. A
/// book whose file is missing, or has changed since it was imported, is
/// recorded as `'unavailable'` and isn't looked at again.
///
/// The connection is locked only for each query and write, never while a
/// file is read, so a large PDF doesn't hold up the app.
pub fn backfill_covers(conn: &Mutex<Connection>) -> Result<CoverBackfill> {
    let lock = || conn.lock().map_err(|_| anyhow!("the library is locked"));
    let books: Vec<(i64, String, String, String)> = {
        let conn = lock()?;
        let mut stmt = conn.prepare(
            "SELECT b.id, b.file_path, b.file_hash, b.format
             FROM books b LEFT JOIN book_covers c ON c.book_id = b.id
             WHERE c.book_id IS NULL
             ORDER BY b.id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    let mut report = CoverBackfill {
        checked: 0,
        found: 0,
    };
    for (book_id, path, hash, format) in books {
        let unchanged = file_hash(&path).is_ok_and(|h| h == hash);
        let cover = if !unchanged {
            None
        } else if format == "pdf" {
            read_pdf_cover(&path).ok().flatten()
        } else {
            read_epub_cover(&path).ok().flatten()
        };

        let conn = lock()?;
        let saved = if unchanged {
            save_cover(&conn, book_id, &format, cover.as_deref())
        } else {
            write_row(&conn, book_id, "unavailable", None, None)
        };
        match saved {
            Ok(()) => {}
            // The book was removed while its file was read: the insert
            // fails its foreign key.
            Err(e) if is_foreign_key_error(&e) => continue,
            Err(e) => return Err(e),
        }
        report.checked += 1;
        let has_thumb: bool = conn.query_row(
            "SELECT thumb IS NOT NULL FROM book_covers WHERE book_id = ?1",
            params![book_id],
            |row| row.get(0),
        )?;
        if has_thumb {
            report.found += 1;
        }
    }
    Ok(report)
}

fn is_foreign_key_error(e: &anyhow::Error) -> bool {
    matches!(
        e.downcast_ref::<rusqlite::Error>(),
        Some(rusqlite::Error::SqliteFailure(err, _))
            if err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cover::test_jpeg;
    use crate::db::import::{load_book, load_book_before_covers};
    use crate::db::test_util::*;
    use crate::db::*;

    fn source_of(conn: &Connection, book_id: i64) -> Option<String> {
        conn.query_row(
            "SELECT source FROM book_covers WHERE book_id = ?1",
            [book_id],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    fn cover_in_list(conn: &Connection, book_id: i64) -> Option<String> {
        list_books(conn)
            .unwrap()
            .into_iter()
            .find(|b| b.id == book_id)
            .unwrap()
            .cover
    }

    fn with_cover(title: &str, cover: Option<Vec<u8>>) -> crate::epub::ParsedBook {
        let mut book = one_chapter_book(title, &["text"]);
        book.cover = cover;
        book
    }

    #[test]
    fn import_saves_a_cover_row_for_every_book() {
        let mut conn = open_db(":memory:").unwrap();
        let a = load_book(
            &mut conn,
            "/a.epub",
            "ha",
            &with_cover("A", Some(test_jpeg(600, 900))),
        )
        .unwrap();
        let b = load_book(&mut conn, "/b.epub", "hb", &with_cover("B", None)).unwrap();
        let c = load_book(
            &mut conn,
            "/c.epub",
            "hc",
            &with_cover("C", Some(b"not an image".to_vec())),
        )
        .unwrap();

        assert_eq!(source_of(&conn, a).as_deref(), Some("epub"));
        let key = cover_in_list(&conn, a).expect("a cover key");
        assert_eq!(key.len(), 12);
        for id in [b, c] {
            assert_eq!(source_of(&conn, id).as_deref(), Some("none"));
            assert_eq!(cover_in_list(&conn, id), None);
        }
    }

    #[test]
    fn book_cover_returns_the_thumbnail() {
        let mut conn = open_db(":memory:").unwrap();
        let id = load_book(
            &mut conn,
            "/a.epub",
            "ha",
            &with_cover("A", Some(test_jpeg(600, 900))),
        )
        .unwrap();
        let thumb = book_cover(&conn, id).unwrap().expect("a thumbnail");
        assert_eq!(&thumb[..3], &[0xff, 0xd8, 0xff]);
        assert_eq!(book_cover(&conn, id + 1).unwrap(), None);
    }

    #[test]
    fn covers_go_with_the_book() {
        let mut conn = open_db(":memory:").unwrap();
        let id = load_book(
            &mut conn,
            "/a.epub",
            "ha",
            &with_cover("A", Some(test_jpeg(600, 900))),
        )
        .unwrap();
        delete_book(&conn, id).unwrap();
        assert_eq!(source_of(&conn, id), None);
    }

    /// A folder of its own under the temp dir, removed when dropped.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(test: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("pitaka-test-{test}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// An EPUB whose OPF marks `cover.jpg` as its cover.
    fn write_epub_with_cover(path: &str) {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        let files: [(&str, &[u8]); 4] = [
            (
                "META-INF/container.xml",
                br#"<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
            ),
            (
                "content.opf",
                br#"<package><metadata><dc:title>Covered</dc:title></metadata><manifest>
                    <item id="c" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>
                    <item id="ch" href="ch.xhtml" media-type="application/xhtml+xml"/>
                </manifest><spine><itemref idref="ch"/></spine></package>"#,
            ),
            ("ch.xhtml", b"<html><body><p>Text.</p></body></html>"),
            ("cover.jpg", &test_jpeg(600, 900)),
        ];
        for (name, data) in files {
            zip.start_file(name, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn backfill_fills_only_missing_rows() {
        let dir = Scratch::new("backfill-covers");
        let a_path = dir.path("a.epub");
        write_epub_with_cover(&a_path);
        let c_path = dir.path("c.epub");
        write_epub_with_cover(&c_path);
        let a_hash = file_hash(&a_path).unwrap();

        let mut conn = open_db(":memory:").unwrap();
        let book = one_chapter_book("Book", &["text"]);
        let a = load_book_before_covers(&mut conn, &a_path, &a_hash, &book).unwrap();
        let b = load_book_before_covers(&mut conn, &dir.path("gone.epub"), "hb", &book).unwrap();
        let c = load_book_before_covers(&mut conn, &c_path, "not its hash", &book).unwrap();
        let conn = Mutex::new(conn);

        assert_eq!(
            backfill_covers(&conn).unwrap(),
            CoverBackfill {
                checked: 3,
                found: 1
            }
        );
        let conn = conn.into_inner().unwrap();
        assert_eq!(source_of(&conn, a).as_deref(), Some("epub"));
        assert_eq!(source_of(&conn, b).as_deref(), Some("unavailable"));
        assert_eq!(source_of(&conn, c).as_deref(), Some("unavailable"));
        assert!(cover_in_list(&conn, a).is_some());
        assert_eq!(cover_in_list(&conn, c), None);

        let conn = Mutex::new(conn);
        assert_eq!(
            backfill_covers(&conn).unwrap(),
            CoverBackfill {
                checked: 0,
                found: 0
            }
        );
    }

    #[test]
    fn migration_007_adds_an_empty_table() {
        let dir = Scratch::new("migration-007");
        let path = dir.path("library.db");
        {
            let mut old = Connection::open(&path).unwrap();
            old.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
            super::super::migrations().to_version(&mut old, 6).unwrap();
            let book = one_chapter_book("Old", &["text"]);
            load_book_before_covers(&mut old, "/a.epub", "ha", &book).unwrap();
            load_book_before_covers(&mut old, "/b.epub", "hb", &book).unwrap();
        }

        let conn = open_db(&path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 7);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM book_covers", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
        let books = list_books(&conn).unwrap();
        assert_eq!(books.len(), 2);
        assert!(books.iter().all(|b| b.cover.is_none()));
    }
}
