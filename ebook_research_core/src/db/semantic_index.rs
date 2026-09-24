//! Semantic chapter search over `chunk_embeddings`: ranking chapters by
//! their best chunk, and finding the paragraph to open the reader at.
//! Indexing and query embedding need the model, behind the `semantic`
//! feature; the ranking here works on vectors alone.

use super::{get_chapter_content, ContentBlockRow};
use crate::semantic::{blob_to_vec, vec_to_blob};
use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;

#[cfg(feature = "semantic")]
use {
    super::get_book_chapters,
    crate::semantic::{chunks, is_indexable, Embedder, MODEL_REPO},
};

/// The score a chapter must reach to be returned at all. Cosine similarity
/// always ranks something first, so without a floor "No results" could
/// never happen. Picked on the evaluation sets in `tests/semantic_eval/`:
/// no off-corpus query scored above 0.622 on either the demo book or a
/// three-book library, while answered queries reached 0.59–0.84. It does
/// not reject plausible questions the books don't answer, which scored
/// 0.60–0.73; no floor separated those without emptying real answers.
pub const MIN_SCORE: f32 = 0.63;

/// How much a chapter's score drops per unit of `ln(chunks)` when ranking.
/// The best chunk of a 140-chunk chapter has 140 chances to score high, so
/// max-over-chunks favours long chapters; this can offset that. It only
/// reorders: the floor applies to the uncorrected score.
pub const LENGTH_PENALTY: f32 = 0.0;

/// A chapter's best-matching chunk for a query. Public only for the
/// evaluation runner in `tests/integration.rs`, which sweeps the floor and
/// the length penalty over [`rank_chunks`].
#[doc(hidden)]
#[derive(Debug, Clone, PartialEq)]
pub struct RankedChapter {
    pub chapter_id: i64,
    /// The best chunk's cosine similarity, before any length correction.
    pub score: f32,
    pub n_chunks: usize,
    pub char_start: usize,
    pub char_end: usize,
}

impl RankedChapter {
    fn corrected(&self, length_penalty: f32) -> f32 {
        self.score - length_penalty * (self.n_chunks as f32).ln()
    }
}

/// Scores every chapter by its single best chunk against `query`, a unit
/// vector, keeps those whose best chunk reaches `min_score`, and orders
/// them best first after subtracting `length_penalty × ln(chunks)`. The
/// best chunk rather than the mean: a long chapter's mean drifts towards
/// the corpus average while a short front-matter page stays sharp. Brute
/// force over every row; a large library is tens of thousands of chunks.
#[doc(hidden)]
pub fn rank_chunks(
    conn: &Connection,
    query: &[f32],
    min_score: f32,
    length_penalty: f32,
) -> Result<Vec<RankedChapter>> {
    let mut stmt =
        conn.prepare("SELECT chapter_id, char_start, char_end, dim, vec FROM chunk_embeddings")?;
    let mut rows = stmt.query([])?;
    let mut best: HashMap<i64, RankedChapter> = HashMap::new();
    while let Some(row) = rows.next()? {
        let chapter_id: i64 = row.get(0)?;
        let dim: i64 = row.get(3)?;
        let vec = blob_to_vec(row.get_ref(4)?.as_blob()?)?;
        if dim as usize != query.len() || vec.len() != query.len() {
            bail!(
                "chapter {chapter_id} has a {}-dim embedding (dim column {dim}), \
                 the query {}; it was indexed with a different model",
                vec.len(),
                query.len()
            );
        }
        let score: f32 = vec.iter().zip(query).map(|(a, b)| a * b).sum();
        let chapter = best.entry(chapter_id).or_insert(RankedChapter {
            chapter_id,
            score: f32::NEG_INFINITY,
            n_chunks: 0,
            char_start: 0,
            char_end: 0,
        });
        chapter.n_chunks += 1;
        if score > chapter.score {
            chapter.score = score;
            chapter.char_start = row.get::<_, i64>(1)? as usize;
            chapter.char_end = row.get::<_, i64>(2)? as usize;
        }
    }
    let mut ranked: Vec<RankedChapter> = best
        .into_values()
        .filter(|c| c.score >= min_score)
        .collect();
    ranked.sort_by(|a, b| {
        b.corrected(length_penalty)
            .total_cmp(&a.corrected(length_penalty))
    });
    Ok(ranked)
}

/// The id of the block containing `char_start`, an offset into the
/// chapter's blocks joined with `\n`. An offset on a separator belongs to
/// the block after it; one past the end, to the last block. `None` only
/// for a chapter with no blocks.
#[cfg_attr(not(feature = "semantic"), allow(dead_code))]
pub(crate) fn block_at(blocks: &[ContentBlockRow], char_start: usize) -> Option<i64> {
    let mut block_start = 0;
    for block in blocks {
        let block_end = block_start + block.text.chars().count();
        if char_start < block_end {
            return Some(block.id);
        }
        block_start = block_end + 1;
    }
    blocks.last().map(|b| b.id)
}

/// What [`index_book`] did with a book's chapters.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct IndexReport {
    /// Chapters that now have embeddings.
    pub chapters: usize,
    /// Chapters `is_indexable` turned away: contents pages, indexes and
    /// other near-empty front and back matter.
    pub skipped: usize,
    pub chunks: usize,
    /// Chunks longer than the model's 512 tokens, whose tails weren't
    /// embedded. Zero on this library; non-zero means a denser text than
    /// the chunk size assumes.
    pub truncated: usize,
}

/// One chunk ready to store: its char offsets in the chapter text and its
/// unit vector.
#[cfg_attr(not(feature = "semantic"), allow(dead_code))]
pub(crate) struct StoredChunk {
    pub char_start: usize,
    pub char_end: usize,
    pub vec: Vec<f32>,
}

/// Replaces a chapter's embeddings with `chunks` in one transaction, so an
/// indexing run stopped partway leaves every chapter either complete or
/// untouched, and indexing a chapter again doesn't duplicate its rows.
#[cfg_attr(not(feature = "semantic"), allow(dead_code))]
pub(crate) fn store_chapter(
    conn: &mut Connection,
    book_id: i64,
    chapter_id: i64,
    model: &str,
    chunks: &[StoredChunk],
) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM chunk_embeddings WHERE chapter_id = ?1",
        params![chapter_id],
    )?;
    {
        let mut insert = tx.prepare(
            "INSERT INTO chunk_embeddings
             (chapter_id, book_id, chunk_idx, char_start, char_end, model, dim, vec)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        for (idx, chunk) in chunks.iter().enumerate() {
            insert.execute(params![
                chapter_id,
                book_id,
                idx as i64,
                chunk.char_start as i64,
                chunk.char_end as i64,
                model,
                chunk.vec.len() as i64,
                vec_to_blob(&chunk.vec),
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Embeds a book's chapters for semantic search, replacing any embeddings
/// they already have. Run after the import has committed, never inside it:
/// at a quarter of a second per chunk a book takes minutes, and holding the
/// import's write lock that long would block the whole library. Each
/// chapter is embedded before its transaction opens and committed on its
/// own, so a run can be stopped at any point and keep what it finished.
/// `progress(done, total)` is called once before the first chapter and
/// after each one, skipped chapters included.
#[cfg(feature = "semantic")]
pub fn index_book(
    conn: &mut Connection,
    book_id: i64,
    embedder: &Embedder,
    progress: &mut dyn FnMut(usize, usize),
) -> Result<IndexReport> {
    let chapters = get_book_chapters(conn, book_id)?;
    let total = chapters.len();
    let mut report = IndexReport::default();
    progress(0, total);
    for (done, chapter) in chapters.iter().enumerate() {
        let texts: Vec<String> = get_chapter_content(conn, chapter.id)?
            .blocks
            .into_iter()
            .map(|block| block.text)
            .collect();
        if !is_indexable(&texts) {
            report.skipped += 1;
            progress(done + 1, total);
            continue;
        }
        // The same `\n` join `block_at` counts in.
        let text = texts.join("\n");
        let spans = chunks(&text);
        // Byte offsets of every char, and of the end, to slice by char.
        let bytes: Vec<usize> = text
            .char_indices()
            .map(|(i, _)| i)
            .chain([text.len()])
            .collect();
        let mut stored = Vec::with_capacity(spans.len());
        for batch in spans.chunks(EMBED_BATCH) {
            let slices: Vec<&str> = batch
                .iter()
                .map(|&(start, end)| &text[bytes[start]..bytes[end]])
                .collect();
            for (&(char_start, char_end), embedding) in
                batch.iter().zip(embedder.embed_batch(&slices)?)
            {
                report.truncated += usize::from(embedding.truncated);
                stored.push(StoredChunk {
                    char_start,
                    char_end,
                    vec: embedding.vec,
                });
            }
        }
        store_chapter(conn, book_id, chapter.id, MODEL_REPO, &stored)?;
        report.chapters += 1;
        report.chunks += stored.len();
        progress(done + 1, total);
    }
    Ok(report)
}

/// Chunks per forward pass. Batching doesn't speed up the CPU backend, so
/// this only bounds memory on a long chapter.
#[cfg(feature = "semantic")]
const EMBED_BATCH: usize = 8;

/// A chapter returned by [`search_chapters`]. Deliberately not a
/// `SearchResult`: there's no highlighted snippet, since nothing matched
/// word for word, and `score` is a similarity where higher is better, the
/// opposite of `bm25()`'s rank.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChapterMatch {
    pub book_id: i64,
    pub book_title: Option<String>,
    pub chapter_id: i64,
    pub chapter_idx: i64,
    pub chapter_title: Option<String>,
    /// The paragraph where the best-matching chunk starts, for the reader
    /// to open at: some chapters are whole book sections, and opening one
    /// at the top would land dozens of pages from the match.
    pub content_block_id: i64,
    pub score: f32,
    /// About the first 200 chars of the best-matching chunk, as plain text.
    pub preview: String,
}

/// Chapters whose meaning is closest to `query`, best first, at most
/// `limit` of them. Empty when nothing reaches [`MIN_SCORE`], so a query
/// the library doesn't answer says so instead of returning its nearest
/// miss.
#[cfg(feature = "semantic")]
pub fn search_chapters(
    conn: &Connection,
    query: &str,
    embedder: &Embedder,
    limit: i64,
) -> Result<Vec<ChapterMatch>> {
    let query = embedder.embed_query(query)?;
    let mut ranked = rank_chunks(conn, &query, MIN_SCORE, LENGTH_PENALTY)?;
    ranked.truncate(limit.max(0) as usize);
    chapter_matches(conn, &ranked)
}

/// Titles, the paragraph to open at and a preview for ranked chapters.
#[cfg_attr(not(feature = "semantic"), allow(dead_code))]
pub(crate) fn chapter_matches(
    conn: &Connection,
    ranked: &[RankedChapter],
) -> Result<Vec<ChapterMatch>> {
    let mut matches = Vec::with_capacity(ranked.len());
    for chapter in ranked {
        let content = get_chapter_content(conn, chapter.chapter_id)?;
        let book_title: Option<String> = conn.query_row(
            "SELECT title FROM books WHERE id = ?1",
            params![content.book_id],
            |row| row.get(0),
        )?;
        let Some(content_block_id) = block_at(&content.blocks, chapter.char_start) else {
            bail!("chapter {} has embeddings but no text", chapter.chapter_id);
        };
        let text = content
            .blocks
            .iter()
            .map(|block| block.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        matches.push(ChapterMatch {
            book_id: content.book_id,
            book_title,
            chapter_id: chapter.chapter_id,
            chapter_idx: content.chapter_idx,
            chapter_title: content.chapter_title,
            content_block_id,
            score: chapter.score,
            preview: preview(&text, chapter.char_start, chapter.char_end),
        });
    }
    Ok(matches)
}

#[cfg_attr(not(feature = "semantic"), allow(dead_code))]
const PREVIEW_CHARS: usize = 200;

/// Up to [`PREVIEW_CHARS`] of `text[char_start..char_end]`, counted in
/// chars, with whitespace collapsed. Chunks start and end mid-word, so a
/// partial first word is dropped, the end is cut back to a word boundary,
/// and an ellipsis marks each side that continues.
#[cfg_attr(not(feature = "semantic"), allow(dead_code))]
fn preview(text: &str, char_start: usize, char_end: usize) -> String {
    let chunk: Vec<char> = text
        .chars()
        .skip(char_start)
        .take(char_end.saturating_sub(char_start))
        .collect();
    let before = char_start.checked_sub(1).and_then(|i| text.chars().nth(i));
    let mut from = 0;
    if before.is_some_and(|c| !c.is_whitespace()) {
        from = chunk
            .iter()
            .position(|c| c.is_whitespace())
            .map_or(0, |i| i + 1);
    }
    let rest = &chunk[from..];
    let limit = rest.len().min(PREVIEW_CHARS);
    let after = match rest.get(limit) {
        Some(&c) => Some(c),
        None => text.chars().nth(char_start + chunk.len()),
    };
    let mut end = limit;
    if after.is_some_and(|c| !c.is_whitespace()) {
        end = rest[..limit]
            .iter()
            .rposition(|c| c.is_whitespace())
            .filter(|&i| i > 0)
            .unwrap_or(limit);
    }
    let body = &rest[..end];
    let cut = after.is_some();
    let body: String = body.iter().collect();
    let body = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let open = if before.is_some_and(|c| c != '\n') {
        "…"
    } else {
        ""
    };
    let close = if cut { "…" } else { "" };
    format!("{open}{body}{close}")
}

/// Whether semantic search can run, and how much of the library it covers.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SemanticStatus {
    /// False in a build without the `semantic` feature.
    pub available: bool,
    pub indexed_books: i64,
    pub total_books: i64,
}

/// Always compiled, so the frontend has one command to ask whether to
/// offer chapter search at all.
pub fn semantic_status(conn: &Connection) -> Result<SemanticStatus> {
    let (indexed_books, total_books) = conn.query_row(
        "SELECT (SELECT COUNT(DISTINCT book_id) FROM chunk_embeddings),
                (SELECT COUNT(*) FROM books)",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(SemanticStatus {
        available: cfg!(feature = "semantic"),
        indexed_books,
        total_books,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::import::load_book;
    use crate::db::*;
    use crate::epub::{ParsedBook, ParsedChapter};
    use crate::semantic::vec_to_blob;
    use rusqlite::params;

    /// A book with two chapters, returning its id and theirs.
    fn two_chapter_book(conn: &mut Connection) -> (i64, i64, i64) {
        let chapter = |title: &str| ParsedChapter {
            file_name: format!("{title}.xhtml"),
            title: title.to_string(),
            paragraphs: vec![(0, 9, "some text".to_string())],
        };
        let book = ParsedBook {
            title: Some("Book".to_string()),
            author: None,
            chapters: vec![chapter("One"), chapter("Two")],
        };
        let book_id = load_book(conn, "/book.epub", "h", &book).unwrap();
        let chapters = get_book_chapters(conn, book_id).unwrap();
        (book_id, chapters[0].id, chapters[1].id)
    }

    fn insert_chunks(conn: &Connection, book_id: i64, chapter_id: i64, vecs: &[[f32; 3]]) {
        for (i, vec) in vecs.iter().enumerate() {
            conn.execute(
                "INSERT INTO chunk_embeddings
                 (chapter_id, book_id, chunk_idx, char_start, char_end, model, dim, vec)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'test', 3, ?6)",
                params![
                    chapter_id,
                    book_id,
                    i as i64,
                    (i * 1400) as i64,
                    (i * 1400 + 1600) as i64,
                    vec_to_blob(vec)
                ],
            )
            .unwrap();
        }
    }

    #[test]
    fn max_over_chunks_picks_the_best_chapter() {
        let mut conn = open_db(":memory:").unwrap();
        let (book_id, sharp, steady) = two_chapter_book(&mut conn);
        // One chunk exactly on the query among two off it: mean 0.33, max 1.
        insert_chunks(
            &conn,
            book_id,
            sharp,
            &[[0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
        );
        // Every chunk close to it: mean and max both 0.9.
        insert_chunks(
            &conn,
            book_id,
            steady,
            &[[0.9, 0.435_89, 0.0], [0.9, 0.0, 0.435_89]],
        );

        let ranked = rank_chunks(&conn, &[1.0, 0.0, 0.0], MIN_SCORE, 0.0).unwrap();

        let ids: Vec<i64> = ranked.iter().map(|c| c.chapter_id).collect();
        assert_eq!(ids, vec![sharp, steady]);
        assert_eq!((ranked[0].score, ranked[0].n_chunks), (1.0, 3));
        assert_eq!((ranked[0].char_start, ranked[0].char_end), (1400, 3000));
        assert!((ranked[1].score - 0.9).abs() < 1e-6);
        assert_eq!((ranked[1].char_start, ranked[1].char_end), (0, 1600));
    }

    #[test]
    fn below_the_floor_returns_nothing() {
        let mut conn = open_db(":memory:").unwrap();
        let (book_id, one, two) = two_chapter_book(&mut conn);
        insert_chunks(&conn, book_id, one, &[[1.0, 0.0, 0.0]]);
        insert_chunks(&conn, book_id, two, &[[0.0, 1.0, 0.0], [0.6, 0.8, 0.0]]);

        assert_eq!(
            rank_chunks(&conn, &[0.0, 0.0, 1.0], MIN_SCORE, 0.0).unwrap(),
            vec![]
        );
        // 0.6 is under the floor, so only the chapter reaching it comes back.
        let ranked = rank_chunks(&conn, &[1.0, 0.0, 0.0], MIN_SCORE, 0.0).unwrap();
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].chapter_id, one);

        let err = rank_chunks(&conn, &[1.0, 0.0], MIN_SCORE, 0.0).expect_err("a 2-dim query");
        assert!(err.to_string().contains("different model"), "{err}");
    }

    #[test]
    fn the_length_penalty_reorders_but_never_empties() {
        let mut conn = open_db(":memory:").unwrap();
        let (book_id, short, long) = two_chapter_book(&mut conn);
        let near = |score: f32| [score, (1.0 - score * score).sqrt(), 0.0];
        insert_chunks(&conn, book_id, short, &[near(0.80)]);
        // Twenty chunks, one of them a shade better than the short chapter.
        let mut chunks = vec![near(0.70); 19];
        chunks.push(near(0.82));
        insert_chunks(&conn, book_id, long, &chunks);
        let order = |penalty: f32| -> Vec<i64> {
            rank_chunks(&conn, &[1.0, 0.0, 0.0], MIN_SCORE, penalty)
                .unwrap()
                .iter()
                .map(|c| c.chapter_id)
                .collect()
        };

        assert_eq!(order(0.0), vec![long, short]);
        // 0.82 − 0.01 × ln 20 = 0.79, under the short chapter's 0.80.
        assert_eq!(order(0.01), vec![short, long]);
        // The floor sees the uncorrected score: a penalty that drives the
        // corrected score under it still returns the chapter.
        assert_eq!(order(1.0), vec![short, long]);
        let ranked = rank_chunks(&conn, &[1.0, 0.0, 0.0], MIN_SCORE, 1.0).unwrap();
        assert!((ranked[1].score - 0.82).abs() < 1e-6);
        assert_eq!(ranked[1].n_chunks, 20);
    }

    #[test]
    fn a_match_opens_at_its_chunk_with_a_preview() {
        let mut conn = open_db(":memory:").unwrap();
        let paragraphs = ["Heading", "The first paragraph.", "The second one here."];
        let book = ParsedBook {
            title: Some("A Book".to_string()),
            author: None,
            chapters: vec![ParsedChapter {
                file_name: "c.xhtml".to_string(),
                title: "Chapter".to_string(),
                paragraphs: paragraphs
                    .iter()
                    .map(|p| (0, p.len(), p.to_string()))
                    .collect(),
            }],
        };
        let book_id = load_book(&mut conn, "/b.epub", "h", &book).unwrap();
        let content =
            get_chapter_content(&conn, get_book_chapters(&conn, book_id).unwrap()[0].id).unwrap();
        // "The second" starts at char 29 of the `\n`-joined text.
        let ranked = RankedChapter {
            chapter_id: content.chapter_id,
            score: 0.75,
            n_chunks: 1,
            char_start: 33,
            char_end: 49,
        };

        let matches = chapter_matches(&conn, &[ranked]).unwrap();

        assert_eq!(
            matches,
            vec![ChapterMatch {
                book_id,
                book_title: Some("A Book".to_string()),
                chapter_id: content.chapter_id,
                chapter_idx: 0,
                chapter_title: Some("Chapter".to_string()),
                content_block_id: content.blocks[2].id,
                score: 0.75,
                preview: "…second one here.".to_string(),
            }]
        );
    }

    #[test]
    fn previews_cut_at_word_boundaries() {
        // A whole chapter in one chunk, newlines flattened.
        assert_eq!(preview("One line.\nTwo.", 0, 14), "One line. Two.");
        // Mid-word at both ends: the partial words go, ellipses mark it.
        assert_eq!(preview("alpha beta gamma delta", 2, 13), "…beta…");
        // A chunk starting a paragraph has no leading ellipsis.
        assert_eq!(preview("alpha\nbeta gamma", 6, 16), "beta gamma");
        // Long chunks stop at the last word boundary within the limit.
        let text = "word ".repeat(100);
        let long = preview(&text, 0, 500);
        assert!(long.ends_with("word…"), "{long}");
        assert!(long.chars().count() <= PREVIEW_CHARS + 1, "{long}");
        // Diacritics are counted as chars, not bytes.
        assert_eq!(preview("saṃsāra paṭicca", 8, 15), "…paṭicca");
    }

    #[test]
    fn semantic_status_counts_indexed_books() {
        let mut conn = open_db(":memory:").unwrap();
        let (book_id, one, _) = two_chapter_book(&mut conn);
        let status = |conn: &Connection| semantic_status(conn).unwrap();
        assert_eq!(
            status(&conn),
            SemanticStatus {
                available: cfg!(feature = "semantic"),
                indexed_books: 0,
                total_books: 1,
            }
        );

        insert_chunks(&conn, book_id, one, &[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]);
        assert_eq!(status(&conn).indexed_books, 1);
    }

    #[test]
    fn block_at_finds_the_paragraph_for_an_offset() {
        let blocks: Vec<ContentBlockRow> = [10, 5, 20]
            .iter()
            .enumerate()
            .map(|(i, &len)| ContentBlockRow {
                id: 100 + i as i64,
                block_idx: i as i64,
                text: "ā".repeat(len),
            })
            .collect();
        // Chars 0–9, separator 10, 11–15, separator 16, 17–36.
        for (offset, id) in [
            (0, 100),
            (9, 100),
            (10, 101),
            (11, 101),
            (15, 101),
            (16, 102),
            (17, 102),
            (36, 102),
            (37, 102),
        ] {
            assert_eq!(block_at(&blocks, offset), Some(id), "offset {offset}");
        }
        assert_eq!(block_at(&[], 0), None);
    }

    #[test]
    fn storing_a_chapter_replaces_its_rows_atomically() {
        let mut conn = open_db(":memory:").unwrap();
        let (book_id, one, two) = two_chapter_book(&mut conn);
        let chunk = |char_start: usize, vec: [f32; 3]| StoredChunk {
            char_start,
            char_end: char_start + 1600,
            vec: vec.to_vec(),
        };
        let rows = |conn: &Connection, chapter_id: i64| -> Vec<(i64, i64, i64)> {
            conn.prepare(
                "SELECT chunk_idx, char_start, dim FROM chunk_embeddings
                 WHERE chapter_id = ?1 ORDER BY chunk_idx",
            )
            .unwrap()
            .query_map([chapter_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
        };

        let first = [chunk(0, [1.0, 0.0, 0.0]), chunk(1400, [0.0, 1.0, 0.0])];
        store_chapter(&mut conn, book_id, one, "test", &first).unwrap();
        store_chapter(&mut conn, book_id, two, "test", &first).unwrap();
        assert_eq!(rows(&conn, one), vec![(0, 0, 3), (1, 1400, 3)]);

        // Indexing again replaces the chapter's rows instead of adding to
        // them, and leaves the other chapter alone.
        store_chapter(
            &mut conn,
            book_id,
            one,
            "test",
            &[chunk(0, [0.0, 0.0, 1.0])],
        )
        .unwrap();
        assert_eq!(rows(&conn, one), vec![(0, 0, 3)]);
        assert_eq!(rows(&conn, two).len(), 2);

        // A write that fails partway rolls back the delete too: the missing
        // book fails the foreign key on insert, after the old rows went.
        let err = store_chapter(&mut conn, 999, one, "test", &first);
        assert!(err.is_err());
        assert_eq!(rows(&conn, one), vec![(0, 0, 3)]);
    }

    #[test]
    fn deleting_a_book_removes_its_embeddings() {
        let mut conn = open_db(":memory:").unwrap();
        let (book_id, one, two) = two_chapter_book(&mut conn);
        insert_chunks(&conn, book_id, one, &[[1.0, 0.0, 0.0]]);
        insert_chunks(&conn, book_id, two, &[[0.0, 1.0, 0.0]]);

        delete_book(&conn, book_id).unwrap();

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM chunk_embeddings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }
}
