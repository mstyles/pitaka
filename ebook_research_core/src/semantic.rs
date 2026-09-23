//! Semantic chapter search: cutting chapter text into chunks, deciding which
//! chapters are worth indexing, and storing vectors. All of this is pure
//! logic over text and bytes, compiled in every build; only the embedding
//! model itself sits behind the `semantic` feature.

use anyhow::{bail, Result};

/// The embedding model. It must ship F32 safetensors: `thenlper/gte-small`
/// ships F16 and collapses every vector into the same direction.
pub const MODEL_REPO: &str = "BAAI/bge-small-en-v1.5";

/// Prepended to queries, never to stored chunks. bge is asymmetric, and
/// leaving this off degrades results in a way that looks like a weak model.
pub const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";

/// Chunk length in chars, about 350 tokens, inside bge's 512-token window.
const CHUNK_CHARS: usize = 1600;
/// Chars shared by neighbouring chunks, so a sentence that straddles a
/// boundary is whole in one of them.
const CHUNK_OVERLAP: usize = 200;

/// Cuts `text` into overlapping chunks and returns their `(char_start,
/// char_end)` offsets, in chars rather than bytes so Pali diacritics can't
/// split. The last chunk ends at the text's char length.
pub fn chunks(text: &str) -> Vec<(usize, usize)> {
    let len = text.chars().count();
    let mut out = Vec::new();
    let mut start = 0;
    while start < len {
        let end = (start + CHUNK_CHARS).min(len);
        out.push((start, end));
        if end == len {
            break;
        }
        start += CHUNK_CHARS - CHUNK_OVERLAP;
    }
    out
}

/// Whether a chapter, given its blocks' text, is worth indexing. False for
/// dedications and half-titles (under 200 chars) and for list pages —
/// contents pages and indexes: at least 10 blocks, a median block under 40
/// chars, and fewer than 35% of blocks ending like a sentence. That last
/// clause keeps verse, whose short lines mostly do end in punctuation.
/// Front matter is keyword-dense, and a contents page otherwise outranks
/// the chapters it lists.
pub fn is_indexable(blocks: &[String]) -> bool {
    let chars: usize = blocks.iter().map(|b| b.chars().count()).sum();
    let separators = blocks.len().saturating_sub(1);
    if chars + separators < 200 {
        return false;
    }
    if blocks.len() < 10 {
        return true;
    }
    let mut lengths: Vec<usize> = blocks.iter().map(|b| b.trim().chars().count()).collect();
    lengths.sort_unstable();
    let median = lengths[lengths.len() / 2];
    let sentences = blocks.iter().filter(|b| ends_like_a_sentence(b)).count();
    let looks_like_a_list = median < 40 && sentences * 100 < blocks.len() * 35;
    !looks_like_a_list
}

fn ends_like_a_sentence(block: &str) -> bool {
    matches!(
        block.trim_end().chars().last(),
        Some('.' | ',' | ';' | ':' | '!' | '?' | '"' | '\'' | '”' | '’' | ')' | ']' | '»')
    )
}

/// A vector as a BLOB: its f32s, little-endian, 4 bytes each.
pub fn vec_to_blob(vec: &[f32]) -> Vec<u8> {
    vec.iter().flat_map(|x| x.to_le_bytes()).collect()
}

/// The inverse of [`vec_to_blob`].
pub fn blob_to_vec(blob: &[u8]) -> Result<Vec<f32>> {
    if !blob.len().is_multiple_of(4) {
        bail!(
            "an embedding BLOB must be a whole number of f32s, got {} bytes",
            blob.len()
        );
    }
    Ok(blob
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slice(text: &str, (start, end): (usize, usize)) -> String {
        text.chars().skip(start).take(end - start).collect()
    }

    #[test]
    fn chunks_cover_the_text_with_overlap() {
        assert_eq!(chunks(""), vec![]);
        assert_eq!(chunks(&"a".repeat(1600)), vec![(0, 1600)]);
        assert_eq!(chunks(&"a".repeat(3000)), vec![(0, 1600), (1400, 3000)]);

        let long = "b".repeat(10_000);
        let offsets = chunks(&long);
        assert_eq!(offsets[0].0, 0);
        assert_eq!(offsets.last().unwrap().1, 10_000);
        for pair in offsets.windows(2) {
            assert_eq!(pair[0].1 - pair[1].0, 200, "neighbours overlap: {pair:?}");
        }
        assert!(offsets.iter().all(|(s, e)| e - s <= 1600));

        // Multi-byte chars on every boundary: byte slicing would panic here.
        let pali = "saṃsāra paṭicca ".repeat(250);
        let len = pali.chars().count();
        let offsets = chunks(&pali);
        assert_eq!(offsets.last().unwrap().1, len);
        let first = slice(&pali, offsets[0]);
        assert_eq!(first.chars().count(), 1600);
        assert!(pali.starts_with(&first));
        let last = slice(&pali, *offsets.last().unwrap());
        assert!(pali.ends_with(&last));
    }

    #[test]
    fn contents_pages_are_not_indexable() {
        let blocks = |n: usize, text: &dyn Fn(usize) -> String| -> Vec<String> {
            (0..n).map(text).collect()
        };
        let contents = blocks(20, &|i| format!("Chapter {i:02} Right Effort I"));
        assert!(contents.iter().all(|b| b.chars().count() == 25));
        assert!(!is_indexable(&contents), "a contents page");

        let dedication = vec!["For my teachers, ".repeat(9)];
        assert!(dedication[0].chars().count() < 200);
        assert!(!is_indexable(&dedication), "a dedication");

        let prose = blocks(15, &|_| "word ".repeat(40));
        assert!(
            is_indexable(&prose),
            "a 3,000-char chapter of 200-char blocks"
        );

        let verse = blocks(20, &|i| match i % 4 {
            0 => "The mind is like a field,".to_string(),
            1 => "where every seed is sown.".to_string(),
            _ => "and every kind of seed is".to_string(),
        });
        assert!(verse.iter().all(|b| b.chars().count() == 25));
        assert!(
            is_indexable(&verse),
            "verse lines, half ending in punctuation"
        );
    }

    #[test]
    fn vectors_round_trip_as_blobs() {
        let vec = vec![
            0.0,
            -0.0,
            1.0,
            -1.5,
            f32::MIN_POSITIVE,
            0.123_456_79,
            f32::MAX,
        ];
        let blob = vec_to_blob(&vec);
        assert_eq!(blob.len(), vec.len() * 4);
        assert_eq!(&blob[8..12], &1.0f32.to_le_bytes());
        let back = blob_to_vec(&blob).unwrap();
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&back), bits(&vec));

        let err = blob_to_vec(&blob[..5]).expect_err("a truncated BLOB");
        assert!(err.to_string().contains("got 5 bytes"), "{err}");
    }
}
