//! Full-text search: building FTS5 queries (with transliteration variants)
//! and running them.

use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Serialize, Debug)]
pub struct SearchResult {
    pub book_id: i64,
    pub book_title: Option<String>,
    pub chapter_id: i64,
    pub chapter_idx: i64,
    pub chapter_title: Option<String>,
    pub block_idx: i64,
    pub content_block_id: i64,
    pub snippet: String,
    pub rank: f64,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    /// Porter-stemmed: "learning" also matches "learn" and "learns".
    Stemmed,
    /// Whole words as typed. Case and diacritics are still ignored.
    Exact,
}

impl SearchMode {
    fn fts_table(self) -> &'static str {
        match self {
            SearchMode::Stemmed => "content_fts",
            SearchMode::Exact => "content_fts_exact",
        }
    }
}

/// Folds a term to the form the variant list is written in: lowercase ASCII.
/// Combining marks (so decomposed input folds too) are dropped, and the
/// precomposed letters used to transliterate Pali and Sanskrit are mapped to
/// their plain letter.
///
/// This is deliberately a small table rather than full Unicode normalisation:
/// it only decides whether a term *has* a variant group. A letter it doesn't
/// know means the query isn't expanded, never that the search breaks — FTS5
/// folds the text itself with `remove_diacritics 2`.
fn fold_term(term: &str) -> String {
    term.to_lowercase()
        .chars()
        .filter(|c| !('\u{0300}'..='\u{036F}').contains(c))
        .map(|c| match c {
            'ā' => 'a',
            'ī' => 'i',
            'ū' => 'u',
            'ṛ' | 'ṝ' => 'r',
            'ḷ' | 'ḹ' => 'l',
            'ē' => 'e',
            'ō' => 'o',
            'ṅ' | 'ñ' | 'ṇ' => 'n',
            'ṭ' => 't',
            'ḍ' => 'd',
            'ś' | 'ṣ' => 's',
            'ṃ' | 'ṁ' => 'm',
            'ḥ' => 'h',
            c => c,
        })
        .collect()
}

/// Curated groups of terms that mean the same thing but are spelled
/// differently across traditions ("dhamma" in Pali, "dharma" in Sanskrit).
/// Searching any term in a group also searches the rest of it.
#[derive(Debug)]
pub struct VariantIndex {
    groups: Vec<Vec<String>>,
    /// Folded term -> its index in `groups`.
    by_term: HashMap<String, usize>,
}

impl VariantIndex {
    /// Parses the variant list: one group per line, terms separated by
    /// commas, `#` starting a comment, blank lines ignored. Terms are folded
    /// with [`fold_term`], and a line with fewer than two of them is skipped
    /// since it can't expand to anything.
    pub fn parse(text: &str) -> Result<Self> {
        let mut groups: Vec<Vec<String>> = Vec::new();
        let mut by_term = HashMap::new();
        for (n, line) in text.lines().enumerate() {
            let line = line.split('#').next().unwrap_or_default();
            let terms: Vec<String> = line
                .split(',')
                .map(|t| fold_term(t.trim()))
                .filter(|t| !t.is_empty())
                .collect();
            if terms.len() < 2 {
                continue;
            }
            for term in &terms {
                if by_term.insert(term.clone(), groups.len()).is_some() {
                    bail!("line {}: \"{term}\" appears in two variant groups", n + 1);
                }
            }
            groups.push(terms);
        }
        Ok(Self { groups, by_term })
    }

    /// The list shipped with the app, `data/term_variants.txt`. It's embedded
    /// at compile time and parsed by `bundled_variants_parse`, so a malformed
    /// file fails the build's tests rather than reaching a user.
    pub fn bundled() -> &'static VariantIndex {
        static BUNDLED: OnceLock<VariantIndex> = OnceLock::new();
        BUNDLED.get_or_init(|| {
            VariantIndex::parse(include_str!("../../data/term_variants.txt"))
                .expect("bundled data/term_variants.txt is malformed")
        })
    }

    /// The group `term` belongs to, including `term` itself, or `None`.
    fn group_for(&self, term: &str) -> Option<&[String]> {
        let idx = *self.by_term.get(&fold_term(term))?;
        Some(&self.groups[idx])
    }

    /// Every group, for mirroring the list into the browser demo.
    pub fn groups(&self) -> &[Vec<String>] {
        &self.groups
    }
}

/// One operand or operator of a built FTS5 query.
enum Part {
    /// A quoted term or phrase, e.g. `"dharma"` or `"neural nets"*`.
    Term(String),
    /// A parenthesised variant group, e.g. `("dhamma" OR "dharma")`.
    Group(String),
    /// `AND`, `OR` or `NOT`, as the user typed it.
    Op(String),
}

impl Part {
    fn text(&self) -> &str {
        match self {
            Part::Term(s) | Part::Group(s) | Part::Op(s) => s,
        }
    }
}

/// Turns a user's search box text into a valid FTS5 query. Every word is
/// wrapped in double quotes, so punctuation (`don't`, `self-aware`, `a.b`)
/// is left to the tokenizer instead of being parsed as FTS5 syntax. Kept:
/// "quoted phrases", a trailing `*` for prefix search, and uppercase
/// AND/OR/NOT between two terms. Anything else FTS5 would treat as syntax
/// (parentheses, `NEAR`, `column:`) is searched as text.
///
/// A plain word listed in `variants` becomes a parenthesised `OR` group of
/// its whole group, so "dharma" also matches "dhamma" and both are ranked by
/// one `bm25()` call. Phrases and prefix terms are left alone: a prefix would
/// need its `*` on every member and can't be known to mean the whole word,
/// and a phrase has no single term to look up.
///
/// Returns `None` if there's nothing to search for.
fn to_fts_query(query: &str, variants: &VariantIndex) -> Option<String> {
    let mut parts: Vec<Part> = Vec::new();
    let mut last_is_term = false;
    let mut chars = query.chars().peekable();

    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }

        let (text, is_phrase) = if c == '"' && query_has_closing_quote(&chars) {
            chars.next();
            let phrase: String = chars.by_ref().take_while(|&c| c != '"').collect();
            (phrase, true)
        } else {
            let mut word = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() || (c == '"' && query_has_closing_quote(&chars)) {
                    break;
                }
                word.push(c);
                chars.next();
            }
            (word, false)
        };

        if !is_phrase && matches!(text.as_str(), "AND" | "OR" | "NOT") && last_is_term {
            parts.push(Part::Op(text));
            last_is_term = false;
            continue;
        }

        // A phrase takes a prefix `*` straight after its closing quote.
        let prefix = if is_phrase {
            chars.next_if_eq(&'*').is_some()
        } else {
            text.ends_with('*')
        };
        let term = if is_phrase {
            &text[..]
        } else {
            text.trim_end_matches('*')
        };
        if term.trim().is_empty() {
            continue;
        }

        // A plain word gets its variant group; everything else stays literal.
        let group = (!is_phrase && !prefix)
            .then(|| variants.group_for(term))
            .flatten();
        parts.push(match group {
            Some(group) => Part::Group(format!(
                "({})",
                group
                    .iter()
                    .map(|t| format!("\"{t}\""))
                    .collect::<Vec<_>>()
                    .join(" OR ")
            )),
            None => Part::Term(format!(
                "\"{}\"{}",
                term.replace('"', "\"\""),
                if prefix { "*" } else { "" }
            )),
        });
        last_is_term = true;
    }

    if !last_is_term {
        parts.pop(); // a trailing operator, e.g. "neural OR"
    }
    if parts.is_empty() {
        return None;
    }

    // FTS5's implicit AND (two operands with only a space between them) is a
    // syntax error next to a parenthesised group, so write the AND out there.
    // Everywhere else keep the spacing as it was, which leaves a query with
    // no expansion byte-identical to what it built before.
    let mut out = String::new();
    let mut prev: Option<&Part> = None;
    for part in &parts {
        out.push_str(match (prev, part) {
            (None, _) => "",
            (Some(Part::Group(_)), Part::Term(_) | Part::Group(_))
            | (Some(Part::Term(_)), Part::Group(_)) => " AND ",
            _ => " ",
        });
        out.push_str(part.text());
        prev = Some(part);
    }
    Some(out)
}

/// Whether a `"` at the front of `chars` has a matching closing quote.
fn query_has_closing_quote(chars: &std::iter::Peekable<std::str::Chars>) -> bool {
    chars.clone().skip(1).any(|c| c == '"')
}

/// Searches the whole library. `query` is what the user typed; see
/// `to_fts_query` for how it's interpreted. Terms with a known
/// transliteration variant also match it, in both modes.
pub fn search(
    conn: &Connection,
    query: &str,
    mode: SearchMode,
    limit: i64,
) -> Result<Vec<SearchResult>> {
    search_with_variants(conn, query, mode, limit, VariantIndex::bundled())
}

/// [`search`], against a given variant list instead of the bundled one, so
/// tests don't depend on what `data/term_variants.txt` happens to hold.
pub fn search_with_variants(
    conn: &Connection,
    query: &str,
    mode: SearchMode,
    limit: i64,
    variants: &VariantIndex,
) -> Result<Vec<SearchResult>> {
    let Some(fts_query) = to_fts_query(query, variants) else {
        return Ok(Vec::new());
    };
    // The table name comes from the enum, never from user input.
    let fts = mode.fts_table();
    let mut stmt = conn.prepare(&format!(
        "SELECT b.id, b.title, ch.id, ch.idx, ch.title, cb.block_idx, cb.id,
                snippet({fts}, 0, '[', ']', '...', 12) AS snip,
                bm25({fts}) AS rank
         FROM {fts}
         JOIN content_blocks cb ON cb.id = {fts}.rowid
         JOIN chapters ch       ON ch.id = cb.chapter_id
         JOIN books b           ON b.id = cb.book_id
         WHERE {fts} MATCH ?1
         ORDER BY rank
         LIMIT ?2"
    ))?;

    let rows = stmt.query_map(params![fts_query, limit], |row| {
        Ok(SearchResult {
            book_id: row.get(0)?,
            book_title: row.get(1)?,
            chapter_id: row.get(2)?,
            chapter_idx: row.get(3)?,
            chapter_title: row.get(4)?,
            block_idx: row.get(5)?,
            content_block_id: row.get(6)?,
            snippet: row.get(7)?,
            rank: row.get(8)?,
        })
    })?;

    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::import::load_book;
    use crate::db::test_util::*;
    use crate::db::*;

    /// No variants, so these assertions also pin down that a query with
    /// nothing to expand builds exactly the string it always did.
    fn fts(q: &str) -> Option<String> {
        to_fts_query(q, &VariantIndex::parse("").unwrap())
    }

    /// Two small groups, so the expansion tests don't depend on what
    /// `data/term_variants.txt` happens to hold.
    fn fts_v(q: &str) -> Option<String> {
        let variants = VariantIndex::parse("dhamma, dharma\nkamma, karma\n").unwrap();
        to_fts_query(q, &variants)
    }

    #[test]
    fn fts_query_quotes_each_word() {
        assert_eq!(fts("neural networks").unwrap(), r#""neural" "networks""#);
        assert_eq!(fts("don't").unwrap(), r#""don't""#);
        assert_eq!(fts("self-aware a.b").unwrap(), r#""self-aware" "a.b""#);
        assert_eq!(
            fts("(foo) bar:baz NEAR").unwrap(),
            r#""(foo)" "bar:baz" "NEAR""#
        );
    }

    #[test]
    fn fts_query_keeps_phrases_and_prefixes() {
        assert_eq!(fts(r#""neural networks""#).unwrap(), r#""neural networks""#);
        assert_eq!(fts(r#"say"hi there""#).unwrap(), r#""say" "hi there""#);
        assert_eq!(fts("learn*").unwrap(), r#""learn"*"#);
        assert_eq!(fts(r#""deep learn"*"#).unwrap(), r#""deep learn"*"#);
    }

    #[test]
    fn fts_query_escapes_unbalanced_quotes() {
        assert_eq!(fts(r#"don"t"#).unwrap(), r#""don""t""#);
        assert_eq!(fts(r#"a "b" c""#).unwrap(), r#""a" "b" "c""""#);
    }

    #[test]
    fn fts_query_keeps_operators_only_between_terms() {
        assert_eq!(fts("a OR b").unwrap(), r#""a" OR "b""#);
        assert_eq!(fts("a NOT b AND c").unwrap(), r#""a" NOT "b" AND "c""#);
        assert_eq!(fts("OR a").unwrap(), r#""OR" "a""#);
        assert_eq!(fts("a OR").unwrap(), r#""a""#);
        assert_eq!(fts("a OR AND b").unwrap(), r#""a" OR "AND" "b""#);
        assert_eq!(fts("a or b").unwrap(), r#""a" "or" "b""#);
        assert_eq!(fts(r#"a "OR" b"#).unwrap(), r#""a" "OR" "b""#);
    }

    #[test]
    fn fold_term_folds_iast() {
        assert_eq!(fold_term("Dhamma"), "dhamma");
        assert_eq!(fold_term("nibbāna"), "nibbana");
        assert_eq!(fold_term("saṃsāra"), "samsara");
        assert_eq!(fold_term("paṭicca"), "paticca");
        assert_eq!(fold_term("ṝṣi"), "rsi");
        // Decomposed input: "a" + a combining macron.
        assert_eq!(fold_term("nibba\u{0304}na"), "nibbana");
    }

    #[test]
    fn variant_index_parses_and_rejects_duplicates() {
        let v = VariantIndex::parse(
            "# a comment\n\n dhamma , dharma \nkamma, karma  # trailing comment\nlonely\n",
        )
        .unwrap();
        assert_eq!(v.groups().len(), 2, "a one-term line can't expand");
        assert_eq!(v.group_for("DHARMA").unwrap(), ["dhamma", "dharma"]);
        assert_eq!(v.group_for("dhamma").unwrap(), ["dhamma", "dharma"]);
        assert!(v.group_for("lonely").is_none());
        assert!(v.group_for("cats").is_none());

        let err = VariantIndex::parse("dhamma, dharma\ndharma, dhrama\n").unwrap_err();
        assert!(err.to_string().contains("two variant groups"), "{err}");
    }

    #[test]
    fn bundled_variants_parse() {
        let v = VariantIndex::bundled();
        assert!(v.groups().len() > 20);
        assert_eq!(v.group_for("dharma").unwrap(), ["dhamma", "dharma"]);
        // Typed with diacritics, the way the books spell it.
        assert_eq!(v.group_for("nibbāna").unwrap(), ["nibbana", "nirvana"]);
        for group in v.groups() {
            for term in group {
                assert!(
                    term.is_ascii() && term == &term.to_lowercase(),
                    "variant terms are written lowercase ASCII: {term}"
                );
            }
        }
    }

    #[test]
    fn fts_query_expands_known_variants() {
        let group = r#"("dhamma" OR "dharma")"#;
        assert_eq!(fts_v("dharma").unwrap(), group);
        assert_eq!(fts_v("DHARMA").unwrap(), group, "case folded");
        assert_eq!(fts_v("dhamma").unwrap(), group, "either way round");
        assert_eq!(fts_v("cats").unwrap(), r#""cats""#, "no group, no change");
    }

    #[test]
    fn fts_query_writes_and_out_next_to_a_group() {
        // FTS5's implicit AND is a syntax error beside a parenthesised group.
        assert_eq!(
            fts_v("dharma monks").unwrap(),
            r#"("dhamma" OR "dharma") AND "monks""#
        );
        assert_eq!(
            fts_v("monks dharma").unwrap(),
            r#""monks" AND ("dhamma" OR "dharma")"#
        );
        assert_eq!(
            fts_v("dharma kamma").unwrap(),
            r#"("dhamma" OR "dharma") AND ("kamma" OR "karma")"#
        );
        // Operators the user typed are left exactly as they were: `NOT` is
        // the operator FTS5 wants, `AND NOT` is a syntax error.
        assert_eq!(
            fts_v("dharma NOT monks").unwrap(),
            r#"("dhamma" OR "dharma") NOT "monks""#
        );
        assert_eq!(
            fts_v("dharma OR cats").unwrap(),
            r#"("dhamma" OR "dharma") OR "cats""#
        );
        // Unexpanded terms keep the implicit AND they have always had.
        assert_eq!(fts_v("monks cats").unwrap(), r#""monks" "cats""#);
    }

    #[test]
    fn fts_query_leaves_phrases_and_prefixes_alone() {
        assert_eq!(fts_v("dharm*").unwrap(), r#""dharm"*"#);
        assert_eq!(fts_v("dharma*").unwrap(), r#""dharma"*"#);
        assert_eq!(fts_v(r#""the dharma""#).unwrap(), r#""the dharma""#);
    }

    /// Every expanded query above has to be one FTS5 actually accepts, so
    /// a syntax error fails here rather than reaching a user's search box.
    #[test]
    fn expanded_queries_are_valid_fts5() {
        let mut conn = open_db(":memory:").unwrap();
        let book = one_chapter_book(
            "Variants",
            &[
                "He explained the dhamma to the monks.",
                "The dharma as taught in the Sanskrit tradition.",
                "Kamma ripens in its own time.",
            ],
        );
        load_book(&mut conn, "/v.epub", "hv", &book).unwrap();
        let variants = VariantIndex::parse("dhamma, dharma\nkamma, karma\n").unwrap();

        for query in [
            "dharma",
            "dharma monks",
            "monks dharma",
            "dharma kamma",
            "dharma NOT monks",
            "dharma OR cats",
            "dharma AND monks",
            r#""the dharma""#,
            "dharm*",
            "dharma explained monks",
        ] {
            for mode in [SearchMode::Stemmed, SearchMode::Exact] {
                search_with_variants(&conn, query, mode, 50, &variants)
                    .unwrap_or_else(|e| panic!("{query:?} in {mode:?} is not valid FTS5: {e}"));
            }
        }
    }

    /// The point of the feature: the Sanskrit spelling finds the Pali text.
    #[test]
    fn search_finds_the_other_spelling() {
        let mut conn = open_db(":memory:").unwrap();
        let book = one_chapter_book(
            "Variants",
            &[
                "He explained the dhamma to the monks.",
                "Kamma ripens in its own time.",
                "Nothing relevant here at all.",
            ],
        );
        load_book(&mut conn, "/v.epub", "hv", &book).unwrap();
        let variants = VariantIndex::parse("dhamma, dharma\nkamma, karma\n").unwrap();
        let empty = VariantIndex::parse("").unwrap();

        for mode in [SearchMode::Stemmed, SearchMode::Exact] {
            // "dharma" appears nowhere in the book.
            assert!(search_with_variants(&conn, "dharma", mode, 50, &empty)
                .unwrap()
                .is_empty());
            let hits = search_with_variants(&conn, "dharma", mode, 50, &variants).unwrap();
            assert_eq!(hits.len(), 1, "{mode:?}");
            assert!(hits[0].snippet.contains("[dhamma]"), "{}", hits[0].snippet);

            // A term with a group ranks and highlights exactly as it did
            // before, since the other member matches nothing here.
            let plain = search_with_variants(&conn, "dhamma", mode, 50, &empty).unwrap();
            let expanded = search_with_variants(&conn, "dhamma", mode, 50, &variants).unwrap();
            assert_eq!(plain.len(), expanded.len());
            for (a, b) in plain.iter().zip(&expanded) {
                assert_eq!(a.content_block_id, b.content_block_id);
                assert_eq!(a.rank, b.rank, "expansion must not shift ranking");
                assert_eq!(a.snippet, b.snippet);
            }
        }
    }

    #[test]
    fn fts_query_empty_input() {
        assert_eq!(fts(""), None);
        assert_eq!(fts("   "), None);
        assert_eq!(fts(r#""""#), None);
        assert_eq!(fts("*"), None);
        assert_eq!(fts("AND"), Some(r#""AND""#.into()));
    }
}
