use crate::epub::ParsedBook;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;

pub const SCHEMA_SQL: &str = include_str!("../../schema.sql");

pub fn open_db(db_path: &str) -> Result<Connection> {
    let is_new = !Path::new(db_path).exists();
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    if is_new {
        conn.execute_batch(SCHEMA_SQL)?;
    }
    Ok(conn)
}

fn file_hash(path: &str) -> Result<String> {
    let bytes = std::fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

/// Inserts a parsed book, its chapters, and its paragraphs. Returns the new book_id.
pub fn load_book(conn: &Connection, epub_path: &str, parsed: &ParsedBook) -> Result<i64> {
    let hash = file_hash(epub_path)?;

    conn.execute(
        "INSERT INTO books (file_path, file_hash, title, author, format, last_indexed_at)
         VALUES (?1, ?2, ?3, ?4, 'epub', datetime('now'))",
        params![epub_path, hash, parsed.title, parsed.author],
    )?;
    let book_id = conn.last_insert_rowid();

    for (chapter_idx, chapter) in parsed.chapters.iter().enumerate() {
        conn.execute(
            "INSERT INTO chapters (book_id, idx, title) VALUES (?1, ?2, ?3)",
            params![book_id, chapter_idx as i64, chapter.file_name],
        )?;
        let chapter_id = conn.last_insert_rowid();

        for (block_idx, (start, end, text)) in chapter.paragraphs.iter().enumerate() {
            conn.execute(
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

    Ok(book_id)
}

#[derive(Serialize, Debug)]
pub struct SearchResult {
    pub book_title: Option<String>,
    pub chapter_idx: i64,
    pub block_idx: i64,
    pub content_block_id: i64,
    pub snippet: String,
    pub rank: f64,
}

/// Runs an FTS5 query across the whole library. `query` uses SQLite FTS5
/// query syntax (supports phrases in quotes, AND/OR/NOT, prefix* etc).
pub fn search(conn: &Connection, query: &str, limit: i64) -> Result<Vec<SearchResult>> {
    let mut stmt = conn.prepare(
        "SELECT b.title, ch.idx, cb.block_idx, cb.id,
                snippet(content_fts, 0, '[', ']', '...', 12) AS snip,
                bm25(content_fts) AS rank
         FROM content_fts
         JOIN content_blocks cb ON cb.id = content_fts.rowid
         JOIN chapters ch       ON ch.id = cb.chapter_id
         JOIN books b           ON b.id = cb.book_id
         WHERE content_fts MATCH ?1
         ORDER BY rank
         LIMIT ?2",
    )?;

    let rows = stmt.query_map(params![query, limit], |row| {
        Ok(SearchResult {
            book_title: row.get(0)?,
            chapter_idx: row.get(1)?,
            block_idx: row.get(2)?,
            content_block_id: row.get(3)?,
            snippet: row.get(4)?,
            rank: row.get(5)?,
        })
    })?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}
