//! Helpers shared by the db submodules' tests.

use super::{get_book_chapters, get_chapter_content};
use crate::epub::ParsedBook;
use anyhow::Result;
use rusqlite::Connection;

pub(super) fn one_chapter_book(title: &str, paragraphs: &[&str]) -> ParsedBook {
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

/// The ids of a one-chapter book's paragraphs, in order.
pub(super) fn block_ids(conn: &Connection, book_id: i64) -> Vec<i64> {
    let chapter = &get_book_chapters(conn, book_id).unwrap()[0];
    get_chapter_content(conn, chapter.id)
        .unwrap()
        .blocks
        .iter()
        .map(|b| b.id)
        .collect()
}

pub(super) fn err_of<T: std::fmt::Debug>(r: Result<T>) -> String {
    r.expect_err("expected an error").to_string()
}
