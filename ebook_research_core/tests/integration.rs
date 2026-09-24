use ebook_research_core::{
    db, import_book, open_db, parse_epub, search, search_with_variants, ImportOutcome, SearchMode,
    VariantIndex,
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
        assert_eq!(version, 4);

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

/// A query term with a curated transliteration variant also finds the other
/// spelling. Uses its own variant list rather than the shipped one, so these
/// assertions don't move when `data/term_variants.txt` is edited.
#[test]
fn expands_transliteration_variants() {
    let db_path = "/tmp/test_library_variants.db";
    let _ = std::fs::remove_file(db_path);
    let mut conn = open_db(db_path).expect("open_db failed");
    import_book(&mut conn, "test.epub").expect("import failed");

    // "neuronal" appears nowhere in the book; "neural" does.
    let variants = VariantIndex::parse("neural, neuronal\n").unwrap();
    let empty = VariantIndex::parse("").unwrap();

    for mode in [SearchMode::Stemmed, SearchMode::Exact] {
        assert!(
            search_with_variants(&conn, "neuronal", mode, 10, &empty)
                .unwrap()
                .is_empty(),
            "{mode:?}: the book really doesn't contain \"neuronal\""
        );

        let neural = search_with_variants(&conn, "neural", mode, 10, &empty).unwrap();
        let neuronal = search_with_variants(&conn, "neuronal", mode, 10, &variants).unwrap();
        assert!(!neural.is_empty(), "{mode:?}");
        assert_eq!(
            neural
                .iter()
                .map(|r| r.content_block_id)
                .collect::<Vec<_>>(),
            neuronal
                .iter()
                .map(|r| r.content_block_id)
                .collect::<Vec<_>>(),
            "{mode:?}: the variant should find what the literal spelling finds"
        );

        // A term whose group matches nothing extra ranks exactly as before.
        let expanded = search_with_variants(&conn, "neural", mode, 10, &variants).unwrap();
        for (plain, exp) in neural.iter().zip(&expanded) {
            assert_eq!(plain.content_block_id, exp.content_block_id, "{mode:?}");
            assert_eq!(plain.rank, exp.rank, "{mode:?}: ranking must not shift");
            assert_eq!(plain.snippet, exp.snippet, "{mode:?}");
        }

        // A term with no group is untouched.
        let a = search_with_variants(&conn, "quincunx", mode, 10, &empty).unwrap();
        let b = search_with_variants(&conn, "quincunx", mode, 10, &variants).unwrap();
        assert_eq!(a.len(), b.len(), "{mode:?}");
        for (x, y) in a.iter().zip(&b) {
            assert_eq!(x.content_block_id, y.content_block_id, "{mode:?}");
            assert_eq!(x.rank, y.rank, "{mode:?}");
        }
    }

    // The same through the public `search`, against the shipped list: a term
    // that isn't listed behaves exactly as it always has.
    assert_eq!(
        search(&conn, "neural networks", SearchMode::Stemmed, 10)
            .unwrap()
            .len(),
        search_with_variants(&conn, "neural networks", SearchMode::Stemmed, 10, &empty)
            .unwrap()
            .len()
    );

    drop(conn);
    let _ = std::fs::remove_file(db_path);
}

/// The semantic search evaluation set for the demo book names chapters by
/// index and title; both must match the book, so a mislabelled query fails
/// here rather than silently scoring as a miss.
#[test]
fn semantic_eval_labels_name_real_chapters() {
    let eval: serde_json::Value =
        serde_json::from_str(include_str!("semantic_eval/demo.json")).unwrap();
    let book = parse_epub("../demo/verses-of-the-senior-nuns.epub").expect("parse failed");
    let queries = eval["queries"].as_array().unwrap();
    assert!(queries.len() >= 30, "{} queries", queries.len());
    for q in queries {
        let query = q["query"].as_str().unwrap();
        let relevant = q["relevant"].as_array().unwrap();
        match q["kind"].as_str().unwrap() {
            "answered" => assert!(!relevant.is_empty(), "{query}: no relevant chapters"),
            "unanswered" | "off_corpus" => assert!(relevant.is_empty(), "{query}"),
            kind => panic!("{query}: unknown kind {kind}"),
        }
        for chapter in relevant {
            let idx = chapter["chapter_idx"].as_u64().unwrap() as usize;
            let title = chapter["title"].as_str().unwrap();
            assert_eq!(book.chapters[idx].title, title, "{query}: chapter {idx}");
            assert!(matches!(chapter["grade"].as_u64(), Some(1 | 2)), "{query}");
        }
    }
}

/// The spike's sanity probe. A model can load cleanly, pass every
/// structural test and still be useless: gte-small, loaded from F16
/// weights, scored anger against quantum physics at 0.95 and returned the
/// same five chunks for every query. This is the test that catches that.
/// Passages are embedded as stored, without the query prefix, which is how
/// the spike measured them. Re-run it whenever `MODEL_REPO` changes.
#[cfg(feature = "semantic")]
#[test]
#[ignore = "downloads the embedding model"]
fn the_model_discriminates_unrelated_text() {
    use ebook_research_core::semantic::Embedder;

    let embedder = Embedder::load().expect("load failed");
    let texts = [
        "how to work with anger",
        "a practice for calming anger and irritation",
        "grief after a death in the family",
        "quantum chromodynamics and the strong nuclear force",
        "the recipe calls for two cups of flour",
    ];
    let vecs: Vec<Vec<f32>> = embedder
        .embed_batch(&texts)
        .unwrap()
        .into_iter()
        .map(|e| e.vec)
        .collect();
    let dot = |a: &[f32], b: &[f32]| -> f32 { a.iter().zip(b).map(|(x, y)| x * y).sum() };
    for vec in &vecs {
        assert!(
            (dot(vec, vec) - 1.0).abs() < 1e-4,
            "vectors are unit length"
        );
    }
    let [anger, practice, _grief, physics, recipe] = [0, 1, 2, 3, 4].map(|i| &vecs[i]);
    let related = dot(anger, practice);
    // bge-small: 0.823 against 0.495 and 0.439.
    assert!(related > dot(anger, physics) + 0.2, "{related} vs physics");
    assert!(related > dot(anger, recipe) + 0.2, "{related} vs recipe");

    // These five sentences only: over a real library's chunks, bge's mean
    // vector has norm 0.835, so this threshold says nothing about a corpus.
    let mean: Vec<f32> = (0..vecs[0].len())
        .map(|d| vecs.iter().map(|v| v[d]).sum::<f32>() / vecs.len() as f32)
        .collect();
    let norm = dot(&mean, &mean).sqrt();
    assert!(
        norm < 0.85,
        "mean vector norm {norm} (bge: 0.79, gte-small: 0.99)"
    );

    // Batched and single embeddings agree, so padding doesn't leak in.
    let single = embedder.embed(texts[3]).unwrap();
    assert!(dot(&single.vec, physics) > 0.9999);
    assert!(!single.truncated);
    assert!(embedder.embed(&"word ".repeat(700)).unwrap().truncated);
}

/// Indexes the demo book end to end: every chapter is embedded or skipped,
/// progress counts up to the chapter total, the rows carry the model and
/// its dimension, and indexing again replaces rows rather than adding them.
/// The demo book, not `test.epub`, whose chapters are too short to index.
#[cfg(feature = "semantic")]
#[test]
#[ignore = "downloads the embedding model"]
fn indexes_a_book_for_semantic_search() {
    use ebook_research_core::{index_book, semantic::Embedder, semantic::MODEL_REPO};

    let mut conn = open_db(":memory:").unwrap();
    let book_id = import_book(&mut conn, "../demo/verses-of-the-senior-nuns.epub")
        .unwrap()
        .book_id;
    let chapters = db::get_book_chapters(&conn, book_id).unwrap().len();
    let embedder = Embedder::load().expect("load failed");

    let mut calls = Vec::new();
    let started = std::time::Instant::now();
    let report = index_book(&mut conn, book_id, &embedder, &mut |done, total| {
        calls.push((done, total))
    })
    .unwrap();

    eprintln!("{report:?} in {:.1?}", started.elapsed());
    assert_eq!(report.chapters + report.skipped, chapters, "{report:?}");
    // Chapter 2 is a single verse, under the length floor.
    assert!(report.chapters > 0 && report.skipped > 0, "{report:?}");
    assert_eq!(report.truncated, 0, "{report:?}");
    let expected: Vec<(usize, usize)> = (0..=chapters).map(|done| (done, chapters)).collect();
    assert_eq!(calls, expected);

    let rows = |conn: &Connection| -> (usize, i64, String) {
        conn.query_row(
            "SELECT COUNT(*), MIN(dim), MIN(model) FROM chunk_embeddings WHERE book_id = ?1",
            [book_id],
            |r| Ok((r.get::<_, i64>(0)? as usize, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    };
    assert_eq!(rows(&conn), (report.chunks, 384, MODEL_REPO.to_string()));

    let again = index_book(&mut conn, book_id, &embedder, &mut |_, _| {}).unwrap();
    assert_eq!(again, report);
    assert_eq!(rows(&conn).0, report.chunks);
}

/// A thematic query that appears nowhere in the book word for word finds
/// the chapter about it, and the match opens at a paragraph of that
/// chapter. The demo book, since `test.epub`'s chapters are too short to
/// index; found by title, not index.
#[cfg(feature = "semantic")]
#[test]
#[ignore = "downloads the embedding model"]
fn semantic_search_finds_a_chapter_by_meaning() {
    use ebook_research_core::semantic::Embedder;
    use ebook_research_core::{search_chapters, MIN_SCORE};

    let embedder = Embedder::load().expect("load failed");
    let db_path =
        semantic_eval::indexed_copy("demo", semantic_eval::DEMO_EPUB, &embedder, |dest| {
            let mut conn = open_db(dest).unwrap();
            import_book(&mut conn, semantic_eval::DEMO_EPUB).unwrap();
        });
    let conn = open_db(db_path.to_str().unwrap()).unwrap();
    let query = "growing old and the body losing its beauty";

    let matches = search_chapters(&conn, query, &embedder, 10).unwrap();

    for m in &matches {
        eprintln!("{:.3} {:?}: {}", m.score, m.chapter_title, m.preview);
    }
    let top = &matches[0];
    assert_eq!(
        top.chapter_title.as_deref(),
        Some("The Book of the Twenties")
    );
    assert_eq!(top.book_title.as_deref(), Some("Verses of the Senior Nuns"));
    assert!(matches.iter().all(|m| m.score >= MIN_SCORE));
    assert!(matches.windows(2).all(|w| w[0].score >= w[1].score));
    let content = db::get_chapter_content(&conn, top.chapter_id).unwrap();
    let text: String = content
        .blocks
        .iter()
        .map(|b| b.text.to_lowercase())
        .collect();
    assert!(!text.contains(query), "the query is in the text verbatim");
    assert!(
        content.blocks.iter().any(|b| b.id == top.content_block_id),
        "opens at a paragraph of the chapter"
    );
    let preview = top.preview.trim_matches('…');
    assert!(!preview.is_empty() && preview.len() < 300, "{preview:?}");
    let first_word = preview.split_whitespace().next().unwrap();
    assert!(text.contains(&first_word.to_lowercase()), "{preview:?}");

    // A query the book has nothing to do with returns nothing at all.
    assert_eq!(
        search_chapters(&conn, "configuring a Kubernetes cluster", &embedder, 10).unwrap(),
        vec![]
    );
}

/// The §8 evaluation runner. Indexes the demo book, and the library named
/// by `PITAKA_EVAL_DB` against `semantic_eval/local/library.json` when it's
/// set, then scores every labelled query: recall@5 and nDCG@10 over the
/// answered ones, and how often a query the books don't answer correctly
/// comes back empty. Prints each query's top score and the sweeps that
/// chose `MIN_SCORE` and `LENGTH_PENALTY`, and fails below the bars.
///
/// Indexing a library takes minutes, so each indexed copy is kept under
/// the target dir and reused while it's newer than its source; delete
/// `target/tmp/semantic_eval` after changing chunking or the model.
#[cfg(feature = "semantic")]
#[test]
#[ignore = "downloads the embedding model and indexes for minutes"]
fn semantic_eval() {
    use ebook_research_core::semantic::Embedder;
    use ebook_research_core::{LENGTH_PENALTY, MIN_SCORE};
    use semantic_eval::*;

    let embedder = Embedder::load().expect("load failed");

    let demo_db = indexed_copy("demo", DEMO_EPUB, &embedder, |dest| {
        let mut conn = open_db(dest).unwrap();
        import_book(&mut conn, DEMO_EPUB).unwrap();
    });
    let demo = EvalSet::load(
        "demo",
        demo_db,
        include_str!("semantic_eval/demo.json"),
        &embedder,
    );
    let demo_score = demo.report(MIN_SCORE, LENGTH_PENALTY);
    // The bars are the first run's numbers at MIN_SCORE 0.63, so a later
    // change can't quietly regress them. They're below the plan's proposed
    // 0.70 and 0.60: the floor rejects off-corpus queries but not plausible
    // unanswered ones, and this book's scores sit about 0.06 under the
    // library's, so five answered queries fall under it. Chapter 2 is a
    // deliberate miss: one verse, under the length floor, never indexed.
    demo_score.assert_at_least(&Bars {
        recall_at_5: 0.48,
        ndcg_at_10: 0.49,
        no_answer_accuracy: 0.50,
        max_emptied: 5,
        max_required_missed: 0,
    });

    let Ok(source) = std::env::var("PITAKA_EVAL_DB") else {
        eprintln!("PITAKA_EVAL_DB not set; skipping the local library set");
        return;
    };
    let library_db = indexed_copy("library", &source, &embedder, |dest| {
        let src = Connection::open_with_flags(&source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
        src.execute("VACUUM INTO ?1", [dest]).unwrap();
    });
    let labels = std::fs::read_to_string("tests/semantic_eval/local/library.json")
        .expect("PITAKA_EVAL_DB is set but tests/semantic_eval/local/library.json is missing");
    let library = EvalSet::load("library", library_db, &labels, &embedder);
    let library_score = library.report(MIN_SCORE, LENGTH_PENALTY);
    // The first run's numbers at MIN_SCORE 0.63. The bare term "anatta"
    // misses the chapter using it most; single Pali terms are keyword
    // search's job.
    library_score.assert_at_least(&Bars {
        recall_at_5: 0.52,
        ndcg_at_10: 0.54,
        no_answer_accuracy: 0.52,
        max_emptied: 1,
        max_required_missed: 1,
    });
}

#[cfg(feature = "semantic")]
mod semantic_eval {
    use ebook_research_core::semantic::Embedder;
    use ebook_research_core::{db, index_book, open_db};
    use rusqlite::Connection;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    pub const DEMO_EPUB: &str = "../demo/verses-of-the-senior-nuns.epub";
    const FLOORS: [f32; 21] = [
        0.60, 0.61, 0.62, 0.63, 0.64, 0.65, 0.66, 0.67, 0.68, 0.69, 0.70, 0.71, 0.72, 0.73, 0.74,
        0.75, 0.76, 0.77, 0.78, 0.79, 0.80,
    ];
    const PENALTIES: [f32; 4] = [0.0, 0.005, 0.01, 0.02];

    /// A library DB with every book indexed, built by `create` (which
    /// writes an unindexed DB to the path it's given) and cached until
    /// `source` changes.
    pub fn indexed_copy(
        name: &str,
        source: &str,
        embedder: &Embedder,
        create: impl FnOnce(&str),
    ) -> PathBuf {
        let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("semantic_eval");
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join(format!("{name}.db"));
        let done = dir.join(format!("{name}.indexed"));
        let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        if modified(&done) > modified(Path::new(source)) {
            eprintln!("{name}: reusing the indexed copy at {}", db_path.display());
            return db_path;
        }
        let _ = std::fs::remove_file(&done);
        let _ = std::fs::remove_file(&db_path);
        create(db_path.to_str().unwrap());
        let mut conn = open_db(db_path.to_str().unwrap()).unwrap();
        for book in db::list_books(&conn).unwrap() {
            let started = std::time::Instant::now();
            let report = index_book(&mut conn, book.id, embedder, &mut |_, _| {}).unwrap();
            eprintln!(
                "{name}: indexed {:?} in {:.0?}: {report:?}",
                book.title,
                started.elapsed()
            );
            assert_eq!(report.truncated, 0, "{:?}", book.title);
        }
        std::fs::write(&done, "").unwrap();
        db_path
    }

    struct Query {
        text: String,
        kind: String,
        pali: bool,
        /// chapter id → grade
        relevant: HashMap<i64, u32>,
        required_in_top_5: Vec<i64>,
        vec: Vec<f32>,
    }

    pub struct EvalSet {
        name: String,
        conn: Connection,
        queries: Vec<Query>,
        /// chapter id → a short label, for printing
        labels: HashMap<i64, String>,
    }

    pub struct Bars {
        pub recall_at_5: f64,
        pub ndcg_at_10: f64,
        pub no_answer_accuracy: f64,
        pub max_emptied: usize,
        pub max_required_missed: usize,
    }

    #[derive(Debug, Default)]
    pub struct Score {
        name: String,
        recall_at_5: f64,
        ndcg_at_10: f64,
        pali_recall_at_5: f64,
        /// Unanswered and off-corpus queries that came back empty.
        no_answer_correct: usize,
        no_answer_total: usize,
        /// Off-corpus queries that leaked through the floor; always a bar.
        off_corpus_leaked: usize,
        /// Answered queries the floor emptied.
        emptied: usize,
        required_missed: Vec<String>,
    }

    impl Score {
        fn no_answer_accuracy(&self) -> f64 {
            self.no_answer_correct as f64 / self.no_answer_total.max(1) as f64
        }

        pub fn assert_at_least(&self, bars: &Bars) {
            let failures: Vec<String> = [
                (self.recall_at_5 < bars.recall_at_5)
                    .then(|| format!("recall@5 {:.3} < {}", self.recall_at_5, bars.recall_at_5)),
                (self.ndcg_at_10 < bars.ndcg_at_10)
                    .then(|| format!("nDCG@10 {:.3} < {}", self.ndcg_at_10, bars.ndcg_at_10)),
                (self.no_answer_accuracy() < bars.no_answer_accuracy).then(|| {
                    format!(
                        "no-answer accuracy {:.3} < {}",
                        self.no_answer_accuracy(),
                        bars.no_answer_accuracy
                    )
                }),
                (self.emptied > bars.max_emptied).then(|| {
                    format!(
                        "{} answered queries emptied > {}",
                        self.emptied, bars.max_emptied
                    )
                }),
                (self.required_missed.len() > bars.max_required_missed)
                    .then(|| format!("required chapters missed: {:?}", self.required_missed)),
                (self.off_corpus_leaked > 0).then(|| {
                    format!(
                        "{} off-corpus queries returned results",
                        self.off_corpus_leaked
                    )
                }),
            ]
            .into_iter()
            .flatten()
            .collect();
            assert!(failures.is_empty(), "{}: {failures:?}", self.name);
        }
    }

    impl EvalSet {
        pub fn load(name: &str, db_path: PathBuf, json: &str, embedder: &Embedder) -> Self {
            let conn = open_db(db_path.to_str().unwrap()).unwrap();
            let eval: serde_json::Value = serde_json::from_str(json).unwrap();
            let books = db::list_books(&conn).unwrap();
            let chapter_id = |book: Option<&str>, idx: u64| -> i64 {
                let book = match book {
                    Some(title) => books
                        .iter()
                        .find(|b| b.title.as_deref() == Some(title))
                        .unwrap_or_else(|| panic!("{name}: no book {title:?}")),
                    None => {
                        assert_eq!(books.len(), 1, "{name}: label names no book");
                        &books[0]
                    }
                };
                db::get_book_chapters(&conn, book.id)
                    .unwrap()
                    .iter()
                    .find(|c| c.idx == idx as i64)
                    .unwrap_or_else(|| panic!("{name}: {:?} has no chapter {idx}", book.title))
                    .id
            };
            let label_id = |label: &serde_json::Value| {
                chapter_id(
                    label["book"].as_str(),
                    label["chapter_idx"].as_u64().unwrap(),
                )
            };
            let queries = eval["queries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|q| {
                    let text = q["query"].as_str().unwrap().to_string();
                    Query {
                        vec: embedder.embed_query(&text).unwrap(),
                        text,
                        kind: q["kind"].as_str().unwrap().to_string(),
                        pali: q["pali"].as_bool().unwrap_or(false),
                        relevant: q["relevant"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|r| (label_id(r), r["grade"].as_u64().unwrap() as u32))
                            .collect(),
                        required_in_top_5: q["required_in_top_5"]
                            .as_array()
                            .map(|a| a.iter().map(label_id).collect())
                            .unwrap_or_default(),
                    }
                })
                .collect();
            let mut labels = HashMap::new();
            for (i, book) in books.iter().enumerate() {
                for chapter in db::get_book_chapters(&conn, book.id).unwrap() {
                    let prefix = if books.len() > 1 {
                        format!("B{i}:")
                    } else {
                        String::new()
                    };
                    labels.insert(chapter.id, format!("{prefix}{}", chapter.idx));
                }
            }
            EvalSet {
                name: name.to_string(),
                conn,
                queries,
                labels,
            }
        }

        /// Every chapter for every query, ranked with `penalty`, unfloored.
        fn rank_all(&self, penalty: f32) -> Vec<Vec<db::RankedChapter>> {
            self.queries
                .iter()
                .map(|q| db::rank_chunks(&self.conn, &q.vec, f32::NEG_INFINITY, penalty).unwrap())
                .collect()
        }

        fn score(&self, ranked: &[Vec<db::RankedChapter>], floor: f32) -> Score {
            let mut score = Score {
                name: self.name.clone(),
                ..Score::default()
            };
            let (mut answered, mut pali) = (0, 0);
            for (q, ranked) in self.queries.iter().zip(ranked) {
                let kept: Vec<i64> = ranked
                    .iter()
                    .filter(|c| c.score >= floor)
                    .map(|c| c.chapter_id)
                    .collect();
                if q.kind != "answered" {
                    score.no_answer_total += 1;
                    score.no_answer_correct += usize::from(kept.is_empty());
                    if q.kind == "off_corpus" {
                        score.off_corpus_leaked += usize::from(!kept.is_empty());
                    }
                    continue;
                }
                answered += 1;
                score.emptied += usize::from(kept.is_empty());
                let top5 = &kept[..kept.len().min(5)];
                let hits = top5.iter().filter(|id| q.relevant.contains_key(id)).count();
                let recall = hits as f64 / q.relevant.len().min(5) as f64;
                score.recall_at_5 += recall;
                if q.pali {
                    pali += 1;
                    score.pali_recall_at_5 += recall;
                }
                let gain = |grade: u32| f64::from((1 << grade) - 1);
                let dcg: f64 = kept
                    .iter()
                    .take(10)
                    .enumerate()
                    .map(|(i, id)| {
                        gain(*q.relevant.get(id).unwrap_or(&0)) / (i as f64 + 2.0).log2()
                    })
                    .sum();
                let mut ideal: Vec<u32> = q.relevant.values().copied().collect();
                ideal.sort_unstable_by(|a, b| b.cmp(a));
                let idcg: f64 = ideal
                    .iter()
                    .take(10)
                    .enumerate()
                    .map(|(i, &g)| gain(g) / (i as f64 + 2.0).log2())
                    .sum();
                score.ndcg_at_10 += dcg / idcg;
                for id in &q.required_in_top_5 {
                    if !top5.contains(id) {
                        score
                            .required_missed
                            .push(format!("{}: {}", q.text, self.labels[id]));
                    }
                }
            }
            score.recall_at_5 /= answered.max(1) as f64;
            score.ndcg_at_10 /= answered.max(1) as f64;
            score.pali_recall_at_5 /= pali.max(1) as f64;
            score
        }

        /// Prints each query's results and both sweeps, and returns the
        /// score at `floor` and `penalty`.
        pub fn report(&self, floor: f32, penalty: f32) -> Score {
            let ranked = self.rank_all(penalty);
            eprintln!(
                "\n== {}: floor {floor}, length penalty {penalty} ==",
                self.name
            );
            eprintln!("kind        top1   top 5 (grade, * = relevant)  query");
            for (q, ranked) in self.queries.iter().zip(&ranked) {
                let top1 = ranked.iter().map(|c| c.score).fold(f32::MIN, f32::max);
                let top5: Vec<String> = ranked
                    .iter()
                    .filter(|c| c.score >= floor)
                    .take(5)
                    .map(|c| match q.relevant.get(&c.chapter_id) {
                        Some(g) => format!("{}*{g}", self.labels[&c.chapter_id]),
                        None => self.labels[&c.chapter_id].clone(),
                    })
                    .collect();
                let flag = match (q.kind.as_str(), top1 >= floor) {
                    ("answered", false) => "EMPTIED",
                    ("answered", true) => "",
                    (_, true) => "LEAKED",
                    (_, false) => "",
                };
                eprintln!(
                    "{:<11} {top1:.3}  {:<28} {}  {flag}",
                    q.kind,
                    top5.join(" "),
                    q.text
                );
            }

            eprintln!("\nfloor  no-answer  emptied  recall@5  nDCG@10  (penalty {penalty})");
            for f in FLOORS {
                let s = self.score(&ranked, f);
                eprintln!(
                    "{f:.2}   {:>2}/{:<2}      {:>2}       {:.3}     {:.3}",
                    s.no_answer_correct, s.no_answer_total, s.emptied, s.recall_at_5, s.ndcg_at_10
                );
            }

            eprintln!("\npenalty  recall@5  nDCG@10  pali recall@5  (floor {floor})  most frequent top-5 chapters (chunks)");
            for p in PENALTIES {
                let ranked = self.rank_all(p);
                let s = self.score(&ranked, floor);
                let mut counts: HashMap<i64, (usize, usize)> = HashMap::new();
                for (q, r) in self.queries.iter().zip(&ranked) {
                    if q.kind == "answered" {
                        for c in r.iter().filter(|c| c.score >= floor).take(5) {
                            counts.entry(c.chapter_id).or_insert((0, c.n_chunks)).0 += 1;
                        }
                    }
                }
                let mut counts: Vec<_> = counts.into_iter().collect();
                counts.sort_by_key(|&(_, (n, _))| std::cmp::Reverse(n));
                let frequent: Vec<String> = counts
                    .iter()
                    .take(4)
                    .map(|(id, (n, chunks))| format!("{}×{n} ({chunks})", self.labels[id]))
                    .collect();
                eprintln!(
                    "{p:<7}  {:.3}     {:.3}    {:.3}          {}",
                    s.recall_at_5,
                    s.ndcg_at_10,
                    s.pali_recall_at_5,
                    frequent.join(", ")
                );
            }

            let score = self.score(&ranked, floor);
            eprintln!("\n{score:?}");
            score
        }
    }
}
