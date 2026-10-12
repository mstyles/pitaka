//! The library's books, their chapters and a chapter's text.

use super::semantic_index::{models_json, IndexState, INDEX_STATE_SQL};
use crate::semantic::COMPATIBLE_MODELS;
use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Serialize, Debug)]
pub struct BookSummary {
    pub id: i64,
    pub title: Option<String>,
    pub author: Option<String>,
    pub chapter_count: i64,
    /// Bookmarks of the book's paragraphs, across all folders.
    pub bookmark_count: i64,
    pub highlight_count: i64,
    /// Notes on highlights and on whole paragraphs.
    pub note_count: i64,
    /// How far the book is indexed for chapter search.
    pub index_state: IndexState,
}

pub fn list_books(conn: &Connection) -> Result<Vec<BookSummary>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT b.id, b.title, b.author, COUNT(ch.id),
                (SELECT COUNT(*) FROM bookmarks bm WHERE bm.book_id = b.id),
                (SELECT COUNT(*) FROM highlights h WHERE h.book_id = b.id),
                (SELECT COUNT(*) FROM notes n WHERE n.book_id = b.id),
                {INDEX_STATE_SQL}
         FROM books b
         LEFT JOIN chapters ch ON ch.book_id = b.id
         GROUP BY b.id
         ORDER BY b.added_at DESC, b.id DESC"
    ))?;
    let rows = stmt.query_map([models_json(COMPATIBLE_MODELS)], |row| {
        Ok(BookSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            chapter_count: row.get(3)?,
            bookmark_count: row.get(4)?,
            highlight_count: row.get(5)?,
            note_count: row.get(6)?,
            index_state: IndexState::from_sql(&row.get::<_, String>(7)?)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Longest title or author accepted, after cleaning. A guard against
/// pasting a paragraph by mistake, not a real limit on titles.
const MAX_FIELD_CHARS: usize = 500;

/// Corrects a book's title and author. Each is trimmed with runs of
/// whitespace collapsed, and an empty one is stored as `NULL`. Only the
/// library changes; the book's file is never touched.
pub fn update_book_details(
    conn: &Connection,
    book_id: i64,
    title: &str,
    author: &str,
) -> Result<()> {
    let title = clean_field(title);
    let author = clean_field(author);
    for (name, value) in [("title", &title), ("author", &author)] {
        if value
            .as_ref()
            .is_some_and(|v| v.chars().count() > MAX_FIELD_CHARS)
        {
            bail!("{name} is too long ({MAX_FIELD_CHARS} characters at most)");
        }
    }
    // A plain UPDATE: INSERT OR REPLACE would delete the row first and
    // cascade away the book's chapters and annotations.
    let updated = conn.execute(
        "UPDATE books SET title = ?1, author = ?2 WHERE id = ?3",
        params![title, author, book_id],
    )?;
    if updated == 0 {
        bail!("no book with id {book_id}");
    }
    Ok(())
}

/// Trims, collapses runs of whitespace (newlines pasted from a PDF
/// included) to one space, and turns an empty field into `None`.
fn clean_field(value: &str) -> Option<String> {
    let cleaned = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!cleaned.is_empty()).then_some(cleaned)
}

#[derive(Serialize, Debug)]
pub struct ChapterSummary {
    pub id: i64,
    pub idx: i64,
    pub title: Option<String>,
    /// Characters in the chapter's paragraphs, for the reader's progress.
    pub char_count: i64,
}

pub fn get_book_chapters(conn: &Connection, book_id: i64) -> Result<Vec<ChapterSummary>> {
    let mut stmt = conn.prepare(
        "SELECT ch.id, ch.idx, ch.title, COALESCE(SUM(LENGTH(cb.text)), 0)
         FROM chapters ch
         LEFT JOIN content_blocks cb ON cb.chapter_id = ch.id
         WHERE ch.book_id = ?1
         GROUP BY ch.id
         ORDER BY ch.idx",
    )?;
    let rows = stmt.query_map(params![book_id], |row| {
        Ok(ChapterSummary {
            id: row.get(0)?,
            idx: row.get(1)?,
            title: row.get(2)?,
            char_count: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[derive(Serialize, Debug)]
pub struct ContentBlockRow {
    pub id: i64,
    pub block_idx: i64,
    pub text: String,
}

#[derive(Serialize, Debug)]
pub struct ChapterContent {
    pub chapter_id: i64,
    pub chapter_idx: i64,
    pub chapter_title: Option<String>,
    pub book_id: i64,
    pub blocks: Vec<ContentBlockRow>,
}

pub fn get_chapter_content(conn: &Connection, chapter_id: i64) -> Result<ChapterContent> {
    let (book_id, chapter_idx, chapter_title) = conn.query_row(
        "SELECT book_id, idx, title FROM chapters WHERE id = ?1",
        params![chapter_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;

    let mut stmt = conn.prepare(
        "SELECT id, block_idx, text FROM content_blocks WHERE chapter_id = ?1 ORDER BY block_idx",
    )?;
    let blocks = stmt
        .query_map(params![chapter_id], |row| {
            Ok(ContentBlockRow {
                id: row.get(0)?,
                block_idx: row.get(1)?,
                text: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    Ok(ChapterContent {
        chapter_id,
        chapter_idx,
        chapter_title,
        book_id,
        blocks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::import::load_book;
    use crate::db::test_util::*;
    use crate::db::*;

    fn book(conn: &Connection, id: i64) -> BookSummary {
        list_books(conn)
            .unwrap()
            .into_iter()
            .find(|b| b.id == id)
            .unwrap()
    }

    #[test]
    fn update_book_details_changes_title_and_author() {
        let mut conn = open_db(":memory:").unwrap();
        let mut parsed = one_chapter_book("Old", &["zebra alpha", "zebra beta"]);
        parsed.author = Some("X".to_string());
        let id = load_book(&mut conn, "/a.epub", "ha", &parsed).unwrap();
        conn.execute(
            "INSERT INTO highlights (book_id, content_block_id, start_offset, end_offset)
             SELECT book_id, id, 0, 5 FROM content_blocks WHERE book_id = ?1 LIMIT 1",
            [id],
        )
        .unwrap();

        update_book_details(&conn, id, "  The   New\nTitle ", "Hanh, Thich Nhat").unwrap();

        let b = book(&conn, id);
        assert_eq!(b.title.as_deref(), Some("The New Title"));
        assert_eq!(b.author.as_deref(), Some("Hanh, Thich Nhat"));
        assert_eq!(b.chapter_count, 1);
        assert_eq!(b.highlight_count, 1);
        let hits = search(&conn, "zebra", SearchMode::Stemmed, None, 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits
            .iter()
            .all(|h| h.book_title.as_deref() == Some("The New Title")));
    }

    #[test]
    fn empty_fields_clear_title_and_author() {
        let mut conn = open_db(":memory:").unwrap();
        let mut parsed = one_chapter_book("Old", &["zebra"]);
        parsed.author = Some("X".to_string());
        let id = load_book(&mut conn, "/a.epub", "ha", &parsed).unwrap();

        update_book_details(&conn, id, "", "   ").unwrap();

        let b = book(&conn, id);
        assert_eq!(b.title, None);
        assert_eq!(b.author, None);
    }

    #[test]
    fn update_book_details_rejects_unknown_and_overlong() {
        let mut conn = open_db(":memory:").unwrap();
        let parsed = one_chapter_book("Old", &["zebra"]);
        let id = load_book(&mut conn, "/a.epub", "ha", &parsed).unwrap();

        let err = update_book_details(&conn, id + 1, "T", "A").unwrap_err();
        assert!(err.to_string().contains("no book with id"), "{err}");

        let err = update_book_details(&conn, id, &"t".repeat(501), "A").unwrap_err();
        assert!(err.to_string().contains("too long"), "{err}");
        assert_eq!(book(&conn, id).title.as_deref(), Some("Old"));

        let err = update_book_details(&conn, id, "T", &"a".repeat(501)).unwrap_err();
        assert!(err.to_string().contains("author is too long"), "{err}");

        update_book_details(&conn, id, &"t".repeat(500), "").unwrap();
        assert_eq!(book(&conn, id).title.map(|t| t.len()), Some(500));
    }

    #[test]
    fn chapter_char_count_sums_paragraphs() {
        let mut conn = open_db(":memory:").unwrap();
        let parsed = book_with_chapters("A", &[&["ab", "cde"], &[]]);
        let id = load_book(&mut conn, "/a.epub", "ha", &parsed).unwrap();
        let counts: Vec<i64> = get_book_chapters(&conn, id)
            .unwrap()
            .iter()
            .map(|c| c.char_count)
            .collect();
        assert_eq!(counts, vec![5, 0]);

        let parsed = book_with_chapters("B", &[&["ā"]]);
        let id = load_book(&mut conn, "/b.epub", "hb", &parsed).unwrap();
        assert_eq!(get_book_chapters(&conn, id).unwrap()[0].char_count, 1);
    }
}
