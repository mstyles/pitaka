# Chapter titles from the table of contents

## Context
Chapter titles come from the first `<h1>`/`<h2>`, else the page's `<head><title>`, else the file path (`extract_chapter` in `epub.rs`). Many publishers style headings as `<div>`s, so the reader's chapter list and search results show the wrong thing. Both books in the real library are affected: in *Understanding Our Mind* 65 of 66 chapters are titled "Understanding Our Mind", and in *No Mud, No Lotus* every chapter is "<something>, No Mud, No Lotus", with 3 called "Continued, No Mud, No Lotus". This is README limitation 2.

Every EPUB has a table of contents that names its chapters: the EPUB 3 nav document and/or the EPUB 2 NCX. Checked against the three books in `~/Documents/books`: *Understanding Our Mind* (NCX only) has "2 - Every Kind of Seed", "PART I - Store Consciousness", …; *No Mud, No Lotus* (nav + NCX) has "1: The Art of Transforming Suffering", "Contents", "Cover", …; *Awakening of the Heart* (NCX only) has several entries per file (`c01_r1.html`, then `#h1`…`#h6` for its sections), so the first entry for a file is the chapter's name.

The new order is: first `<h1>`/`<h2>`, then the book's TOC entry for the file, then `<head><title>`, then the file path. The heading stays first so that titles that already work don't change: `test.epub`'s headings ("Chapter One: Beginnings") are more descriptive than its TOC ("Chapter 1"), and the demo book's chapter titles, `src/demo/library.json` and the semantic eval labels stay valid. The catch is that a book with headings on only some chapters mixes the two styles (*Understanding Our Mind* keeps "PART I. STORE CONSCIOUSNESS" beside TOC names like "2 - Every Kind of Seed").

Like earlier parser fixes, this applies on import only: books already in the library keep their old titles until they're removed and re-imported. The real library has no bookmarks, and there are no prebuilt releases with other users' libraries, so re-importing loses nothing.

Out of scope:
- Retitling books already in the library in place.
- Removing the EPUB 3 nav document from books imported before it was skipped; re-importing fixes that too.
- Splitting a file into several chapters at its TOC fragments (`#h1`…). Chapters stay one per spine file.
- Showing TOC nesting (parts vs chapters) in the reader.

Ruled out:
- TOC before headings: it gives consistent names across a book, but changes titles that already work and replaces descriptive headings with terse ones like "Chapter 1".
- Treating `<div class="ct">` and similar as headings: class names differ between publishers, and a class list would need upkeep; the TOC already has the names.
- Backfilling existing books at startup (a `books.titles_version` column plus a refresh that re-parses each book and updates `chapters.title` by `idx`): it's schema, a startup step and tests to save a re-import that currently costs nothing.

## 1. Parser: `epub.rs`
- `ManifestItem` gains `media_type: String` (from `media-type`), and `parse_opf` also returns the spine's `toc` attribute (the NCX's manifest id). `Opf` becomes a small struct, `Opf { manifest, spine, toc_id, title, author }`, rather than a longer tuple.
- `fn toc_titles(zip, opf_dir, &Opf) -> HashMap<String, String>`: full zip path of a file → its first TOC label. Uses the nav document (the manifest item where `is_nav()`) if there is one and it yields any entries, else the NCX (the item named by `toc_id`, else the first item with media type `application/x-dtbncx+xml`). A missing or unparseable TOC gives an empty map, never an error.
- `fn parse_nav_toc(xml: &str) -> Vec<(String, String)>`: `(href, label)` for each `<a href>` inside the `<nav>` whose `epub:type` contains `toc`, in document order. Other navs (`landmarks`, `page-list`) are ignored. Uses its own `quick_xml` pass, since `build_tree` keeps no attributes.
- `fn parse_ncx(xml: &str) -> Vec<(String, String)>`: `(src, label)` for each `navPoint`, in document order, pairing its `navLabel/text` with its `content src`. Nested navPoints come after their parent, so a file's first entry is its outermost one.
- Labels go through `normalize_whitespace`; empty labels are dropped. Hrefs are resolved against the TOC file's own directory (not the OPF's), with the `#fragment` removed, `.`/`..` segments resolved and `%XX` escapes decoded (`fn resolve_href(base_dir, href) -> String`, written by hand, no new crate). Spine paths go through the same function so both sides compare equal. The first entry for a path wins.
- `extract_chapter` returns the heading and the head title separately (`ChapterText { blocks, heading, head_title }`), and `parse_epub` picks `heading.or(toc.get(path)).or(head_title).unwrap_or(path)`.
- Update the module doc and `ParsedChapter::title`'s doc for the new order.

## 2. Database, Tauri commands, frontend
- No change: `load_book` already stores `ParsedChapter::title`, titles reach the UI through the existing commands, and `src/types.ts` doesn't change. `library.json` should come out the same from `ui_fixtures_are_current`, since `test.epub` has headings.

## 3. Tests
- `epub.rs` unit tests:
  - `parse_nav_toc` reads only the `toc` nav: a nav document with `landmarks` and `toc` navs returns just the toc's links, in order, with labels whitespace-normalized.
  - `parse_ncx` returns nested navPoints parent-first; `src="c01.html#h1"` after `src="c01.html"` doesn't replace the first label.
  - `resolve_href`: `("OEBPS", "xhtml/Ch%201.xhtml#ch1")` → `OEBPS/xhtml/Ch 1.xhtml`; `("OEBPS/nav", "../Text/a.html")` → `OEBPS/Text/a.html`; empty base dir.
  - Precedence, on a hand-built EPUB zip in a temp dir: a chapter with an `<h2>` keeps it; one with a `<div class="ct">` heading and a TOC entry gets the TOC label; one with neither gets `<head><title>`; a nav with no entries falls back to the NCX.
- `tests/integration.rs`: the existing `test.epub` title assertions still pass unchanged (headings win over its "Chapter 1"/"Chapter 2" TOC).
- `semantic_eval_labels_name_real_chapters` and `ui_fixtures_are_current` pass without regenerating anything.

## 4. README
- Limitation 2 is replaced by: books imported before titles came from the TOC (or before the nav document was skipped) keep their old chapter titles (or the nav chapter) until removed and re-imported. Chapter titles still fall back to `<head><title>` for a file with no heading and no TOC entry.
- Roadmap: add "Chapter titles from the table of contents when there's no `<h1>`/`<h2>`" as done, under the existing "Chapter titles from the first `<h1>`/`<h2>`" item.
- "What's actually verified": the `epub.rs` entry mentions the TOC fallback.

## Verification
1. `cargo test -p ebook_research_core`, `cargo clippy --workspace --all-targets`, `npx tsc --noEmit`, `npm test`.
2. Parse the three books in `~/Documents/books` (a scratch example, not committed) and check *Understanding Our Mind* has a chapter titled "I - The Mind Is a Field", *No Mud, No Lotus* one titled "1: The Art of Transforming Suffering", and no chapter in any of them is titled with the book's name.
3. `npm run tauri dev`: remove and re-import both books, and check their chapter lists show TOC names.
