//! Bookmark folders and the bookmarks in them.

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

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
    use crate::db::import::load_book;
    use crate::db::migrations;
    use crate::db::test_util::*;
    use crate::db::*;

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
}
