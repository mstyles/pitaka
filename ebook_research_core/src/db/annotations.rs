//! Highlights inside a paragraph, and notes on a highlight or a whole
//! paragraph. Offsets count Unicode scalar values (`chars()`), like
//! `char_start`/`char_end`. Block text never changes after import, so a
//! range stays valid for as long as its paragraph exists.

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// The colours a highlight can have; the frontend has a swatch for each.
pub const HIGHLIGHT_COLORS: [&str; 4] = ["yellow", "green", "blue", "pink"];

#[derive(Serialize, Debug)]
pub struct Highlight {
    pub id: i64,
    pub content_block_id: i64,
    pub start_offset: i64,
    pub end_offset: i64,
    pub color: String,
    pub created_at: String,
}

/// A note on a highlight, or on its whole paragraph when `highlight_id` is
/// `None`.
#[derive(Serialize, Debug)]
pub struct Note {
    pub id: i64,
    pub content_block_id: i64,
    pub highlight_id: Option<i64>,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A chapter's highlights and notes, both in paragraph order; highlights
/// within a paragraph by where they start.
#[derive(Serialize, Debug)]
pub struct ChapterAnnotations {
    pub highlights: Vec<Highlight>,
    pub notes: Vec<Note>,
}

/// A book with at least one highlight or note.
#[derive(Serialize, Debug)]
pub struct AnnotatedBook {
    pub book_id: i64,
    pub title: Option<String>,
    pub author: Option<String>,
    pub highlight_count: i64,
    pub note_count: i64,
}

/// One entry on a book's annotations page: a highlight (with its note, if
/// any) or a paragraph note. `text` is the highlighted words, or the whole
/// paragraph for a paragraph note.
#[derive(Serialize, Debug)]
pub struct BookAnnotation {
    pub content_block_id: i64,
    pub chapter_id: i64,
    pub chapter_idx: i64,
    pub chapter_title: Option<String>,
    pub highlight_id: Option<i64>,
    pub color: Option<String>,
    pub text: String,
    pub note_id: Option<i64>,
    pub note_body: Option<String>,
}

fn check_color(color: &str) -> Result<()> {
    if !HIGHLIGHT_COLORS.contains(&color) {
        bail!("unknown highlight colour \"{color}\"");
    }
    Ok(())
}

fn check_body(body: &str) -> Result<&str> {
    let body = body.trim();
    if body.is_empty() {
        bail!("note can't be empty");
    }
    Ok(body)
}

/// The characters `start..end` of `text`, counted as `chars()`.
fn slice_chars(text: &str, start: i64, end: i64) -> String {
    text.chars()
        .skip(start.max(0) as usize)
        .take((end - start).max(0) as usize)
        .collect()
}

/// A paragraph's book and text.
fn block(conn: &Connection, content_block_id: i64) -> Result<(i64, String)> {
    let found = conn
        .query_row(
            "SELECT book_id, text FROM content_blocks WHERE id = ?1",
            params![content_block_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some(found) = found else {
        bail!("no paragraph with id {content_block_id}");
    };
    Ok(found)
}

fn get_highlight(conn: &Connection, highlight_id: i64) -> Result<Highlight> {
    let found = conn
        .query_row(
            "SELECT id, content_block_id, start_offset, end_offset,
                    COALESCE(color, 'yellow'), created_at
             FROM highlights WHERE id = ?1",
            params![highlight_id],
            highlight_row,
        )
        .optional()?;
    let Some(found) = found else {
        bail!("no highlight with id {highlight_id}");
    };
    Ok(found)
}

fn highlight_row(row: &rusqlite::Row) -> rusqlite::Result<Highlight> {
    Ok(Highlight {
        id: row.get(0)?,
        content_block_id: row.get(1)?,
        start_offset: row.get(2)?,
        end_offset: row.get(3)?,
        color: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn note_row(row: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        content_block_id: row.get(1)?,
        highlight_id: row.get(2)?,
        body: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn get_note(conn: &Connection, note_id: i64) -> Result<Note> {
    Ok(conn.query_row(
        "SELECT id, content_block_id, highlight_id, body, created_at, updated_at
         FROM notes WHERE id = ?1",
        params![note_id],
        note_row,
    )?)
}

/// Highlights `start..end` of a paragraph. The range must lie inside the
/// paragraph and not overlap another highlight there; ranges that only
/// touch are fine.
pub fn add_highlight(
    conn: &Connection,
    content_block_id: i64,
    start: i64,
    end: i64,
    color: &str,
) -> Result<Highlight> {
    check_color(color)?;
    let (book_id, text) = block(conn, content_block_id)?;
    let len = text.chars().count() as i64;
    if start < 0 || start >= end || end > len {
        bail!("highlight range {start}..{end} is outside the paragraph");
    }
    let overlaps: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM highlights
                       WHERE content_block_id = ?1 AND start_offset < ?3 AND end_offset > ?2)",
        params![content_block_id, start, end],
        |row| row.get(0),
    )?;
    if overlaps {
        bail!("that overlaps an existing highlight");
    }
    conn.execute(
        "INSERT INTO highlights (book_id, content_block_id, start_offset, end_offset, color)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![book_id, content_block_id, start, end, color],
    )?;
    get_highlight(conn, conn.last_insert_rowid())
}

pub fn set_highlight_color(conn: &Connection, highlight_id: i64, color: &str) -> Result<()> {
    check_color(color)?;
    let updated = conn.execute(
        "UPDATE highlights SET color = ?1 WHERE id = ?2",
        params![color, highlight_id],
    )?;
    if updated == 0 {
        bail!("no highlight with id {highlight_id}");
    }
    Ok(())
}

/// Removes a highlight and its note. The note goes first: the schema's
/// `ON DELETE SET NULL` would otherwise turn it into a paragraph note,
/// which fails if the paragraph already has one.
pub fn delete_highlight(conn: &Connection, highlight_id: i64) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM notes WHERE highlight_id = ?1",
        params![highlight_id],
    )?;
    let deleted = tx.execute(
        "DELETE FROM highlights WHERE id = ?1",
        params![highlight_id],
    )?;
    if deleted == 0 {
        bail!("no highlight with id {highlight_id}");
    }
    tx.commit()?;
    Ok(())
}

/// Adds the note on a highlight. Its paragraph and book are copied from
/// the highlight, so they always agree with it.
pub fn add_highlight_note(conn: &Connection, highlight_id: i64, body: &str) -> Result<Note> {
    let body = check_body(body)?;
    let highlight = get_highlight(conn, highlight_id)?;
    let taken: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM notes WHERE highlight_id = ?1)",
        params![highlight_id],
        |row| row.get(0),
    )?;
    if taken {
        bail!("that highlight already has a note");
    }
    conn.execute(
        "INSERT INTO notes (book_id, content_block_id, highlight_id, body)
         SELECT book_id, content_block_id, id, ?2 FROM highlights WHERE id = ?1",
        params![highlight.id, body],
    )?;
    get_note(conn, conn.last_insert_rowid())
}

/// Adds the note on a whole paragraph.
pub fn add_paragraph_note(conn: &Connection, content_block_id: i64, body: &str) -> Result<Note> {
    let body = check_body(body)?;
    let (book_id, _) = block(conn, content_block_id)?;
    let taken: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM notes
                       WHERE content_block_id = ?1 AND highlight_id IS NULL)",
        params![content_block_id],
        |row| row.get(0),
    )?;
    if taken {
        bail!("that paragraph already has a note");
    }
    conn.execute(
        "INSERT INTO notes (book_id, content_block_id, body) VALUES (?1, ?2, ?3)",
        params![book_id, content_block_id, body],
    )?;
    get_note(conn, conn.last_insert_rowid())
}

pub fn update_note(conn: &Connection, note_id: i64, body: &str) -> Result<()> {
    let body = check_body(body)?;
    let updated = conn.execute(
        "UPDATE notes SET body = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![body, note_id],
    )?;
    if updated == 0 {
        bail!("no note with id {note_id}");
    }
    Ok(())
}

pub fn delete_note(conn: &Connection, note_id: i64) -> Result<()> {
    let deleted = conn.execute("DELETE FROM notes WHERE id = ?1", params![note_id])?;
    if deleted == 0 {
        bail!("no note with id {note_id}");
    }
    Ok(())
}

/// Every highlight and note in a chapter, for the reader.
pub fn get_chapter_annotations(conn: &Connection, chapter_id: i64) -> Result<ChapterAnnotations> {
    let mut stmt = conn.prepare(
        "SELECT h.id, h.content_block_id, h.start_offset, h.end_offset,
                COALESCE(h.color, 'yellow'), h.created_at
         FROM content_blocks cb
         JOIN highlights h ON h.content_block_id = cb.id
         WHERE cb.chapter_id = ?1
         ORDER BY cb.block_idx, h.start_offset",
    )?;
    let highlights = stmt
        .query_map(params![chapter_id], highlight_row)?
        .collect::<rusqlite::Result<_>>()?;

    let mut stmt = conn.prepare(
        "SELECT n.id, n.content_block_id, n.highlight_id, n.body, n.created_at, n.updated_at
         FROM content_blocks cb
         JOIN notes n ON n.content_block_id = cb.id
         LEFT JOIN highlights h ON h.id = n.highlight_id
         WHERE cb.chapter_id = ?1
         ORDER BY cb.block_idx, COALESCE(h.start_offset, -1)",
    )?;
    let notes = stmt
        .query_map(params![chapter_id], note_row)?
        .collect::<rusqlite::Result<_>>()?;

    Ok(ChapterAnnotations { highlights, notes })
}

/// Books with at least one highlight or note, by title.
pub fn list_annotated_books(conn: &Connection) -> Result<Vec<AnnotatedBook>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM (
             SELECT b.id, b.title, b.author,
                    (SELECT COUNT(*) FROM highlights h WHERE h.book_id = b.id) AS highlight_count,
                    (SELECT COUNT(*) FROM notes n WHERE n.book_id = b.id) AS note_count
             FROM books b
         )
         WHERE highlight_count > 0 OR note_count > 0
         ORDER BY title COLLATE NOCASE, id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(AnnotatedBook {
            book_id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            highlight_count: row.get(3)?,
            note_count: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// A book's highlights and paragraph notes in reading order: by chapter and
/// paragraph, a paragraph's own note first, then its highlights by where
/// they start. A missing book is an error, so it isn't mistaken for one
/// with nothing marked.
pub fn list_book_annotations(conn: &Connection, book_id: i64) -> Result<Vec<BookAnnotation>> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM books WHERE id = ?1)",
        params![book_id],
        |row| row.get(0),
    )?;
    if !exists {
        bail!("no book with id {book_id}");
    }
    let mut stmt = conn.prepare(
        "SELECT cb.id, ch.id, ch.idx AS chapter_idx, ch.title, h.id, COALESCE(h.color, 'yellow'),
                cb.text, h.start_offset AS start, h.end_offset, n.id, n.body,
                cb.block_idx AS block_idx
         FROM highlights h
         JOIN content_blocks cb ON cb.id = h.content_block_id
         JOIN chapters ch       ON ch.id = cb.chapter_id
         LEFT JOIN notes n      ON n.highlight_id = h.id
         WHERE h.book_id = ?1
         UNION ALL
         SELECT cb.id, ch.id, ch.idx, ch.title, NULL, NULL,
                cb.text, -1, -1, n.id, n.body,
                cb.block_idx
         FROM notes n
         JOIN content_blocks cb ON cb.id = n.content_block_id
         JOIN chapters ch       ON ch.id = cb.chapter_id
         WHERE n.book_id = ?1 AND n.highlight_id IS NULL
         ORDER BY chapter_idx, block_idx, start",
    )?;
    let rows = stmt.query_map(params![book_id], |row| {
        let highlight_id: Option<i64> = row.get(4)?;
        let text: String = row.get(6)?;
        let text = match highlight_id {
            Some(_) => slice_chars(&text, row.get(7)?, row.get(8)?),
            None => text,
        };
        Ok(BookAnnotation {
            content_block_id: row.get(0)?,
            chapter_id: row.get(1)?,
            chapter_idx: row.get(2)?,
            chapter_title: row.get(3)?,
            highlight_id,
            color: row.get(5)?,
            text,
            note_id: row.get(9)?,
            note_body: row.get(10)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::import::load_book;
    use crate::db::test_util::*;
    use crate::db::*;
    use crate::epub::{ParsedBook, ParsedChapter};

    fn chapter_of(conn: &Connection, book_id: i64) -> i64 {
        get_book_chapters(conn, book_id).unwrap()[0].id
    }

    #[test]
    fn highlight_ranges_count_characters() {
        let mut conn = open_db(":memory:").unwrap();
        let book = one_chapter_book("P", &["Paṭācārā went home"]);
        let book_id = load_book(&mut conn, "/p.epub", "hp", &book).unwrap();
        let p = block_ids(&conn, book_id)[0];

        let h = add_highlight(&conn, p, 0, 8, "yellow").unwrap();
        assert_eq!((h.start_offset, h.end_offset), (0, 8));
        assert_eq!(h.color, "yellow");
        let entries = list_book_annotations(&conn, book_id).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].text, "Paṭācārā");
        assert_eq!(entries[0].highlight_id, Some(h.id));

        let outside = err_of(add_highlight(&conn, p, 9, 19, "green"));
        assert!(
            outside.contains("9..19 is outside the paragraph"),
            "{outside}"
        );
        add_highlight(&conn, p, 9, 18, "green").unwrap();
        assert!(err_of(add_highlight(&conn, p, 5, 5, "blue")).contains("outside"));
        assert!(err_of(add_highlight(&conn, p, -1, 2, "blue")).contains("outside"));
        assert!(
            err_of(add_highlight(&conn, 999, 0, 1, "blue")).contains("no paragraph with id 999")
        );
    }

    #[test]
    fn highlight_overlaps() {
        let mut conn = open_db(":memory:").unwrap();
        let book = one_chapter_book("O", &["abcdefghij", "klmnopqrst"]);
        let book_id = load_book(&mut conn, "/o.epub", "ho", &book).unwrap();
        let [p1, p2] = block_ids(&conn, book_id)[..] else {
            panic!("expected two paragraphs");
        };
        add_highlight(&conn, p1, 0, 4, "yellow").unwrap();
        add_highlight(&conn, p1, 4, 8, "yellow").unwrap();
        assert!(err_of(add_highlight(&conn, p1, 3, 6, "yellow")).contains("overlaps"));
        assert!(err_of(add_highlight(&conn, p1, 1, 2, "yellow")).contains("overlaps"));
        // The same range in another paragraph is unrelated.
        add_highlight(&conn, p2, 3, 6, "yellow").unwrap();
    }

    #[test]
    fn highlight_colors() {
        let mut conn = open_db(":memory:").unwrap();
        let book = one_chapter_book("C", &["colourful words"]);
        let book_id = load_book(&mut conn, "/c.epub", "hc", &book).unwrap();
        let p = block_ids(&conn, book_id)[0];
        let purple = err_of(add_highlight(&conn, p, 0, 4, "purple"));
        assert!(
            purple.contains(r#"unknown highlight colour "purple""#),
            "{purple}"
        );

        let h = add_highlight(&conn, p, 0, 4, "yellow").unwrap();
        set_highlight_color(&conn, h.id, "green").unwrap();
        let annotations = get_chapter_annotations(&conn, chapter_of(&conn, book_id)).unwrap();
        assert_eq!(annotations.highlights[0].color, "green");
        assert!(err_of(set_highlight_color(&conn, h.id, "red")).contains("unknown"));
        assert!(err_of(set_highlight_color(&conn, 99, "blue")).contains("no highlight with id 99"));
    }

    #[test]
    fn notes_one_per_anchor() {
        let mut conn = open_db(":memory:").unwrap();
        let book = one_chapter_book("N", &["a passage worth noting"]);
        let book_id = load_book(&mut conn, "/n.epub", "hn", &book).unwrap();
        let p = block_ids(&conn, book_id)[0];
        let h = add_highlight(&conn, p, 2, 9, "pink").unwrap();

        assert!(err_of(add_highlight_note(&conn, h.id, "")).contains("can't be empty"));
        assert!(err_of(add_highlight_note(&conn, h.id, "  \n ")).contains("can't be empty"));
        assert!(err_of(add_paragraph_note(&conn, p, " ")).contains("can't be empty"));

        let on_highlight = add_highlight_note(&conn, h.id, "  why this matters ").unwrap();
        assert_eq!(on_highlight.body, "why this matters");
        assert_eq!(on_highlight.highlight_id, Some(h.id));
        assert_eq!(on_highlight.content_block_id, h.content_block_id);
        let again = err_of(add_highlight_note(&conn, h.id, "second"));
        assert!(
            again.contains("that highlight already has a note"),
            "{again}"
        );

        let on_paragraph = add_paragraph_note(&conn, p, "the whole thing").unwrap();
        assert_eq!(on_paragraph.highlight_id, None);
        let again = err_of(add_paragraph_note(&conn, p, "second"));
        assert!(
            again.contains("that paragraph already has a note"),
            "{again}"
        );

        let notes = get_chapter_annotations(&conn, chapter_of(&conn, book_id))
            .unwrap()
            .notes;
        let ids: Vec<i64> = notes.iter().map(|n| n.id).collect();
        assert_eq!(ids, [on_paragraph.id, on_highlight.id]);

        assert!(err_of(add_highlight_note(&conn, 99, "x")).contains("no highlight with id 99"));
        assert!(err_of(add_paragraph_note(&conn, 999, "x")).contains("no paragraph with id 999"));
        assert!(err_of(update_note(&conn, 99, "x")).contains("no note with id 99"));
        assert!(err_of(delete_note(&conn, 99)).contains("no note with id 99"));

        delete_note(&conn, on_highlight.id).unwrap();
        add_highlight_note(&conn, h.id, "a fresh one").unwrap();
    }

    #[test]
    fn update_note_bumps_updated_at() {
        let mut conn = open_db(":memory:").unwrap();
        let book = one_chapter_book("U", &["text"]);
        let book_id = load_book(&mut conn, "/u.epub", "hu", &book).unwrap();
        let p = block_ids(&conn, book_id)[0];
        let note = add_paragraph_note(&conn, p, "first").unwrap();
        conn.execute(
            "UPDATE notes SET updated_at = '2000-01-01 00:00:00' WHERE id = ?1",
            [note.id],
        )
        .unwrap();

        update_note(&conn, note.id, " second ").unwrap();
        assert!(err_of(update_note(&conn, note.id, "  ")).contains("can't be empty"));
        let after = get_note(&conn, note.id).unwrap();
        assert_eq!(after.body, "second");
        assert_ne!(after.updated_at, "2000-01-01 00:00:00");
        assert_eq!(after.created_at, note.created_at);
    }

    #[test]
    fn deleting_highlight_deletes_its_note() {
        let mut conn = open_db(":memory:").unwrap();
        let book = one_chapter_book("D", &["one paragraph, two notes"]);
        let book_id = load_book(&mut conn, "/d.epub", "hd", &book).unwrap();
        let p = block_ids(&conn, book_id)[0];
        let own = add_paragraph_note(&conn, p, "about the paragraph").unwrap();
        let h = add_highlight(&conn, p, 0, 3, "blue").unwrap();
        add_highlight_note(&conn, h.id, "about the highlight").unwrap();

        delete_highlight(&conn, h.id).unwrap();
        let annotations = get_chapter_annotations(&conn, chapter_of(&conn, book_id)).unwrap();
        assert!(annotations.highlights.is_empty());
        let ids: Vec<i64> = annotations.notes.iter().map(|n| n.id).collect();
        assert_eq!(ids, [own.id]);
        assert!(err_of(delete_highlight(&conn, h.id)).contains("no highlight with id"));
    }

    #[test]
    fn book_annotations_in_reading_order() {
        let mut conn = open_db(":memory:").unwrap();
        let chapter = |title: &str, paragraphs: &[&str]| ParsedChapter {
            file_name: format!("{title}.xhtml"),
            title: title.to_string(),
            paragraphs: paragraphs
                .iter()
                .map(|p| (0, p.len(), p.to_string()))
                .collect(),
        };
        let book = ParsedBook {
            title: Some("Two".to_string()),
            author: Some("Someone".to_string()),
            chapters: vec![
                chapter("One", &["alpha beta gamma", "delta epsilon"]),
                chapter("Two", &["zeta eta theta"]),
            ],
        };
        let book_id = load_book(&mut conn, "/two.epub", "h2", &book).unwrap();
        let chapters = get_book_chapters(&conn, book_id).unwrap();
        let blocks = |i: usize| -> Vec<i64> {
            get_chapter_content(&conn, chapters[i].id)
                .unwrap()
                .blocks
                .iter()
                .map(|b| b.id)
                .collect()
        };
        let (one, two) = (blocks(0), blocks(1));
        let other = load_book(&mut conn, "/o.epub", "ho", &one_chapter_book("A", &["x"])).unwrap();

        // Added out of order.
        let theta = add_highlight(&conn, two[0], 9, 14, "pink").unwrap();
        let gamma = add_highlight(&conn, one[0], 11, 16, "green").unwrap();
        add_highlight_note(&conn, gamma.id, "third letter").unwrap();
        add_highlight(&conn, one[0], 0, 5, "yellow").unwrap();
        add_paragraph_note(&conn, one[0], "greek").unwrap();
        add_paragraph_note(&conn, one[1], "more greek").unwrap();

        let entries: Vec<(Option<i64>, String, Option<String>)> =
            list_book_annotations(&conn, book_id)
                .unwrap()
                .into_iter()
                .map(|e| (e.highlight_id.map(|_| e.chapter_idx), e.text, e.note_body))
                .collect();
        assert_eq!(
            entries,
            [
                (
                    None,
                    "alpha beta gamma".to_string(),
                    Some("greek".to_string())
                ),
                (Some(0), "alpha".to_string(), None),
                (
                    Some(0),
                    "gamma".to_string(),
                    Some("third letter".to_string())
                ),
                (
                    None,
                    "delta epsilon".to_string(),
                    Some("more greek".to_string())
                ),
                (Some(1), "theta".to_string(), None),
            ]
        );
        let last = &list_book_annotations(&conn, book_id).unwrap()[4];
        assert_eq!(last.highlight_id, Some(theta.id));
        assert_eq!(last.chapter_id, chapters[1].id);
        assert_eq!(last.chapter_title.as_deref(), Some("Two"));
        assert_eq!(last.color.as_deref(), Some("pink"));
        assert!(list_book_annotations(&conn, other).unwrap().is_empty());
        assert!(err_of(list_book_annotations(&conn, 99)).contains("no book with id 99"));

        let chapter_one = get_chapter_annotations(&conn, chapters[0].id).unwrap();
        let starts: Vec<i64> = chapter_one
            .highlights
            .iter()
            .map(|h| h.start_offset)
            .collect();
        assert_eq!(starts, [0, 11]);

        let books: Vec<(i64, i64, i64)> = list_annotated_books(&conn)
            .unwrap()
            .iter()
            .map(|b| (b.book_id, b.highlight_count, b.note_count))
            .collect();
        assert_eq!(books, [(book_id, 3, 3)]);
        let summary = list_books(&conn)
            .unwrap()
            .into_iter()
            .find(|b| b.id == book_id)
            .unwrap();
        assert_eq!((summary.highlight_count, summary.note_count), (3, 3));
    }

    #[test]
    fn deleting_book_removes_annotations() {
        let mut conn = open_db(":memory:").unwrap();
        let x = load_book(&mut conn, "/x.epub", "hx", &one_chapter_book("X", &["x1"])).unwrap();
        let y = load_book(&mut conn, "/y.epub", "hy", &one_chapter_book("Y", &["y1"])).unwrap();
        for book in [x, y] {
            let p = block_ids(&conn, book)[0];
            let h = add_highlight(&conn, p, 0, 1, "yellow").unwrap();
            add_highlight_note(&conn, h.id, "on the highlight").unwrap();
            add_paragraph_note(&conn, p, "on the paragraph").unwrap();
        }

        delete_book(&conn, x).unwrap();
        let ids: Vec<i64> = list_annotated_books(&conn)
            .unwrap()
            .iter()
            .map(|b| b.book_id)
            .collect();
        assert_eq!(ids, [y]);
        for table in ["highlights", "notes"] {
            let sql = format!("SELECT COUNT(*) FROM {table} WHERE book_id = ?1");
            let orphans: i64 = conn.query_row(&sql, [x], |r| r.get(0)).unwrap();
            assert_eq!(orphans, 0, "{table} rows should go with the book");
        }
        for fts in ["content_fts", "content_fts_exact"] {
            let sql = format!("INSERT INTO {fts}({fts}, rank) VALUES ('integrity-check', 1)");
            conn.execute(&sql, []).unwrap();
        }
    }
}
