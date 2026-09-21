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
        M::up(include_str!("../migrations/003_bookmark_folders.sql")),
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
fn load_book(
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
        let term = if is_phrase {
            &text[..]
        } else {
            text.trim_end_matches('*')
        };
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

#[derive(Serialize, Debug)]
pub struct BookmarkFolder {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub bookmark_count: i64,
}

/// A bookmarked paragraph as listed in its folder, with enough of its book
/// and chapter to show where it's from and to open it in the reader.
#[derive(Serialize, Debug)]
pub struct FolderBookmark {
    pub id: i64,
    pub folder_id: i64,
    pub content_block_id: i64,
    pub book_id: i64,
    pub book_title: Option<String>,
    pub chapter_id: i64,
    pub chapter_idx: i64,
    pub chapter_title: Option<String>,
    pub text: String,
}

/// One (paragraph, folder) pair, for marking bookmarked paragraphs in the
/// reader.
#[derive(Serialize, Debug)]
pub struct BlockBookmark {
    pub content_block_id: i64,
    pub folder_id: i64,
}

/// Trims a folder name and checks it's non-empty and not taken by another
/// folder. Names are compared ignoring (ASCII) case, via the column's
/// `COLLATE NOCASE`.
fn check_folder_name(conn: &Connection, name: &str, except_id: Option<i64>) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        bail!("folder name can't be empty");
    }
    let taken: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM bookmark_folders WHERE name = ?1 AND id IS NOT ?2)",
        params![name, except_id],
        |row| row.get(0),
    )?;
    if taken {
        bail!("a folder named \"{name}\" already exists");
    }
    Ok(name.to_string())
}

fn ensure_folder_exists(conn: &Connection, folder_id: i64) -> Result<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM bookmark_folders WHERE id = ?1)",
        params![folder_id],
        |row| row.get(0),
    )?;
    if !exists {
        bail!("no folder with id {folder_id}");
    }
    Ok(())
}

/// Creates an empty folder. The name is trimmed and must be unique,
/// ignoring case.
pub fn create_bookmark_folder(conn: &Connection, name: &str) -> Result<BookmarkFolder> {
    let name = check_folder_name(conn, name, None)?;
    conn.execute(
        "INSERT INTO bookmark_folders (name) VALUES (?1)",
        params![name],
    )?;
    let id = conn.last_insert_rowid();
    let created_at = conn.query_row(
        "SELECT created_at FROM bookmark_folders WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )?;
    Ok(BookmarkFolder {
        id,
        name,
        created_at,
        bookmark_count: 0,
    })
}

/// Renames a folder. Changing only the case of its own name is allowed.
pub fn rename_bookmark_folder(conn: &Connection, folder_id: i64, name: &str) -> Result<()> {
    let name = check_folder_name(conn, name, Some(folder_id))?;
    let updated = conn.execute(
        "UPDATE bookmark_folders SET name = ?1 WHERE id = ?2",
        params![name, folder_id],
    )?;
    if updated == 0 {
        bail!("no folder with id {folder_id}");
    }
    Ok(())
}

/// Deletes a folder and, via `ON DELETE CASCADE`, its bookmarks. The same
/// paragraphs stay bookmarked in any other folders.
pub fn delete_bookmark_folder(conn: &Connection, folder_id: i64) -> Result<()> {
    let deleted = conn.execute(
        "DELETE FROM bookmark_folders WHERE id = ?1",
        params![folder_id],
    )?;
    if deleted == 0 {
        bail!("no folder with id {folder_id}");
    }
    Ok(())
}

/// All folders, newest first, with how many passages each holds.
pub fn list_bookmark_folders(conn: &Connection) -> Result<Vec<BookmarkFolder>> {
    let mut stmt = conn.prepare(
        "SELECT f.id, f.name, f.created_at, COUNT(bm.id)
         FROM bookmark_folders f
         LEFT JOIN bookmarks bm ON bm.folder_id = f.id
         GROUP BY f.id
         ORDER BY f.created_at DESC, f.id DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(BookmarkFolder {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
            bookmark_count: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Bookmarks a paragraph into a folder and returns the bookmark's id. A
/// paragraph that's already in the folder returns its existing bookmark, so
/// a double click is harmless.
pub fn add_bookmark(conn: &Connection, folder_id: i64, content_block_id: i64) -> Result<i64> {
    ensure_folder_exists(conn, folder_id)?;
    let book_id: Option<i64> = conn
        .query_row(
            "SELECT book_id FROM content_blocks WHERE id = ?1",
            params![content_block_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(book_id) = book_id else {
        bail!("no paragraph with id {content_block_id}");
    };
    conn.execute(
        "INSERT OR IGNORE INTO bookmarks (folder_id, book_id, content_block_id)
         VALUES (?1, ?2, ?3)",
        params![folder_id, book_id, content_block_id],
    )?;
    Ok(conn.query_row(
        "SELECT id FROM bookmarks WHERE folder_id = ?1 AND content_block_id = ?2",
        params![folder_id, content_block_id],
        |row| row.get(0),
    )?)
}

/// Takes a paragraph out of one folder.
pub fn remove_bookmark(conn: &Connection, folder_id: i64, content_block_id: i64) -> Result<()> {
    let deleted = conn.execute(
        "DELETE FROM bookmarks WHERE folder_id = ?1 AND content_block_id = ?2",
        params![folder_id, content_block_id],
    )?;
    if deleted == 0 {
        bail!("that passage isn't in this folder");
    }
    Ok(())
}

/// A folder's passages in the order they were added. A missing folder is an
/// error, so it isn't mistaken for an empty one.
pub fn list_folder_bookmarks(conn: &Connection, folder_id: i64) -> Result<Vec<FolderBookmark>> {
    ensure_folder_exists(conn, folder_id)?;
    let mut stmt = conn.prepare(
        "SELECT bm.id, bm.folder_id, cb.id, b.id, b.title, ch.id, ch.idx, ch.title, cb.text
         FROM bookmarks bm
         JOIN content_blocks cb ON cb.id = bm.content_block_id
         JOIN chapters ch       ON ch.id = cb.chapter_id
         JOIN books b           ON b.id = cb.book_id
         WHERE bm.folder_id = ?1
         ORDER BY bm.id",
    )?;
    let rows = stmt.query_map(params![folder_id], |row| {
        Ok(FolderBookmark {
            id: row.get(0)?,
            folder_id: row.get(1)?,
            content_block_id: row.get(2)?,
            book_id: row.get(3)?,
            book_title: row.get(4)?,
            chapter_id: row.get(5)?,
            chapter_idx: row.get(6)?,
            chapter_title: row.get(7)?,
            text: row.get(8)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Every (paragraph, folder) bookmark in a chapter.
pub fn get_chapter_bookmarks(conn: &Connection, chapter_id: i64) -> Result<Vec<BlockBookmark>> {
    let mut stmt = conn.prepare(
        "SELECT bm.content_block_id, bm.folder_id
         FROM content_blocks cb
         JOIN bookmarks bm ON bm.content_block_id = cb.id
         WHERE cb.chapter_id = ?1
         ORDER BY cb.block_idx, bm.folder_id",
    )?;
    let rows = stmt.query_map(params![chapter_id], |row| {
        Ok(BlockBookmark {
            content_block_id: row.get(0)?,
            folder_id: row.get(1)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_valid() {
        migrations().validate().unwrap();
    }

    fn one_chapter_book(title: &str, paragraphs: &[&str]) -> ParsedBook {
        ParsedBook {
            title: Some(title.to_string()),
            author: None,
            chapters: vec![crate::epub::ParsedChapter {
                file_name: "ch1.xhtml".to_string(),
                title: "Chapter 1".to_string(),
                paragraphs: paragraphs
                    .iter()
                    .map(|p| (0, p.len(), p.to_string()))
                    .collect(),
            }],
        }
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

    #[test]
    fn delete_unknown_book_is_an_error() {
        let conn = open_db(":memory:").unwrap();
        let err = delete_book(&conn, 42).expect_err("deleting a missing book should fail");
        assert!(err.to_string().contains("no book with id 42"), "{err}");
    }

    /// The ids of a one-chapter book's paragraphs, in order.
    fn block_ids(conn: &Connection, book_id: i64) -> Vec<i64> {
        let chapter = &get_book_chapters(conn, book_id).unwrap()[0];
        get_chapter_content(conn, chapter.id)
            .unwrap()
            .blocks
            .iter()
            .map(|b| b.id)
            .collect()
    }

    fn err_of<T: std::fmt::Debug>(r: Result<T>) -> String {
        r.expect_err("expected an error").to_string()
    }

    #[test]
    fn migration_003_moves_old_bookmarks_into_a_folder() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        migrations().to_version(&mut conn, 2).unwrap();
        let book = load_book(
            &mut conn,
            "/a.epub",
            "ha",
            &one_chapter_book("A", &["kept"]),
        )
        .unwrap();
        let block = block_ids(&conn, book)[0];
        conn.execute(
            "INSERT INTO bookmarks (book_id, content_block_id) VALUES (?1, ?2)",
            params![book, block],
        )
        .unwrap();

        migrations().to_latest(&mut conn).unwrap();

        let folders = list_bookmark_folders(&conn).unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].name, "Bookmarks");
        assert_eq!(folders[0].bookmark_count, 1);
        let passages = list_folder_bookmarks(&conn, folders[0].id).unwrap();
        assert_eq!(passages.len(), 1);
        assert_eq!(passages[0].content_block_id, block);
        assert_eq!(passages[0].text, "kept");
    }

    #[test]
    fn migration_003_adds_no_folder_without_old_bookmarks() {
        let conn = open_db(":memory:").unwrap();
        assert!(list_bookmark_folders(&conn).unwrap().is_empty());
    }

    #[test]
    fn bookmark_folder_names() {
        let conn = open_db(":memory:").unwrap();
        let talk = create_bookmark_folder(&conn, "  Talk  ").unwrap();
        assert_eq!(talk.name, "Talk");
        assert_eq!(talk.bookmark_count, 0);
        assert!(err_of(create_bookmark_folder(&conn, "")).contains("can't be empty"));
        assert!(err_of(create_bookmark_folder(&conn, "   ")).contains("can't be empty"));
        let dup = err_of(create_bookmark_folder(&conn, "talk"));
        assert!(
            dup.contains(r#"a folder named "talk" already exists"#),
            "{dup}"
        );

        rename_bookmark_folder(&conn, talk.id, "TALK").unwrap();
        let other = create_bookmark_folder(&conn, "Other").unwrap();
        assert!(err_of(rename_bookmark_folder(&conn, other.id, "talk")).contains("already exists"));
        assert!(err_of(rename_bookmark_folder(&conn, other.id, " ")).contains("can't be empty"));
        let names: Vec<String> = list_bookmark_folders(&conn)
            .unwrap()
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert_eq!(names, ["Other", "TALK"]);

        assert!(err_of(rename_bookmark_folder(&conn, 42, "x")).contains("no folder with id 42"));
        assert!(err_of(delete_bookmark_folder(&conn, 42)).contains("no folder with id 42"));
    }

    #[test]
    fn bookmark_folders_list_newest_first() {
        let conn = open_db(":memory:").unwrap();
        create_bookmark_folder(&conn, "A").unwrap();
        create_bookmark_folder(&conn, "B").unwrap();
        let names: Vec<String> = list_bookmark_folders(&conn)
            .unwrap()
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert_eq!(names, ["B", "A"]);
    }

    #[test]
    fn bookmarks_in_several_folders() {
        let mut conn = open_db(":memory:").unwrap();
        let book = one_chapter_book("Mind", &["first passage", "second passage"]);
        let book_id = load_book(&mut conn, "/m.epub", "hm", &book).unwrap();
        let [p1, p2] = block_ids(&conn, book_id)[..] else {
            panic!("expected two paragraphs");
        };
        let a = create_bookmark_folder(&conn, "A").unwrap().id;
        let b = create_bookmark_folder(&conn, "B").unwrap().id;

        let first = add_bookmark(&conn, a, p1).unwrap();
        add_bookmark(&conn, b, p1).unwrap();
        add_bookmark(&conn, a, p2).unwrap();
        assert_eq!(
            add_bookmark(&conn, a, p1).unwrap(),
            first,
            "re-adding is a no-op"
        );

        let chapter_id = get_book_chapters(&conn, book_id).unwrap()[0].id;
        let pairs: Vec<(i64, i64)> = get_chapter_bookmarks(&conn, chapter_id)
            .unwrap()
            .iter()
            .map(|bm| (bm.content_block_id, bm.folder_id))
            .collect();
        assert_eq!(pairs, [(p1, a), (p1, b), (p2, a)]);

        let in_a = list_folder_bookmarks(&conn, a).unwrap();
        let texts: Vec<&str> = in_a.iter().map(|bm| bm.text.as_str()).collect();
        assert_eq!(texts, ["first passage", "second passage"]);
        assert_eq!(in_a[0].book_id, book_id);
        assert_eq!(in_a[0].book_title.as_deref(), Some("Mind"));
        assert_eq!(in_a[0].chapter_id, chapter_id);
        assert_eq!(in_a[0].chapter_title.as_deref(), Some("Chapter 1"));
        assert_eq!(in_a[0].folder_id, a);

        assert!(err_of(add_bookmark(&conn, 99, p1)).contains("no folder with id 99"));
        assert!(err_of(add_bookmark(&conn, a, 999)).contains("no paragraph with id 999"));
        assert!(err_of(list_folder_bookmarks(&conn, 99)).contains("no folder with id 99"));

        remove_bookmark(&conn, a, p1).unwrap();
        assert_eq!(list_folder_bookmarks(&conn, b).unwrap().len(), 1);
        assert!(err_of(remove_bookmark(&conn, a, p1)).contains("isn't in this folder"));
    }

    #[test]
    fn deleting_folder_or_book_removes_bookmarks() {
        let mut conn = open_db(":memory:").unwrap();
        let x = load_book(
            &mut conn,
            "/x.epub",
            "hx",
            &one_chapter_book("X", &["x1", "x2"]),
        )
        .unwrap();
        let y = load_book(&mut conn, "/y.epub", "hy", &one_chapter_book("Y", &["y1"])).unwrap();
        let xs = block_ids(&conn, x);
        let ys = block_ids(&conn, y);
        let a = create_bookmark_folder(&conn, "A").unwrap().id;
        let b = create_bookmark_folder(&conn, "B").unwrap().id;
        add_bookmark(&conn, a, xs[0]).unwrap();
        add_bookmark(&conn, b, xs[0]).unwrap();
        add_bookmark(&conn, b, xs[1]).unwrap();
        add_bookmark(&conn, b, ys[0]).unwrap();

        delete_bookmark_folder(&conn, a).unwrap();
        let in_b: Vec<i64> = list_folder_bookmarks(&conn, b)
            .unwrap()
            .iter()
            .map(|bm| bm.content_block_id)
            .collect();
        assert_eq!(in_b, [xs[0], xs[1], ys[0]]);

        let counts: Vec<(i64, i64)> = list_books(&conn)
            .unwrap()
            .iter()
            .map(|bk| (bk.id, bk.bookmark_count))
            .collect();
        assert_eq!(counts, [(y, 1), (x, 2)]);

        delete_book(&conn, x).unwrap();
        delete_book(&conn, y).unwrap();
        let folders = list_bookmark_folders(&conn).unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].bookmark_count, 0);
        assert!(list_folder_bookmarks(&conn, b).unwrap().is_empty());
        for fts in ["content_fts", "content_fts_exact"] {
            let sql = format!("INSERT INTO {fts}({fts}, rank) VALUES ('integrity-check', 1)");
            conn.execute(&sql, []).unwrap();
        }
    }

    fn fts(q: &str) -> Option<String> {
        to_fts_query(q)
    }

    #[test]
    fn fts_query_quotes_each_word() {
        assert_eq!(fts("neural networks").unwrap(), r#""neural" "networks""#);
        assert_eq!(fts("don't").unwrap(), r#""don't""#);
        assert_eq!(fts("self-aware a.b").unwrap(), r#""self-aware" "a.b""#);
        assert_eq!(
            fts("(foo) bar:baz NEAR").unwrap(),
            r#""(foo)" "bar:baz" "NEAR""#
        );
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

    /// A book long enough to scroll, with one hit ("quincunx") deep in its
    /// second chapter, so the UI can show a search hit being centred.
    fn long_book() -> ParsedBook {
        let chapters = ["Part One", "Part Two", "Part Three"]
            .iter()
            .enumerate()
            .map(|(c, title)| {
                let paragraphs = (1..=40)
                    .map(|n| {
                        let text = if c == 1 && n == 30 {
                            format!("{title}, paragraph {n}: the trees were planted in a quincunx.")
                        } else {
                            format!(
                                "{title}, paragraph {n}: filler text that is long enough to \
                                 wrap onto a second line in the reader, so the chapter scrolls."
                            )
                        };
                        (0, text.len(), text)
                    })
                    .collect();
                crate::epub::ParsedChapter {
                    file_name: format!("part{}.xhtml", c + 1),
                    title: title.to_string(),
                    paragraphs,
                }
            })
            .collect();
        ParsedBook {
            title: Some("A Long Book for Scrolling".to_string()),
            author: Some("Fixture Author".to_string()),
            chapters,
        }
    }

    /// The frontend tests and `npm run dev:mock` replay this file instead of
    /// calling Rust, so it must match what the core functions really return.
    #[test]
    fn ui_fixtures_are_current() {
        use serde_json::{json, to_value, Value};
        use std::collections::BTreeMap;

        let mut conn = open_db(":memory:").unwrap();
        let import_new = import_book(&mut conn, "test.epub").unwrap();
        let import_again = import_book(&mut conn, "test.epub").unwrap();
        let long_id = load_book(&mut conn, "/books/long.epub", "long", &long_book()).unwrap();

        // One folder holding a passage from each book, so the UI starts with
        // something to list. `created_at` is pinned so the file is stable.
        let folder = create_bookmark_folder(&conn, "Know your limit - Oct 10 2026").unwrap();
        for book_id in [import_new.book_id, long_id] {
            let chapter = &get_book_chapters(&conn, book_id).unwrap()[0];
            let block = &get_chapter_content(&conn, chapter.id).unwrap().blocks[1];
            add_bookmark(&conn, folder.id, block.id).unwrap();
        }
        conn.execute(
            "UPDATE bookmark_folders SET created_at = '2026-09-01 12:00:00'",
            [],
        )
        .unwrap();

        let books = list_books(&conn).unwrap();
        let mut chapters = BTreeMap::new();
        let mut chapter_content = BTreeMap::new();
        for book in &books {
            let chs = get_book_chapters(&conn, book.id).unwrap();
            for ch in &chs {
                let content = get_chapter_content(&conn, ch.id).unwrap();
                chapter_content.insert(ch.id.to_string(), to_value(content).unwrap());
            }
            chapters.insert(book.id.to_string(), to_value(chs).unwrap());
        }
        let mut searches = BTreeMap::new();
        for (mode, name, query) in [
            (SearchMode::Stemmed, "stemmed", "neural networks"),
            (SearchMode::Exact, "exact", "neural networks"),
            (SearchMode::Stemmed, "stemmed", "quincunx"),
            (SearchMode::Stemmed, "stemmed", "zzzz"),
        ] {
            let hits = search(&conn, query, mode, 50).unwrap();
            searches.insert(format!("{name}:{query}"), to_value(hits).unwrap());
        }

        let fixtures: Value = json!({
            "import_new": import_new,
            "import_again": import_again,
            "books": books,
            "chapters": chapters,
            "chapter_content": chapter_content,
            "search": searches,
            "bookmark_folders": list_bookmark_folders(&conn).unwrap(),
            "folder_bookmarks": { folder.id.to_string(): list_folder_bookmarks(&conn, folder.id).unwrap() },
        });
        let actual = serde_json::to_string_pretty(&fixtures).unwrap() + "\n";

        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/test/fixtures/library.json"
        );
        if std::env::var("UPDATE_UI_FIXTURES").as_deref() == Ok("1") {
            std::fs::write(path, &actual).unwrap();
            return;
        }
        let committed = std::fs::read_to_string(path).unwrap_or_default();
        assert!(
            committed == actual,
            "src/test/fixtures/library.json is out of date: run \
             UPDATE_UI_FIXTURES=1 cargo test -p ebook_research_core ui_fixtures"
        );
    }
}
