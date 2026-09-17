use crate::epub::{parse_epub, ParsedBook};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
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
        return Ok(ImportOutcome { book_id, already_imported: true });
    }

    let path_taken: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM books WHERE file_path = ?1)",
        params![epub_path],
        |row| row.get(0),
    )?;
    if path_taken {
        bail!(
            "{epub_path} is already in the library, but the file has changed since it was \
             imported. Re-importing a changed file isn't supported yet."
        );
    }

    let parsed = parse_epub(epub_path)?;
    let book_id = load_book(conn, epub_path, &hash, &parsed)?;
    Ok(ImportOutcome { book_id, already_imported: false })
}

/// Inserts a parsed book, its chapters, and its paragraphs in one
/// transaction, so a failure part-way leaves nothing behind. Returns the new
/// book_id.
fn load_book(conn: &mut Connection, epub_path: &str, hash: &str, parsed: &ParsedBook) -> Result<i64> {
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

/// Turns a user's search box text into a valid FTS5 query. Every word is
/// wrapped in double quotes, so punctuation (`don't`, `self-aware`, `a.b`)
/// is left to the tokenizer instead of being parsed as FTS5 syntax. Kept:
/// "quoted phrases", a trailing `*` for prefix search, and uppercase
/// AND/OR/NOT between two terms. Anything else FTS5 would treat as syntax
/// (parentheses, `NEAR`, `column:`) is searched as text.
/// Returns `None` if there's nothing to search for.
fn to_fts_query(query: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut last_is_term = false;
    let mut chars = query.chars().peekable();

    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }

        let (text, is_phrase) = if c == '"' && query_has_closing_quote(&chars) {
            chars.next();
            let phrase: String = chars.by_ref().take_while(|&c| c != '"').collect();
            (phrase, true)
        } else {
            let mut word = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() || (c == '"' && query_has_closing_quote(&chars)) {
                    break;
                }
                word.push(c);
                chars.next();
            }
            (word, false)
        };

        if !is_phrase && matches!(text.as_str(), "AND" | "OR" | "NOT") && last_is_term {
            parts.push(text);
            last_is_term = false;
            continue;
        }

        // A phrase takes a prefix `*` straight after its closing quote.
        let prefix = if is_phrase {
            chars.next_if_eq(&'*').is_some()
        } else {
            text.ends_with('*')
        };
        let term = if is_phrase { &text[..] } else { text.trim_end_matches('*') };
        if term.trim().is_empty() {
            continue;
        }

        parts.push(format!(
            "\"{}\"{}",
            term.replace('"', "\"\""),
            if prefix { "*" } else { "" }
        ));
        last_is_term = true;
    }

    if !last_is_term {
        parts.pop(); // a trailing operator, e.g. "neural OR"
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

/// Whether a `"` at the front of `chars` has a matching closing quote.
fn query_has_closing_quote(chars: &std::iter::Peekable<std::str::Chars>) -> bool {
    chars.clone().skip(1).any(|c| c == '"')
}

/// Searches the whole library. `query` is what the user typed; see
/// `to_fts_query` for how it's interpreted.
pub fn search(
    conn: &Connection,
    query: &str,
    mode: SearchMode,
    limit: i64,
) -> Result<Vec<SearchResult>> {
    let Some(fts_query) = to_fts_query(query) else {
        return Ok(Vec::new());
    };
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

    let rows = stmt.query_map(params![fts_query, limit], |row| {
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

    Ok(rows.collect::<rusqlite::Result<_>>()?)
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

    fn fts(q: &str) -> Option<String> {
        to_fts_query(q)
    }

    #[test]
    fn fts_query_quotes_each_word() {
        assert_eq!(fts("neural networks").unwrap(), r#""neural" "networks""#);
        assert_eq!(fts("don't").unwrap(), r#""don't""#);
        assert_eq!(fts("self-aware a.b").unwrap(), r#""self-aware" "a.b""#);
        assert_eq!(fts("(foo) bar:baz NEAR").unwrap(), r#""(foo)" "bar:baz" "NEAR""#);
    }

    #[test]
    fn fts_query_keeps_phrases_and_prefixes() {
        assert_eq!(fts(r#""neural networks""#).unwrap(), r#""neural networks""#);
        assert_eq!(fts(r#"say"hi there""#).unwrap(), r#""say" "hi there""#);
        assert_eq!(fts("learn*").unwrap(), r#""learn"*"#);
        assert_eq!(fts(r#""deep learn"*"#).unwrap(), r#""deep learn"*"#);
    }

    #[test]
    fn fts_query_escapes_unbalanced_quotes() {
        assert_eq!(fts(r#"don"t"#).unwrap(), r#""don""t""#);
        assert_eq!(fts(r#"a "b" c""#).unwrap(), r#""a" "b" "c""""#);
    }

    #[test]
    fn fts_query_keeps_operators_only_between_terms() {
        assert_eq!(fts("a OR b").unwrap(), r#""a" OR "b""#);
        assert_eq!(fts("a NOT b AND c").unwrap(), r#""a" NOT "b" AND "c""#);
        assert_eq!(fts("OR a").unwrap(), r#""OR" "a""#);
        assert_eq!(fts("a OR").unwrap(), r#""a""#);
        assert_eq!(fts("a OR AND b").unwrap(), r#""a" OR "AND" "b""#);
        assert_eq!(fts("a or b").unwrap(), r#""a" "or" "b""#);
        assert_eq!(fts(r#"a "OR" b"#).unwrap(), r#""a" "OR" "b""#);
    }

    #[test]
    fn fts_query_empty_input() {
        assert_eq!(fts(""), None);
        assert_eq!(fts("   "), None);
        assert_eq!(fts(r#""""#), None);
        assert_eq!(fts("*"), None);
        assert_eq!(fts("AND"), Some(r#""AND""#.into()));
    }
}
