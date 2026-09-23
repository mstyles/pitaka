//! The library database: schema migrations and opening a connection. Each
//! area of queries lives in a submodule, re-exported here so callers use
//! `db::<item>` whatever file it is in.

use anyhow::Result;
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

/// Schema migrations, applied in order. The DB's `PRAGMA user_version` records
/// how many have run. Never edit one that has shipped — add a new file.
fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(include_str!("../../migrations/001_initial.sql")),
        M::up(include_str!("../../migrations/002_search_indexes.sql")),
        M::up(include_str!("../../migrations/003_bookmark_folders.sql")),
        M::up(include_str!("../../migrations/004_chunk_embeddings.sql")),
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

mod bookmarks;
mod import;
mod library;
mod search;
mod semantic_index;
#[cfg(test)]
mod test_util;
#[cfg(test)]
mod ui_fixtures;

pub use bookmarks::{
    add_bookmark, create_bookmark_folder, delete_bookmark_folder, get_chapter_bookmarks,
    list_bookmark_folders, list_folder_bookmarks, remove_bookmark, rename_bookmark_folder,
    BlockBookmark, BookmarkFolder, FolderBookmark,
};
pub use import::{delete_book, import_book, ImportOutcome};
pub use library::{
    get_book_chapters, get_chapter_content, list_books, BookSummary, ChapterContent,
    ChapterSummary, ContentBlockRow,
};
pub use search::{search, search_with_variants, SearchMode, SearchResult, VariantIndex};
pub use semantic_index::MIN_SCORE;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_valid() {
        migrations().validate().unwrap();
    }
}
