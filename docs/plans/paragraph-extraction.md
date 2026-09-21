# Paragraph extraction: emit one paragraph per content block

## Context

`extract_paragraphs` (`ebook_research_core/src/epub.rs`) walks a chapter's
XHTML with a flat `depth_stack` and emits text at *every* block boundary.
Two README limitations come from that one function:

- **Limitation 1** — the README says nested tags duplicate text. That part is
  already fixed: the `<div>` commit (08d1478) made a nested block open flush
  and clear its parent's buffer, so `<li><p>x</p></li>` emits one paragraph,
  not two. What's left is the opposite problem: mixed content gets *chopped
  up*. `<div>Intro <div>inner</div> tail</div>` becomes three paragraphs, as
  the current `div_based_paragraphs_are_extracted` test asserts. Paragraphs are
  the search unit, so a phrase spanning the nested block can't be found, and
  the reader renders three `<p>`s where the book has one.
- **Limitation 7** — every text node gets a trailing space
  (`current.push(' ')`), so text split across inline tags gains spaces the
  source doesn't have. `<b>B</b>EFORE` becomes "B EFORE", which a search for
  "before" never matches; `(<i>dhatu</i>)` renders as "( dhatu )".

Both need the same thing the current code can't express: knowing whether a
block is a *wrapper* (its children are blocks) or a *leaf* (it directly
contains text), and whether a given text node sits next to an inline tag or a
block boundary. A streaming flat stack can't decide either, because it can't
look ahead at a block's children.

## 1. The rule

Build a small tree for the chapter, then walk it:

- A block element is a **leaf paragraph** if any non-whitespace text is a
  direct child (not inside a nested block). It emits its *entire* text
  content — nested blocks included — as one paragraph.
- Otherwise it's a **wrapper**: don't emit it, recurse into its children.
- Non-block elements are transparent: recurse into them, but their own text is
  dropped unless a block ancestor claimed it (unchanged from today).

Checked against the cases that matter:

| Markup | Result |
| --- | --- |
| `<li><p>x</p></li>` | wrapper → `x` (limitation 1's original case) |
| `<li><p>a</p><p>b</p></li>` | wrapper → `a`, `b` |
| `<div>Intro <div>inner</div> tail</div>` | leaf → `Intro inner tail` |
| `<div class="atx1"><div class="tx1">a</div><div class="tx1">b</div></div>` | wrapper → `a`, `b` |
| `<div class="tx">First <i>para</i> here</div>` | leaf → `First para here` |

The fourth row is why "take each top-level block child whole" — the phrasing in
the README roadmap — isn't enough on its own: *Understanding Our Mind* wraps a
page of paragraph divs in one container div, and taking the container whole
would collapse a chapter into a single paragraph.

**Accepted edge case:** a leaf that contains a nested heading (`<div>Intro
<h1>Title</h1></div>`) swallows the heading, so it isn't flagged
`is_heading`. Forcing headings to split would mean a leaf no longer emits a
contiguous run of text, which isn't worth it for markup this rare. Div-styled
headings are a separate roadmap item (limitation 3) anyway.

## 2. Where the spaces come from

Today's blanket space after every text node goes away. A paragraph's text is
the concatenation of its descendant text nodes *verbatim* — the spaces the
source already has between words survive, and inline tags contribute nothing.
`normalize_whitespace` still collapses runs at the end.

A separator space is inserted only where the markup implies a break:

- void/line-breaking elements: `br`, `hr`, `img`
- entering and leaving a nested block inside a leaf, so
  `<div>Intro<div>inner</div>tail</div>` is `Intro inner tail`, not
  `Introinnertail`

Note that `<br/>` currently arrives as `Event::Empty`, which the existing match
drops into `_ => {}`; today's test only passes because of the blanket space.
Handling `Empty` explicitly is required, not optional.

## 3. Building the tree — `epub.rs`

```rust
enum Node {
    Text(String),
    Elem { name: String, children: Vec<Node> },
}
```

Same `quick_xml::Reader` and event loop, feeding a stack of part-built
elements instead of a `String`:

- `Event::Start` → push a new frame. `Event::End` → pop it into its parent's
  children. `Event::Empty` → a childless `Elem` in place.
- **Void elements** (`br`, `hr`, `img`, `meta`, `link`, `col`, `input`,
  `base`, `source`) are always childless, whether they arrive as `Empty` or,
  in sloppy markup, as an unclosed `Start`. Without this a bare `<br>` opens a
  frame that swallows the rest of the paragraph as its children.
- **Mismatched `End`**: close up to the nearest open element with that local
  name; if there is none, ignore the event. Today's blind `pop()` corrupts the
  nesting for the rest of the chapter.
- **EOF (and the `Err(_) => break`)**: close every still-open element
  implicitly, keeping its text. Today the in-progress buffer is dropped, so a
  truncated chapter loses its last paragraph. This makes the parser more
  forgiving but does *not* close out limitation 6 — a parse error still stops
  the chapter early rather than recovering.
- **Skip `script` and `style` entirely** — inside a block their text is
  currently captured as prose. Pre-existing, cheap to fix here.

`check_end_names(false)` stays; `BLOCK_TAGS` is unchanged (adding `td`,
`section`, `figcaption` etc. belongs with the tables/formatting work,
limitation 4).

## 4. Walking it

`extract_paragraphs` keeps its signature — `Vec<(bool, String)>`, one entry
per paragraph, `is_heading` for `h1`/`h2` — so `parse_epub`'s title pick and
offset arithmetic are untouched, as is every caller downstream. Two helpers:

- `has_direct_text(children) -> bool` — any `Text` child that isn't whitespace,
  or any such text inside a non-block child (so `<p><span>x</span></p>` is a
  leaf).
- `text_of(node) -> String` — concatenate descendant text with the separators
  from §2.

The walk pushes `(is_heading, normalize_whitespace(text_of(e)))` for each leaf,
skipping empties, and recurses otherwise.

## 5. Tests — `epub.rs` unit tests

`div_based_paragraphs_are_extracted` changes: its third case now expects
`["Intro inner tail"]` instead of `["Intro", "inner", "tail"]`. That's the
behaviour change this plan is for, so the test is updated rather than kept.

New cases:

- `<li><p>x</p></li>` → one paragraph; `<li><p>a</p><p>b</p></li>` → two.
- `<div><div><p>x</p></div></div>` → one paragraph (wrapper chain).
- Drop cap: `<p><b>B</b>EFORE the rain</p>` → `BEFORE the rain`.
- Inline punctuation: `<p>(<i>dhatu</i>)</p>` → `(dhatu)`.
- Source spaces survive: `<p>as the <i>Buddha</i> said</p>` → `as the Buddha said`.
- `<br/>` and a bare `<br>` both give `Nested verse`.
- Unclosed at EOF: `<p>one</p><p>two` → `["one", "two"]`.
- `<p>text<script>var x = "hello";</script></p>` → `text`.
- `flags_h1_and_h2_as_headings` and `no_headings_means_no_title_candidate`
  pass unchanged.

`tests/integration.rs` needs no new case — the synthetic EPUB is flat `<p>` —
but it must keep passing, which proves the common path didn't regress.

## 6. README

- Rewrite limitation 1 as fixed, or drop it: nested blocks now emit one
  paragraph per content block. Renumber what follows.
- Drop limitation 7 (the inline-space bug).
- Move both roadmap bullets to Done; "Skip non-content spine items" and
  "Recover from malformed XHTML" stay in Next up.
- Note in limitation 5's neighbourhood that books imported before this change
  keep their old paragraph splits until removed and re-imported.

## Verification

1. `cargo test -p ebook_research_core`
2. `cargo build --workspace`
3. `npm run tauri dev`, then re-import against real books — the parse changes
   only apply on import, so each test book must be removed and imported again:
   - *Understanding Our Mind* (`~/Documents/books/understandingourmind.epub`),
     the div-heavy book. Check a drop-cap word that used to be split is now
     searchable in **exact** mode, and that chapter 1 still finds
     `sarvabijaka`.
   - A `<p>`-based book, to confirm the common path is unchanged: same chapter
     count and similar hit counts as before.
4. In the reader, check a chapter that previously showed one sentence as
   several short paragraphs now shows it as one.

## Implementation notes (differences from this plan)

None in behaviour. Structure only: the tree is built by `build_tree`
and walked by `collect_paragraphs`, and `text_of` wraps a `push_text`
helper that appends into one buffer rather than allocating a string per
node.

Observed on *Understanding Our Mind* (parser run directly, not through
the app): 1166 paragraphs before, 1087 after, across the same 66
chapters. All 57 drop-cap splits ("B EFORE", "T HE", ...) are gone and
chapter 1 still contains "sarvabijaka". Most of the drop is footnotes
(`<div class="fn"><a>1</a> <div>text</div></div>` is now one paragraph
per note, 100 -> 50); the rest is lead-in paragraphs that wrap a
numbered list of `<div>`s, which the §1 rule keeps as one paragraph.
