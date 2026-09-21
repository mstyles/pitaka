use ebook_research_core::{
    db, import_book, open_db, parse_epub, search, ImportOutcome, SearchMode,
};
use rusqlite::Connection;

#[test]
fn parses_and_indexes_and_searches() {
    let db_path = "/tmp/test_library.db";
    let _ = std::fs::remove_file(db_path);

    let parsed = parse_epub("test.epub").expect("parse failed");
    assert_eq!(parsed.title.as_deref(), Some("Test Book of Research"));
    // The spine is nav.xhtml + 2 chapters; the nav document is skipped.
    assert_eq!(
        parsed.chapters.len(),
        2,
        "expected 2 chapters, got {}",
        parsed.chapters.len()
    );

    let total_paragraphs: usize = parsed.chapters.iter().map(|c| c.paragraphs.len()).sum();
    assert!(
        total_paragraphs >= 4,
        "expected at least 4 paragraphs, got {total_paragraphs}"
    );

    let mut conn = open_db(db_path).expect("open_db failed");
    let outcome = import_book(&mut conn, "test.epub").expect("import_book failed");
    assert!(!outcome.already_imported);
    let book_id = outcome.book_id;
    assert!(book_id > 0);

    let results = search(&conn, "neural networks", SearchMode::Stemmed, 10).expect("search failed");
    assert!(
        !results.is_empty(),
        "expected search hits for 'neural networks'"
    );
    assert!(
        results[0].snippet.contains('['),
        "snippet should contain highlight markers: {}",
        results[0].snippet
    );

    let results2 =
        search(&conn, "transformers OR attention", SearchMode::Stemmed, 10).expect("search failed");
    assert_eq!(results2.len(), 2, "expected 2 hits, got {:?}", results2);

    // --- exact vs stemmed search ---
    let hits = |q: &str, mode| search(&conn, q, mode, 10).expect("search failed").len();
    assert!(
        hits("network", SearchMode::Stemmed) > 0,
        "stemmed 'network' should match 'networks'"
    );
    assert_eq!(
        hits("network", SearchMode::Exact),
        0,
        "exact 'network' should not match 'networks'"
    );
    assert_eq!(hits("networks", SearchMode::Exact), 2);
    assert!(
        hits("learn", SearchMode::Stemmed) > 0,
        "stemmed 'learn' should match 'learning'"
    );
    assert_eq!(
        hits("learn", SearchMode::Exact),
        0,
        "exact 'learn' should not match 'learning'"
    );
    assert!(hits("learning", SearchMode::Exact) > 0);
    assert!(
        hits("NEURAL", SearchMode::Exact) > 0,
        "exact search should still ignore case"
    );

    // --- punctuation and query syntax ---
    for mode in [SearchMode::Stemmed, SearchMode::Exact] {
        for q in [
            "don't",
            "self-aware",
            "a.b",
            "(neural",
            "neural:",
            "\"neural",
            "OR",
            "neural AND",
            "",
        ] {
            search(&conn, q, mode, 10).unwrap_or_else(|e| panic!("{q:?} ({mode:?}) failed: {e}"));
        }
        assert_eq!(
            hits("machine-learning", mode),
            1,
            "hyphenated words should match as a phrase"
        );
        assert_eq!(
            hits("\"networks can\"", mode),
            1,
            "quoted phrases should still work"
        );
        assert_eq!(
            hits("\"can networks\"", mode),
            0,
            "phrase word order should matter"
        );
        assert_eq!(
            hits("reinforce*", mode),
            1,
            "prefix search should still work"
        );
        assert_eq!(hits("neural NOT gradient", mode), 2);
    }
    assert_eq!(hits("", SearchMode::Stemmed), 0);

    // --- reader view read APIs ---
    let parsed_titles: Vec<&str> = parsed.chapters.iter().map(|c| c.title.as_str()).collect();
    assert!(
        parsed_titles.contains(&"Chapter One: Beginnings"),
        "titles: {parsed_titles:?}"
    );
    assert!(
        parsed_titles.contains(&"Chapter Two: Deeper Waters"),
        "titles: {parsed_titles:?}"
    );
    assert!(
        !parsed_titles.contains(&"Test Book of Research"),
        "the nav document shouldn't be a chapter: {parsed_titles:?}"
    );

    let books = db::list_books(&conn).expect("list_books failed");
    assert_eq!(books.len(), 1);
    assert_eq!(books[0].id, book_id);
    assert_eq!(books[0].chapter_count as usize, parsed.chapters.len());

    let chapters = db::get_book_chapters(&conn, book_id).expect("get_book_chapters failed");
    let db_titles: Vec<&str> = chapters
        .iter()
        .map(|c| c.title.as_deref().unwrap())
        .collect();
    assert_eq!(
        db_titles, parsed_titles,
        "chapter titles should round-trip in idx order"
    );
    let idxs: Vec<i64> = chapters.iter().map(|c| c.idx).collect();
    assert_eq!(
        idxs,
        vec![0, 1],
        "idx should stay contiguous after skipping nav"
    );

    for (ch, parsed_ch) in chapters.iter().zip(&parsed.chapters) {
        let content = db::get_chapter_content(&conn, ch.id).expect("get_chapter_content failed");
        assert_eq!(content.book_id, book_id);
        assert_eq!(content.chapter_idx, ch.idx);
        let texts: Vec<&str> = content.blocks.iter().map(|b| b.text.as_str()).collect();
        let expected: Vec<&str> = parsed_ch
            .paragraphs
            .iter()
            .map(|(_, _, t)| t.as_str())
            .collect();
        assert_eq!(
            texts, expected,
            "blocks should come back in block_idx order"
        );
    }

    let hit = &results[0];
    assert_eq!(hit.book_id, book_id);
    let hit_chapter =
        db::get_chapter_content(&conn, hit.chapter_id).expect("get_chapter_content failed");
    assert_eq!(hit_chapter.chapter_idx, hit.chapter_idx);
    assert_eq!(hit_chapter.chapter_title, hit.chapter_title);
    assert!(
        hit_chapter
            .blocks
            .iter()
            .any(|b| b.id == hit.content_block_id),
        "search hit's block should be in the chapter it points to"
    );
}

/// Importing a file whose contents are already in the library, from the same
/// path or a copy elsewhere, returns the existing book instead of adding
/// another. A changed file at an already-imported path is a clear error.
#[test]
fn skips_duplicate_imports() {
    let db_path = "/tmp/test_dedup_library.db";
    let copy_path = "/tmp/test_dedup_copy.epub";
    let changed_path = "/tmp/test_dedup_changed.epub";
    let _ = std::fs::remove_file(db_path);
    std::fs::copy("test.epub", copy_path).unwrap();
    std::fs::write(changed_path, b"edited since it was imported").unwrap();

    let mut conn = open_db(db_path).unwrap();
    let first = import_book(&mut conn, "test.epub").unwrap();
    assert!(!first.already_imported);
    let duplicate = ImportOutcome {
        book_id: first.book_id,
        already_imported: true,
    };

    assert_eq!(
        import_book(&mut conn, "test.epub").unwrap(),
        duplicate,
        "same path"
    );
    assert_eq!(
        import_book(&mut conn, copy_path).unwrap(),
        duplicate,
        "copy at another path"
    );

    let books: i64 = conn
        .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
        .unwrap();
    assert_eq!(books, 1);
    assert_eq!(
        search(&conn, "gradient", SearchMode::Exact, 10)
            .unwrap()
            .len(),
        1,
        "no duplicate hits"
    );

    // `changed_path` was imported, then the file changed on disk.
    conn.execute(
        "INSERT INTO books (file_path, file_hash, format) VALUES (?1, 'old-hash', 'epub')",
        [changed_path],
    )
    .unwrap();
    let err = import_book(&mut conn, changed_path)
        .expect_err("a changed file at an imported path should fail");
    assert!(err.to_string().contains("has changed"), "{err}");
}

/// Removing a book takes its text out of search, and because imports are
/// de-duped by file hash, lets the same file be imported again.
#[test]
fn deletes_and_reimports_a_book() {
    let db_path = "/tmp/test_delete_library.db";
    let _ = std::fs::remove_file(db_path);

    let mut conn = open_db(db_path).unwrap();
    let first = import_book(&mut conn, "test.epub").unwrap();
    db::delete_book(&conn, first.book_id).unwrap();

    assert!(db::list_books(&conn).unwrap().is_empty());
    assert!(db::get_book_chapters(&conn, first.book_id)
        .unwrap()
        .is_empty());
    for mode in [SearchMode::Stemmed, SearchMode::Exact] {
        assert!(
            search(&conn, "neural networks", mode, 10)
                .unwrap()
                .is_empty(),
            "{mode:?}"
        );
    }
    assert!(
        db::delete_book(&conn, first.book_id).is_err(),
        "a second delete should fail"
    );

    let again = import_book(&mut conn, "test.epub").unwrap();
    assert!(
        !again.already_imported,
        "a removed book should import as new"
    );
    assert!(!search(&conn, "neural networks", SearchMode::Stemmed, 10)
        .unwrap()
        .is_empty());
}

/// A library created before migrations were tracked (the 001 schema with
/// `user_version = 0`) should be upgraded in place, with both search indexes
/// rebuilt from its existing text.
#[test]
fn upgrades_unversioned_library() {
    let db_path = "/tmp/test_unversioned_library.db";
    let _ = std::fs::remove_file(db_path);

    {
        let conn = Connection::open(db_path).unwrap();
        conn.execute_batch(include_str!("../migrations/001_initial.sql"))
            .unwrap();
        conn.execute_batch(
            "INSERT INTO books (id, file_path, file_hash, title, format) VALUES (1, '/x.epub', 'h', 'Old', 'epub');
             INSERT INTO chapters (id, book_id, idx, title) VALUES (1, 1, 0, 'Ch');
             INSERT INTO content_blocks (book_id, chapter_id, block_idx, char_start, char_end, text)
             VALUES (1, 1, 0, 0, 30, 'Wandering on in saṃsāra with Ānanda, ṝ');",
        )
        .unwrap();
    }

    for _ in 0..2 {
        let conn =
            open_db(db_path).expect("open_db should upgrade (and then no-op on) an old library");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 3);

        let hits = |q: &str, mode| search(&conn, q, mode, 10).expect("search failed").len();
        for mode in [SearchMode::Stemmed, SearchMode::Exact] {
            assert_eq!(
                hits("samsara", mode),
                1,
                "{mode:?}: diacritics should be folded"
            );
            assert_eq!(hits("ananda", mode), 1, "{mode:?}");
            assert_eq!(
                hits("r", mode),
                1,
                "{mode:?}: multi-diacritic letters should be folded"
            );
        }
        assert_eq!(hits("wander", SearchMode::Stemmed), 1);
        assert_eq!(hits("wander", SearchMode::Exact), 0);
    }
}

/// Bookmarks a real paragraph into a folder, reads it back with its book and
/// chapter, and checks removing the book empties the folder but keeps it.
#[test]
fn bookmarks_a_passage_into_a_folder() {
    let db_path = "/tmp/test_bookmarks_library.db";
    let _ = std::fs::remove_file(db_path);

    let mut conn = open_db(db_path).unwrap();
    let book_id = import_book(&mut conn, "test.epub").unwrap().book_id;
    let chapter = db::get_book_chapters(&conn, book_id)
        .unwrap()
        .into_iter()
        .find(|c| c.title.as_deref() == Some("Chapter One: Beginnings"))
        .expect("Chapter One should be imported");
    let block = db::get_chapter_content(&conn, chapter.id)
        .unwrap()
        .blocks
        .remove(0);
    let folder = db::create_bookmark_folder(&conn, "Know your limit - Oct 10 2026").unwrap();

    db::add_bookmark(&conn, folder.id, block.id).unwrap();

    let passages = db::list_folder_bookmarks(&conn, folder.id).unwrap();
    assert_eq!(passages.len(), 1);
    assert_eq!(
        passages[0].book_title.as_deref(),
        Some("Test Book of Research")
    );
    assert_eq!(passages[0].chapter_id, chapter.id);
    assert_eq!(passages[0].chapter_title, chapter.title);
    assert_eq!(passages[0].text, block.text);
    assert_eq!(db::list_books(&conn).unwrap()[0].bookmark_count, 1);

    db::delete_book(&conn, book_id).unwrap();
    let folders = db::list_bookmark_folders(&conn).unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].name, "Know your limit - Oct 10 2026");
    assert_eq!(folders[0].bookmark_count, 0);
}
