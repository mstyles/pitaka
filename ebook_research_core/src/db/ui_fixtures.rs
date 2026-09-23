//! Writes and checks the UI test fixtures from real db output.

use super::import::load_book;
use super::*;
use crate::epub::ParsedBook;
use rusqlite::Connection;

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
    use serde_json::to_value;
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

    let mut fixtures = library_fixtures(&conn, &[folder.id]);
    fixtures["import_new"] = to_value(import_new).unwrap();
    fixtures["import_again"] = to_value(import_again).unwrap();
    fixtures["search"] = to_value(searches).unwrap();
    check_fixture("src/test/fixtures/library.json", &fixtures);
}

/// The browser demo (`npm run build:demo`) replays `src/demo/library.json`
/// the way `npm run dev:mock` replays the test fixtures, with one real
/// book: the CC0 Therīgāthā in `demo/`. `demo-search.json` holds the
/// core's own results for a set of queries, which the demo's TypeScript
/// search is tested against (`src/demo/search.test.ts`).
#[test]
fn ui_fixtures_for_demo_are_current() {
    use serde_json::{to_value, Value};
    use std::collections::BTreeMap;

    let mut conn = open_db(":memory:").unwrap();
    let epub = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../demo/verses-of-the-senior-nuns.epub"
    );
    let book_id = import_book(&mut conn, epub).unwrap().book_id;

    let chapters = get_book_chapters(&conn, book_id).unwrap();
    assert_eq!(chapters.len(), 24);
    for ch in &chapters {
        let title = ch.title.as_deref().unwrap_or_default();
        assert!(!title.ends_with(".xhtml"), "file-path title: {title}");
    }

    // Paṭācārā's verses, and the Thirty Nuns' closing line naming her.
    let folder = create_bookmark_folder(&conn, "Paṭācārā").unwrap();
    let fives = chapters
        .iter()
        .find(|ch| ch.title.as_deref() == Some("The Book of the Fives"))
        .unwrap();
    let blocks = get_chapter_content(&conn, fives.id).unwrap().blocks;
    for start in ["Plowing the fields", "That is how thirty senior nuns"] {
        let block = blocks.iter().find(|b| b.text.starts_with(start)).unwrap();
        add_bookmark(&conn, folder.id, block.id).unwrap();
    }
    conn.execute(
        "UPDATE bookmark_folders SET created_at = '2026-09-01 12:00:00'",
        [],
    )
    .unwrap();

    let mut searches = BTreeMap::new();
    for query in [
        "patacara",
        "mara",
        "nibbana",
        "craving",
        "minds",
        "\"senior nuns\"",
        "delight*",
        "mind NOT body",
        "craving OR mara",
        "cast-off",
        "mind* desire",
        "nuns NOT senior OR sorrow",
        "zzzz",
        // Transliteration variants: the book writes "dhamma", "kamma"
        // and "nibbāna", never the Sanskrit spellings searched here.
        "dharma",
        "karma",
        "nirvana",
        "nibbāna",
    ] {
        for (mode, name) in [
            (SearchMode::Stemmed, "stemmed"),
            (SearchMode::Exact, "exact"),
        ] {
            let hits = search(&conn, query, mode, 50).unwrap();
            searches.insert(format!("{name}:{query}"), to_value(hits).unwrap());
        }
    }
    let nibbana = searches["exact:nibbana"].as_array().unwrap();
    assert!(nibbana
        .iter()
        .any(|hit| hit["snippet"].as_str().unwrap().contains("[Nibbāna]")));

    // The Sanskrit spellings appear nowhere in the book, so every one of
    // these hits came from the variant list.
    // The book varies the capitalisation ("kamma" and "Kamma" both
    // occur), so match the spelling, not the case.
    for (query, spelled) in [
        ("dharma", "dhamma"),
        ("karma", "kamma"),
        ("nirvana", "nibbāna"),
    ] {
        for mode in ["stemmed", "exact"] {
            let hits = searches[&format!("{mode}:{query}")].as_array().unwrap();
            assert!(!hits.is_empty(), "{mode}:{query} found nothing");
            assert!(
                hits.iter().any(|hit| hit["snippet"]
                    .as_str()
                    .unwrap()
                    .to_lowercase()
                    .contains(&format!("[{spelled}]"))),
                "{mode}:{query} should highlight {spelled}"
            );
        }
    }
    // Typed with its macron, "nibbāna" still reaches "nirvana"'s group.
    assert_eq!(
        searches["exact:nibbāna"].as_array().unwrap().len(),
        searches["exact:nirvana"].as_array().unwrap().len()
    );

    let mut library = library_fixtures(&conn, &[folder.id]);
    library["search"] = Value::Object(Default::default());
    check_fixture("src/demo/library.json", &library);
    check_fixture(
        "src/test/fixtures/demo-search.json",
        &to_value(searches).unwrap(),
    );
    // The demo's TypeScript search expands terms the same way, so it
    // reads the same groups rather than keeping its own copy.
    check_fixture(
        "src/demo/variants.json",
        &to_value(VariantIndex::bundled().groups()).unwrap(),
    );
}

/// The library as the frontend reads it: books, every chapter's content,
/// and the given bookmark folders.
fn library_fixtures(conn: &Connection, folder_ids: &[i64]) -> serde_json::Value {
    use serde_json::{json, to_value, Map};
    use std::collections::BTreeMap;

    let books = list_books(conn).unwrap();
    let mut chapters = BTreeMap::new();
    let mut chapter_content = BTreeMap::new();
    for book in &books {
        let chs = get_book_chapters(conn, book.id).unwrap();
        for ch in &chs {
            let content = get_chapter_content(conn, ch.id).unwrap();
            chapter_content.insert(ch.id.to_string(), to_value(content).unwrap());
        }
        chapters.insert(book.id.to_string(), to_value(chs).unwrap());
    }
    let folder_bookmarks: Map<_, _> = folder_ids
        .iter()
        .map(|id| {
            let bookmarks = list_folder_bookmarks(conn, *id).unwrap();
            (id.to_string(), to_value(bookmarks).unwrap())
        })
        .collect();
    json!({
        "books": books,
        "chapters": chapters,
        "chapter_content": chapter_content,
        "bookmark_folders": list_bookmark_folders(conn).unwrap(),
        "folder_bookmarks": folder_bookmarks,
    })
}

/// Checks a committed JSON file (path relative to the repo root) matches
/// `value`, or rewrites it when `UPDATE_UI_FIXTURES=1`.
fn check_fixture(path: &str, value: &serde_json::Value) {
    let actual = serde_json::to_string_pretty(value).unwrap() + "\n";
    let full = format!("{}/../{path}", env!("CARGO_MANIFEST_DIR"));
    if std::env::var("UPDATE_UI_FIXTURES").as_deref() == Ok("1") {
        std::fs::write(&full, &actual).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(&full).unwrap_or_default();
    assert!(
        committed == actual,
        "{path} is out of date: run \
         UPDATE_UI_FIXTURES=1 cargo test -p ebook_research_core ui_fixtures"
    );
}
