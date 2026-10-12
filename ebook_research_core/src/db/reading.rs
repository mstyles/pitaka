//! Where each book was left, and how far through it that is.
//!
//! A position is a paragraph: the one at the top of the reader when it
//! was last left, so it survives any change of text size or window width.
//! How far through the book that is counts characters, the text before
//! the paragraph over the book's total, which follows reading time more
//! closely than chapters or paragraphs.

use anyhow::{bail, Result};
use rusqlite::{params, Connection, Row};
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
pub struct ReadingPosition {
    pub book_id: i64,
    pub chapter_id: i64,
    pub content_block_id: i64,
    pub chapter_title: Option<String>,
    /// 1-based, in the order of the book's chapters.
    pub chapter_number: i64,
    pub chapter_count: i64,
    /// The share of the book's characters before the paragraph, rounded;
    /// 100 once the book is finished.
    pub percent: i64,
    /// Whether the paragraph was at the end of the book.
    pub finished: bool,
    /// UTC, as `YYYY-MM-DD HH:MM:SS.sss`.
    pub read_at: String,
}

/// Records `content_block_id` as where its book was left. Saving anywhere
/// but the end clears `finished`, so rereading a finished book puts it
/// back in Continue reading.
pub fn set_reading_position(
    conn: &Connection,
    content_block_id: i64,
    finished: bool,
) -> Result<()> {
    // `INSERT … SELECT … ON CONFLICT` parses only when the SELECT has a
    // WHERE, as this one does.
    let changed = conn.execute(
        "INSERT INTO reading_positions (book_id, content_block_id, finished, read_at)
         SELECT book_id, id, ?2, strftime('%Y-%m-%d %H:%M:%f', 'now')
         FROM content_blocks WHERE id = ?1
         ON CONFLICT (book_id) DO UPDATE
           SET content_block_id = excluded.content_block_id, finished = excluded.finished,
               read_at = excluded.read_at",
        params![content_block_id, finished],
    )?;
    if changed == 0 {
        bail!("no paragraph with id {content_block_id}");
    }
    Ok(())
}

/// Where the book was left, or `None` for a book never read.
pub fn get_reading_position(conn: &Connection, book_id: i64) -> Result<Option<ReadingPosition>> {
    let mut stmt = conn.prepare(&format!("{POSITION_SQL} WHERE rp.book_id = ?1"))?;
    let mut rows = stmt.query_map(params![book_id], position_from_row)?;
    Ok(rows.next().transpose()?)
}

/// Unfinished books, most recently read first, for Continue reading.
pub fn list_reading_positions(conn: &Connection, limit: i64) -> Result<Vec<ReadingPosition>> {
    let mut stmt = conn.prepare(&format!(
        "{POSITION_SQL} WHERE NOT rp.finished
         ORDER BY rp.read_at DESC, rp.book_id DESC LIMIT ?1"
    ))?;
    let rows = stmt.query_map(params![limit], position_from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Each position with its chapter's place in the book and the characters
/// before its paragraph and in the whole book.
const POSITION_SQL: &str = "
    SELECT rp.book_id, ch.id, rp.content_block_id, ch.title,
      (SELECT COUNT(*) FROM chapters c2 WHERE c2.book_id = rp.book_id AND c2.idx <= ch.idx),
      (SELECT COUNT(*) FROM chapters c2 WHERE c2.book_id = rp.book_id),
      (SELECT COALESCE(SUM(LENGTH(o.text)), 0) FROM chapters oc
         JOIN content_blocks o ON o.chapter_id = oc.id
         WHERE oc.book_id = rp.book_id
           AND (oc.idx < ch.idx OR (oc.idx = ch.idx AND o.block_idx < cb.block_idx))),
      (SELECT COALESCE(SUM(LENGTH(t.text)), 0) FROM chapters tc
         JOIN content_blocks t ON t.chapter_id = tc.id WHERE tc.book_id = rp.book_id),
      rp.finished, rp.read_at
    FROM reading_positions rp
    JOIN content_blocks cb ON cb.id = rp.content_block_id
    JOIN chapters ch ON ch.id = cb.chapter_id";

fn position_from_row(row: &Row) -> rusqlite::Result<ReadingPosition> {
    let finished: bool = row.get(8)?;
    Ok(ReadingPosition {
        book_id: row.get(0)?,
        chapter_id: row.get(1)?,
        content_block_id: row.get(2)?,
        chapter_title: row.get(3)?,
        chapter_number: row.get(4)?,
        chapter_count: row.get(5)?,
        percent: if finished {
            100
        } else {
            percent(row.get(6)?, row.get(7)?)
        },
        finished,
        read_at: row.get(9)?,
    })
}

/// `before` as a rounded share of `total`, halves rounding up like the
/// reader's `Math.round`; 0 for an empty book.
fn percent(before: i64, total: i64) -> i64 {
    if total == 0 {
        0
    } else {
        (before * 200 + total) / (2 * total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::import::load_book;
    use crate::db::test_util::*;
    use crate::db::*;

    /// Loads a book and returns its id and each chapter's paragraph ids.
    fn load(conn: &mut Connection, title: &str, chapters: &[&[&str]]) -> (i64, Vec<Vec<i64>>) {
        let book = book_with_chapters(title, chapters);
        let id = load_book(conn, &format!("/{title}.epub"), title, &book).unwrap();
        let blocks = get_book_chapters(conn, id)
            .unwrap()
            .iter()
            .map(|ch| {
                get_chapter_content(conn, ch.id)
                    .unwrap()
                    .blocks
                    .iter()
                    .map(|b| b.id)
                    .collect()
            })
            .collect();
        (id, blocks)
    }

    fn three_chapters(conn: &mut Connection, title: &str) -> (i64, Vec<Vec<i64>>) {
        load(conn, title, &[&["aaaa", "bbbb"], &["cccccccc", "dd"], &[]])
    }

    fn rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM reading_positions", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn set_then_get_reading_position() {
        let mut conn = open_db(":memory:").unwrap();
        let (id, blocks) = three_chapters(&mut conn, "A");

        set_reading_position(&conn, blocks[1][1], false).unwrap();

        let chapter_id = get_book_chapters(&conn, id).unwrap()[1].id;
        let p = get_reading_position(&conn, id).unwrap().unwrap();
        assert_eq!(p.book_id, id);
        assert_eq!(p.chapter_id, chapter_id);
        assert_eq!(p.content_block_id, blocks[1][1]);
        assert_eq!(p.chapter_title.as_deref(), Some("Chapter 2"));
        assert_eq!(p.chapter_number, 2);
        assert_eq!(p.chapter_count, 3);
        assert_eq!(p.percent, 89);
        assert!(!p.finished);
        let shape: String = p
            .read_at
            .chars()
            .map(|c| if c.is_ascii_digit() { '9' } else { c })
            .collect();
        assert_eq!(shape, "9999-99-99 99:99:99.999");
    }

    #[test]
    fn setting_again_replaces_the_position() {
        let mut conn = open_db(":memory:").unwrap();
        let (id, blocks) = three_chapters(&mut conn, "A");

        set_reading_position(&conn, blocks[0][0], false).unwrap();
        set_reading_position(&conn, blocks[0][1], false).unwrap();

        assert_eq!(rows(&conn), 1);
        let p = get_reading_position(&conn, id).unwrap().unwrap();
        assert_eq!(p.content_block_id, blocks[0][1]);
    }

    #[test]
    fn finished_positions_leave_continue_reading() {
        let mut conn = open_db(":memory:").unwrap();
        let (id, blocks) = three_chapters(&mut conn, "A");

        set_reading_position(&conn, blocks[1][1], true).unwrap();
        let p = get_reading_position(&conn, id).unwrap().unwrap();
        assert!(p.finished);
        assert_eq!(p.percent, 100);
        assert!(list_reading_positions(&conn, 10).unwrap().is_empty());

        set_reading_position(&conn, blocks[0][1], false).unwrap();
        let listed = list_reading_positions(&conn, 10).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].book_id, id);
        assert!(!listed[0].finished);
        assert_eq!(rows(&conn), 1);
    }

    #[test]
    fn start_of_book_is_zero_percent_and_unread_is_none() {
        let mut conn = open_db(":memory:").unwrap();
        let (id, blocks) = three_chapters(&mut conn, "A");
        let (unread, _) = three_chapters(&mut conn, "B");

        set_reading_position(&conn, blocks[0][0], false).unwrap();

        assert_eq!(get_reading_position(&conn, id).unwrap().unwrap().percent, 0);
        assert_eq!(get_reading_position(&conn, unread).unwrap(), None);
    }

    #[test]
    fn list_reading_positions_is_most_recent_first() {
        let mut conn = open_db(":memory:").unwrap();
        let books: Vec<_> = ["A", "B", "C"]
            .iter()
            .map(|t| three_chapters(&mut conn, t))
            .collect();
        for (_, blocks) in &books {
            set_reading_position(&conn, blocks[0][0], false).unwrap();
        }
        for ((id, _), at) in books.iter().zip(["01", "03", "02"]) {
            conn.execute(
                "UPDATE reading_positions SET read_at = ?1 WHERE book_id = ?2",
                params![format!("2026-01-01 00:00:{at}"), id],
            )
            .unwrap();
        }

        let ids: Vec<i64> = list_reading_positions(&conn, 2)
            .unwrap()
            .iter()
            .map(|p| p.book_id)
            .collect();
        assert_eq!(ids, vec![books[1].0, books[2].0]);
    }

    #[test]
    fn unknown_paragraph_is_an_error() {
        let conn = open_db(":memory:").unwrap();
        let err = err_of(set_reading_position(&conn, 9999, false));
        assert!(err.contains("no paragraph with id 9999"), "{err}");
        assert_eq!(rows(&conn), 0);
    }

    #[test]
    fn removing_a_book_removes_its_position() {
        let mut conn = open_db(":memory:").unwrap();
        let (gone, gone_blocks) = three_chapters(&mut conn, "A");
        let (kept, kept_blocks) = three_chapters(&mut conn, "B");
        set_reading_position(&conn, gone_blocks[0][1], false).unwrap();
        set_reading_position(&conn, kept_blocks[1][0], false).unwrap();

        delete_book(&conn, gone).unwrap();

        assert_eq!(get_reading_position(&conn, gone).unwrap(), None);
        let ids: Vec<i64> = list_reading_positions(&conn, 10)
            .unwrap()
            .iter()
            .map(|p| p.book_id)
            .collect();
        assert_eq!(ids, vec![kept]);
    }

    #[test]
    fn percent_rounds_half_up() {
        assert_eq!(percent(1, 2), 50);
        assert_eq!(percent(1, 3), 33);
        assert_eq!(percent(2, 3), 67);
        assert_eq!(percent(0, 0), 0);
    }
}
