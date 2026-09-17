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

    // --- reader view read APIs ---
    let parsed_titles: Vec<&str> = parsed.chapters.iter().map(|c| c.title.as_str()).collect();
    assert!(parsed_titles.contains(&"Chapter One: Beginnings"), "titles: {parsed_titles:?}");
    assert!(parsed_titles.contains(&"Chapter Two: Deeper Waters"), "titles: {parsed_titles:?}");

    let books = db::list_books(&conn).expect("list_books failed");
    assert_eq!(books.len(), 1);
    assert_eq!(books[0].id, book_id);
    assert_eq!(books[0].chapter_count as usize, parsed.chapters.len());

    let chapters = db::get_book_chapters(&conn, book_id).expect("get_book_chapters failed");
    let db_titles: Vec<&str> = chapters.iter().map(|c| c.title.as_deref().unwrap()).collect();
    assert_eq!(db_titles, parsed_titles, "chapter titles should round-trip in idx order");

    for (ch, parsed_ch) in chapters.iter().zip(&parsed.chapters) {
        let content = db::get_chapter_content(&conn, ch.id).expect("get_chapter_content failed");
        assert_eq!(content.book_id, book_id);
        assert_eq!(content.chapter_idx, ch.idx);
        let texts: Vec<&str> = content.blocks.iter().map(|b| b.text.as_str()).collect();
        let expected: Vec<&str> = parsed_ch.paragraphs.iter().map(|(_, _, t)| t.as_str()).collect();
        assert_eq!(texts, expected, "blocks should come back in block_idx order");
    }

    let hit = &results[0];
    assert_eq!(hit.book_id, book_id);
    let hit_chapter = db::get_chapter_content(&conn, hit.chapter_id).expect("get_chapter_content failed");
    assert_eq!(hit_chapter.chapter_idx, hit.chapter_idx);
    assert!(
        hit_chapter.blocks.iter().any(|b| b.id == hit.content_block_id),
        "search hit's block should be in the chapter it points to"
    );
}
