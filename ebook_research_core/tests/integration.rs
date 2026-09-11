use ebook_research_core::{open_db, parse_epub, search, db};

#[test]
fn parses_and_indexes_and_searches() {
    let db_path = "/tmp/test_library.db";
    let _ = std::fs::remove_file(db_path);

    let parsed = parse_epub("test.epub").expect("parse failed");
    assert_eq!(parsed.title.as_deref(), Some("Test Book of Research"));
    assert!(parsed.chapters.len() >= 2, "expected at least 2 chapters, got {}", parsed.chapters.len());

    let total_paragraphs: usize = parsed.chapters.iter().map(|c| c.paragraphs.len()).sum();
    assert!(total_paragraphs >= 4, "expected at least 4 paragraphs, got {total_paragraphs}");

    let conn = open_db(db_path).expect("open_db failed");
    let book_id = db::load_book(&conn, "test.epub", &parsed).expect("load_book failed");
    assert!(book_id > 0);

    let results = search(&conn, "neural networks", 10).expect("search failed");
    assert!(!results.is_empty(), "expected search hits for 'neural networks'");
    assert!(results[0].snippet.contains('['), "snippet should contain highlight markers: {}", results[0].snippet);

    let results2 = search(&conn, "transformers OR attention", 10).expect("search failed");
    assert_eq!(results2.len(), 2, "expected 2 hits, got {:?}", results2);
}
