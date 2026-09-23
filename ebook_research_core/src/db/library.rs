//! The reader's read queries: books, their chapters and a chapter's text.

use anyhow::Result;
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
}

pub fn list_books(conn: &Connection) -> Result<Vec<BookSummary>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.title, b.author, COUNT(ch.id),
                (SELECT COUNT(*) FROM bookmarks bm WHERE bm.book_id = b.id)
         FROM books b
         LEFT JOIN chapters ch ON ch.book_id = b.id
         GROUP BY b.id
         ORDER BY b.added_at DESC, b.id DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(BookSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            chapter_count: row.get(3)?,
            bookmark_count: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[derive(Serialize, Debug)]
pub struct ChapterSummary {
    pub id: i64,
    pub idx: i64,
    pub title: Option<String>,
}

pub fn get_book_chapters(conn: &Connection, book_id: i64) -> Result<Vec<ChapterSummary>> {
    let mut stmt =
        conn.prepare("SELECT id, idx, title FROM chapters WHERE book_id = ?1 ORDER BY idx")?;
    let rows = stmt.query_map(params![book_id], |row| {
        Ok(ChapterSummary {
            id: row.get(0)?,
            idx: row.get(1)?,
            title: row.get(2)?,
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
