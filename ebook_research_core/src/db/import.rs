//! Importing books from EPUB files and removing them from the library.

use crate::epub::{parse_epub, ParsedBook};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

fn file_hash(path: &str) -> Result<String> {
    let bytes = std::fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
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

    #[test]
    fn delete_unknown_book_is_an_error() {
        let conn = open_db(":memory:").unwrap();
        let err = delete_book(&conn, 42).expect_err("deleting a missing book should fail");
        assert!(err.to_string().contains("no book with id 42"), "{err}");
    }
}
