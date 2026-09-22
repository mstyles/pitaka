# Cross-transliteration term matching

## Context
A library that mixes Pali and Sanskrit sources spells the same term two ways. Searching `dharma` finds nothing in a text that only ever writes "dhamma", and the user has no way to know the other spelling exists — the result is an empty screen, not a hint. The demo book makes this concrete: the Therīgāthā contains "dhamma" 37 times, "kamma" 30 times and "nibbāna" once, and "dharma", "karma" and "nirvana" zero times. All three Sanskrit queries return nothing today.

Diacritics are already handled: both FTS5 indexes use `remove_diacritics 2`, so `samsara` matches "saṃsāra" and `nibbana` matches "nibbāna". What's missing is the genuinely different spelling — `dhamma` vs `dharma` — which no amount of folding reaches.

The fix is query expansion: a curated list of variant groups, consulted while building the FTS5 query, turning one term into a parenthesised `OR` group. FTS5 ranks the group's members together through `bm25()`, so variant hits interleave with literal ones rather than arriving as a separate "did you mean" step.

**No semantic search path exists.** Search is FTS5 only, in two modes (`Stemmed` and `Exact`); nothing in the repo does embeddings or vector similarity. The requirement's "both keyword and semantic search paths" therefore reads as both FTS5 modes here, and expansion applies to both. Semantic search goes on the README roadmap under "Later" so the gap is tracked rather than quietly dropped.

Out of scope for v1: inferring unlisted pairs algorithmically; expanding inside quoted phrases or prefix terms (see §2); any UI change — expansion is invisible, the user just gets the hits.

Alternatives ruled out:
- **A custom FTS5 tokenizer** folding variants at index time. Correct in principle and free at query time, but it needs `fts5_tokenizer` registration that rusqlite doesn't expose, and every change to the list would mean re-indexing every book.
- **A `term_variants` SQLite table** (migration 004). Fits the architecture and would support a future editing UI, but was not chosen: it puts the curated list behind SQL for a feature with no UI to edit it, and the demo (which has no SQLite) would need it exported anyway.
- **Expanding after the search**, by running a second query per variant and merging. Two result sets can't be merged on `bm25()` scores that were computed against different queries, so ranking would be arbitrary — exactly the segregation the requirement rules out.

### What was checked, and how
Run against the bundled SQLite 3.53.2 via a throwaway `ebook_research_core/tests/` probe (since deleted), and cross-checked on the system `sqlite3` 3.46.1 — identical results on both:

- `("dharma" OR "dhamma")` works as a whole query and highlights **both** members in `snippet()`.
- **`("dharma" OR "dhamma") "taught"` is a syntax error** — `fts5: syntax error near ""taught""`. FTS5's implicit AND does not survive next to a parenthesised group; the `AND` must be written out. This drives the join rule in §2.
- `("dharma" OR "dhamma") AND "taught"`, `"taught" AND (…)`, `(…) OR "cats"`, `(…) NOT "monks"` and `(…) AND (…)` all parse. `(…) AND NOT "monks"` does **not** — bare `NOT` is the operator, so `NOT` is left exactly as it is built today.
- `("dharm" OR "dhamm")*` is a syntax error; a prefix `*` must sit on each member, `("dharm"* OR "dhamm"*)`.
- `"a" "b"` and `"a" AND "b"` return byte-identical `bm25()` values and snippets, so writing `AND` out is semantically free.
- **A duplicate member doubles the score**: `("dharma" OR "dhamma" OR "dharma")` scores the dharma-only document at `-0.944` against `-0.472` for the two-member group, promoting it from second place to first. So a group must emit each distinct term exactly once, and the user's literal term must never be appended on top of its own group (§2).
- **A member that matches nothing costs nothing**: `("nibbana" OR "nirvana")` over a corpus with no "nirvana" returns the same rows, the same `bm25()` values and the same snippets as plain `"nibbana"`. This is what keeps the existing fixtures from churning (§5).

## 1. The curated list: `ebook_research_core/data/term_variants.txt`
- A data file, not Rust logic: one variant **group** per line, terms comma-separated, `#` comments and blank lines ignored. Groups, not pairs, so `nibbana, nirvana` can grow a third spelling without a schema for it. Adding a pair is a one-line edit with no Rust change — though, being `include_str!`-embedded, it does take a rebuild to take effect. That is the accepted cost of the chosen storage.
- Terms are stored **ASCII-folded and lowercase**. Nothing is lost: the emitted term goes through FTS5's `remove_diacritics 2`, so the ASCII `nibbana` still matches "nibbāna" in the text (checked above).
- Seed it with the Pali/Sanskrit pairs the library actually needs, each line commented where the pair isn't obvious: `dhamma, dharma` · `kamma, karma` · `nibbana, nirvana` · `sutta, sutra` · `bhikkhu, bhiksu` · `bhikkhuni, bhiksuni` · `sangha, samgha` · `tanha, trsna` · `khandha, skandha` · `sankhara, samskara` · `sati, smrti` · `vinnana, vijnana` · `panna, prajna` · `metta, maitri` · `magga, marga` · `anatta, anatman` · `dukkha, duhkha` · `arahant, arhat` · `jhana, dhyana` · `kilesa, klesa` · `asava, asrava` · `upekkha, upeksa` · `viriya, virya` · `bodhisatta, bodhisattva` · `thera, sthavira` · `paticcasamuppada, pratityasamutpada` · `patimokkha, pratimoksa`.

## 2. Core: variant lookup and query expansion — `db.rs`, `lib.rs`
- `pub struct VariantIndex { groups: Vec<Vec<String>>, by_term: HashMap<String, usize> }`, with:
  - `pub fn parse(text: &str) -> Result<Self>` — the file format above. Folds each term with `fold_term`, skips empty terms, and `bail!`s on a term listed in two groups (`"dhamma" appears in two variant groups`) so a copy-paste slip is caught by the test in §5 rather than silently shadowing.
  - `pub fn bundled() -> &'static VariantIndex` — `OnceLock` over `parse(include_str!("../data/term_variants.txt")).expect(…)`. `expect` is right here: the file is embedded at compile time and validated by `bundled_variants_parse`, so a failure is a build bug, never user input.
  - `fn group_for(&self, term: &str) -> Option<&[String]>` — folds `term`, then looks it up.
  - `pub fn groups(&self) -> &[Vec<String>]` — for the demo fixture in §4.
- `fn fold_term(term: &str) -> String` — lowercases, strips combining marks `U+0300..=U+036F` (so NFD input folds, which the Fraunces macron work showed is real), and maps the precomposed IAST letters to ASCII: `ā ī ū ṛ ṝ ḷ ḹ ē ō ṅ ñ ṭ ḍ ṇ ś ṣ ṃ ṁ ḥ` and their capitals. Deliberately a small table rather than a new `unicode-normalization` dependency. It is only consulted to decide whether expansion *triggers*: a letter outside the table means the user misses the expansion, never that literal search breaks, since FTS5 folds the text either way.
- `to_fts_query(query: &str, variants: &VariantIndex) -> Option<String>` — gains the index as a parameter so tests can pass their own. Parsing is unchanged; only how a term becomes a part changes:
  - `parts` becomes `Vec<Part>` where `enum Part { Term(String), Group(String), Op(String) }`, replacing the current `Vec<String>` + `last_is_term` pair (`last_is_term` becomes `matches!(parts.last(), Some(Term(_) | Group(_)))`).
  - A **non-phrase, non-prefix** term whose folded form has a group becomes `Part::Group(format!("({})", members.join(" OR ")))`, each member quoted as terms are today. Members come out in file order, once each — never with the user's literal term appended, which would double its score (checked above).
  - Phrases and prefix terms are left alone: a prefix would need `*` on each member and can't be known to mean the whole word, and a multi-word phrase has no single term to look up. Both behave exactly as today.
  - **Joining**: walk the parts, and between two adjacent non-`Op` parts emit `" AND "` when either side is a `Group`, otherwise `" "` as now. A query with no expansion therefore produces a byte-identical string to today's — the regression criterion is met by construction, not by inspection. `Op` parts (including `NOT`) are joined with spaces as now.
- `search(conn, query, mode, limit)` keeps its signature and calls `VariantIndex::bundled()`, so **`commands.rs` and `generate_handler!` are untouched** and the command layer stays thin. Add `pub fn search_with_variants(conn, query, mode, limit, variants: &VariantIndex)` for tests; `search` becomes a one-line call to it.
- Expansion applies in **both** modes. "Exact words" means "don't stem" (`learning` ≠ `learn`), not "don't expand" — it is about morphology, and this is about spelling. Worth a second look at review time: it is the one place the feature touches a mode whose name implies literalness.
- `lib.rs` re-exports `VariantIndex` and `search_with_variants`.

## 3. Tauri command layer: no change
`search_library` already passes `query` and `mode` straight through, and `SearchResult` gains no field (no UI disclosure). Nothing in `src-tauri/` or `src/types.ts` changes.

## 4. Frontend: `src/demo/search.ts`, `src/demo/variants.json`
No app UI changes — `SearchView.tsx` and the component tests are untouched. The demo's TypeScript port must mirror the core or `src/demo/search.test.ts` fails, since it asserts identical rows, ranks and snippets.

- `src/demo/variants.json` — the groups, written by the core fixture test in §5 through the existing `check_fixture` mechanism, so the list can't drift from the Rust one.
- `src/demo/search.ts` — the port builds an expression tree rather than an FTS5 string, so the parenthesised-AND problem doesn't arise; the change is in `buildExpr`, not `parseQuery`. For a non-phrase, non-prefix part whose folded text has a group, register **each member as its own phrase, in file order**, and push a single `{ kind: "or", children: [...] }` node onto `run` instead of one phrase node. Phrase registration order must match the order the core writes the members into the query string, because `bm25()` weights phrases by index.
- Fold the lookup key with a `foldVariantKey` mirroring `fold_term`'s table rather than the existing NFD-based `fold()`, so the two sides agree on exactly which inputs trigger expansion.

## 5. Tests
- `db.rs` unit tests:
  - `bundled_variants_parse` — `VariantIndex::bundled()` parses, has the expected group count, and `group_for("DHARMA")`, `group_for("dhamma")` and `group_for("nibbāna")` all resolve (the last proving `fold_term`).
  - `fold_term_folds_iast` — `ā→a`, `ṃ→m`, `ṭ→t`, `ṝ→r`, NFD `a`+U+0304 → `a`, and `Dhamma→dhamma`.
  - `variant_index_rejects_duplicates` — `parse("a, b\nc, a\n")` is an `Err`.
  - `to_fts_query` against a test index built from `"dhamma, dharma\nkamma, karma\n"`:
    - `dharma` → `("dhamma" OR "dharma")`
    - `dharma monks` → `("dhamma" OR "dharma") AND "monks"` — the join rule
    - `monks dharma` → `"monks" AND ("dhamma" OR "dharma")`
    - `dharma kamma` → `("dhamma" OR "dharma") AND ("kamma" OR "karma")`
    - `dharma OR cats` → `("dhamma" OR "dharma") OR "cats"`
    - `dharma NOT monks` → `("dhamma" OR "dharma") NOT "monks"` — not `AND NOT`
    - `dharm*` → `"dharm"*`, `"the dharma"` → `"the dharma"` — prefix and phrase untouched
    - `neural networks` → `"neural" "networks"`, unchanged from today, asserted against the current expected string.
  - Every expanded string above is also run through `Connection::prepare`/`query` against a small in-memory FTS5 table, so a syntax error fails the test rather than only reaching users at runtime.
- `tests/integration.rs` against `test.epub`, using `search_with_variants` with `"neural, neuronal\n"` so the assertions don't depend on the shipped list:
  - `neuronal` returns the same `content_block_id`s as `neural` does, in both modes, though "neuronal" appears nowhere in the book — the core acceptance criterion.
  - `neural` still returns exactly what it returns today, and its `rank` values are unchanged against a `search` call with an empty `VariantIndex` — the no-regression criterion, given the duplicate-member finding.
  - `quincunx` (no group) returns identical results with and without the index.
- `ui_fixtures_for_demo_are_current` gains `dharma`, `karma`, `nirvana` and `nibbāna` to its query list, and writes `src/demo/variants.json`. Assert `stemmed:dharma` is non-empty and its snippets contain `[dhamma]` — the requirement's own example, on a real book. The existing 13 queries' recorded results should be **byte-identical**: only `nibbana` has a group, and the Therīgāthā has no "nirvana", which the check above showed costs nothing. If they do move, that is a real finding, not fixture noise — investigate before regenerating.
- `src/test/fixtures/library.json` needs no regeneration: `test.epub`'s recorded queries (`neural networks`, `quincunx`, `zzzz`) contain no listed term, so `search()` returns the same rows.
- `src/demo/search.test.ts` needs no new cases — it replays whatever `demo-search.json` holds, so the four added queries are covered automatically, and it is the test that proves the port's ranking matches across an expansion.

## 6. README
- **What's actually verified**, `db.rs` bullet: after the two search modes, note that a query term with a listed transliteration variant is expanded into an FTS5 `OR` group from `data/term_variants.txt`, so `dharma` also finds "dhamma", ranked together; that expansion skips phrases and prefix terms; and that the list is a data file edited without touching Rust.
- The demo bullet: the query count moves from 17 to 21 and mentions the variant queries.
- **Known limitations**: a new item — the variant list is curated and embedded, so adding a pair needs a rebuild, unlisted variants aren't inferred, and `fold_term` only folds the IAST letters in its table.
- **Roadmap**, Done: `[x] Expand search terms to curated transliteration variants (dharma/dhamma)`.
- **Roadmap**, Later: `[ ] Semantic search, so related terms match without a curated list` — the tracked gap from the Context.

## Verification
1. `cargo test -p ebook_research_core`
2. `cargo clippy --workspace --all-targets` — warning-free
3. `npx tsc --noEmit` and `npm test`
4. `npm run dev:demo` — search `dharma` and confirm the Therīgāthā's "dhamma" passages come back highlighted, then `karma` for "kamma"; confirm `neural`-style unlisted queries are unchanged.
