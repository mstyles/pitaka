use crate::epub::ParsedBook;
use anyhow::Result;
use rusqlite::{params, Connection};
use rusqlite_migration::{Migrations, M};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Schema migrations, applied in order. The DB's `PRAGMA user_version` records
/// how many have run. Never edit one that has shipped — add a new file.
fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(include_str!("../migrations/001_initial.sql")),
        M::up(include_str!("../migrations/002_search_indexes.sql")),
    ])
}

pub fn open_db(db_path: &str) -> Result<Connection> {
    let mut conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    baseline_unversioned_db(&conn)?;
    migrations().to_latest(&mut conn)?;
    Ok(conn)
}

/// Libraries created before migrations were tracked already have the 001
/// schema but `user_version = 0`; mark them as version 1 so 001 isn't re-run.
fn baseline_unversioned_db(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let has_books: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'books')",
        [],
        |row| row.get(0),
    )?;
    if version == 0 && has_books {
        conn.pragma_update(None, "user_version", 1)?;
    }
    Ok(())
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
            params![book_id, chapter_idx as i64, chapter.title],
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
    pub book_id: i64,
    pub book_title: Option<String>,
    pub chapter_id: i64,
    pub chapter_idx: i64,
    pub block_idx: i64,
    pub content_block_id: i64,
    pub snippet: String,
    pub rank: f64,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    /// Porter-stemmed: "learning" also matches "learn" and "learns".
    Stemmed,
    /// Whole words as typed. Case and diacritics are still ignored.
    Exact,
}

impl SearchMode {
    fn fts_table(self) -> &'static str {
        match self {
            SearchMode::Stemmed => "content_fts",
            SearchMode::Exact => "content_fts_exact",
        }
    }
}

/// Runs an FTS5 query across the whole library. `query` uses SQLite FTS5
/// query syntax (supports phrases in quotes, AND/OR/NOT, prefix* etc).
pub fn search(
    conn: &Connection,
    query: &str,
    mode: SearchMode,
    limit: i64,
) -> Result<Vec<SearchResult>> {
    // The table name comes from the enum, never from user input.
    let fts = mode.fts_table();
    let mut stmt = conn.prepare(&format!(
        "SELECT b.id, b.title, ch.id, ch.idx, cb.block_idx, cb.id,
                snippet({fts}, 0, '[', ']', '...', 12) AS snip,
                bm25({fts}) AS rank
         FROM {fts}
         JOIN content_blocks cb ON cb.id = {fts}.rowid
         JOIN chapters ch       ON ch.id = cb.chapter_id
         JOIN books b           ON b.id = cb.book_id
         WHERE {fts} MATCH ?1
         ORDER BY rank
         LIMIT ?2"
    ))?;

    let rows = stmt.query_map(params![query, limit], |row| {
        Ok(SearchResult {
            book_id: row.get(0)?,
            book_title: row.get(1)?,
            chapter_id: row.get(2)?,
            chapter_idx: row.get(3)?,
            block_idx: row.get(4)?,
            content_block_id: row.get(5)?,
            snippet: row.get(6)?,
            rank: row.get(7)?,
        })
    })?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Serialize, Debug)]
pub struct BookSummary {
    pub id: i64,
    pub title: Option<String>,
    pub author: Option<String>,
    pub chapter_count: i64,
}

pub fn list_books(conn: &Connection) -> Result<Vec<BookSummary>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.title, b.author, COUNT(ch.id)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_valid() {
        migrations().validate().unwrap();
    }
}
