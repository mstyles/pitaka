# Update quick-xml to 0.42

## Context
Dependabot's bump of quick-xml from 0.31 to 0.42 (#15) doesn't compile: `Reader::trim_text`/`check_end_names` moved to `Reader::config_mut()`, names, attribute keys and text now deref to `&str` instead of `&[u8]`, `Attribute::unescape_value` is deprecated for `normalized_value`, and `buffer_position()` returns `u64`. The goal is a port that imports every book exactly as today, so the users of `epub.rs` (`parse_epub` and `db/import.rs`) see no difference.

Fixing only the compile errors isn't enough. With a scratch program against 0.42.0 (the `escape-html` feature on, `check_end_names = false`), compared with 0.31.0 on the same inputs:
- **Entities are separate events.** `<p>a&nbsp;b&mdash;c</p>` gives `Text("a")`, `GeneralRef("nbsp")`, `Text("b")`, `GeneralRef("mdash")`, `Text("c")`. Char refs come the same way (`GeneralRef("#x41")`), and so does an unknown name (`GeneralRef("bogus")`). `Text` events never contain a `&`. A port that only handles `Event::Text` drops every entity, which undoes the entity fix in `malformed-xhtml-recovery.md`.
- **A bare `&` is a reader error.** `<p>Faith & Reason &amp; more</p>` gives `Text("Faith ")`, then `Err` ("entity or character reference not closed"), with `buffer_position()` taken before the call pointing at the `&`. Through `build_tree`'s current recovery, `skip_broken_markup` would drop " Reason & more". In `parse_opf`, where the error goes through `?`, a bare `&` in `<dc:title>` would fail the import again. The scan for `;` stops at `<`, so `<p>Faith & Reason</p><p>x;</p>` errors at the first `</p>` and never eats markup. `a & b; c` gives `GeneralRef(" b")`.
- **`trim_text(true)` trims each piece between refs.** `<t> T &amp; U </t>` gives `Text("T")`, `GeneralRef("amp")`, `Text("U")`, so the OPF title would become "T&U". The title would also stop at its first piece, since `parse_opf` keeps only the first text event.
- **Stray end tags are errors.** `</div><p>a</p>`, `<p>a</p></div><p>b</p>` and `<p>a</p></p>` all fail in 0.42 ("close tag does not match any open tag"), while 0.31 with `check_end_names(false)` returned an `End` event. Setting `config_mut().allow_unmatched_ends = true` gives event sequences identical to 0.31's for all three.
- Unchanged: unquoted and duplicate attributes, `<!DOCTYPE html>`, a stray `<` in text, `<br>` without a slash and elements still open at EOF parse as before. A broken comment, an unclosed `<!--`, `<![CDAT[` and `<? x` still error with `buffer_position()` at the `<`, so `skip_broken_markup` works unchanged. `normalized_value` and `unescape_value` returned the same values for the hrefs and `properties` lists probed.

Out of scope: the zip and sha2 updates (#27, #28), and parser changes beyond keeping today's output. One small side effect is allowed: the OPF and TOC readers share `build_tree`'s recovery (§2), so broken markup in those files is skipped instead of failing the import (OPF) or cutting the TOC short (nav/NCX). No book in the library has either.

Ruled out: staying on 0.31, since every later release is blocked behind it and Dependabot keeps reopening the PR. Ruled out: reassembling text by feeding `Text` + `&name;` back into `unescape_lenient`. That works, but it re-escapes text the reader has already split up, and it still needs the bare-`&` restart below.

## 1. Dependency: `ebook_research_core/Cargo.toml`
- `quick-xml = { version = "0.42", features = ["escape-html"] }`. Build on a `fix/quick-xml-0.42` branch from `main`, not on Dependabot's branch, which is behind `main` and would conflict in `Cargo.lock`. #15 closes itself once this merges.

## 2. One lenient event source: `epub.rs`
- `enum XmlEvent<'a> { Start(BytesStart<'a>), Empty(BytesStart<'a>), End(BytesEnd<'a>), Text(Cow<'a, str>) }`.
- `struct LenientReader<'a> { xml: &'a str, base: usize, reader: Reader<&'a [u8]> }` with `fn new(xml: &'a str) -> Self` and `fn next(&mut self) -> Option<XmlEvent<'a>>` (`None` at EOF). Every reader it creates gets `check_end_names = false` and `allow_unmatched_ends = true`. `trim_text` stays off. Events borrow from `xml` through `read_event()`, so no `buf` is needed.
- `next()` maps the events:
  - `Event::Text(e)` → `Text(e.into_inner())`, unchanged: it contains no `&`.
  - `Event::GeneralRef(e)` → `Text(resolve_ref(&e))`.
  - `Start`/`Empty`/`End` pass through. Anything else (comments, CDATA, doctype, PIs) is skipped, as all four parsers do today.
  - `Err` with `xml[at..]` starting with `&` (where `at = base + reader.buffer_position() as usize`, taken before the call) → `Text("&")` and restart at `at + 1`. That keeps "Faith & Reason" and a `&` at the very end.
  - Any other `Err` → restart at `skip_broken_markup(xml, at)`. Same as `build_tree` today, moved here.
- `fn resolve_ref(name: &str) -> Cow<'static, str>`: `quick_xml::escape::unescape(&format!("&{name};"))` if that succeeds (all HTML5 named entities through `escape-html`, plus `&#…;`/`&#x…;`), else the literal `&{name};`. An unknown `&bogus;` and `a & b; c` keep their text as written, matching `unescape_lenient` today.
- `unescape_lenient` and its `MAX_ENTITY_LEN` loop are deleted, since nothing produces a `&` in text any more. Its test is replaced in §5.
- `local_name(tag: &str) -> &str`, since names are `&str` now. Attribute keys are compared as `&str` (`attr.key.as_ref() == "href"`), and values come from `attr.normalized_value(XmlVersion::Implicit1_0)` in place of `unescape_value()`, keeping today's `?`/`.ok()` handling at each call site.

## 3. Callers: `epub.rs`
- `build_tree`: loops `while let Some(ev) = reader.next()` over a single `LenientReader`. The `'restart` loop, `base`, `buf` and the `Err` arm go, because restarts now happen inside the reader. `XmlEvent::Text` pushes onto the open element's last `Node::Text` if there is one, else a new one, so `a&nbsp;b` stays one text node as before. Tree building, `VOID_TAGS`, `SKIP_TAGS` and end-tag matching don't change. The doc comment moves the restart description to `LenientReader`.
- `extract_opf_path`: same loop, with `trim_text(true)` dropped. It only reads attributes.
- `parse_opf`: no longer trims per event. While inside `<title>`/`<creator>`, text is appended to a buffer. At the matching `End`, the trimmed buffer becomes `title`/`author` if that is still `None` and the text isn't empty. That keeps the first-element-wins rule and today's trimming. The function still returns `Result` for the `?` on attribute values.
- `parse_nav_toc` and `parse_ncx`: same loop. Label text arms push `XmlEvent::Text` directly, since text is already resolved. `Ok(Event::Eof) | Err(_) => break` becomes the end of the `while let`.

## 4. Unchanged
- `skip_broken_markup`, `resolve_href`, `percent_decode`, `collect_paragraphs`, `text_of` and `normalize_whitespace`. `db/` and the frontend are untouched. `ParsedBook` doesn't change, so the UI fixtures don't need regenerating.

## 5. Tests: `epub.rs` `#[cfg(test)]`
Existing tests that must pass unchanged: `html_entities_are_decoded`, `bare_ampersand_is_kept`, `parsing_resumes_after_a_broken_comment`, `unclosed_comment_loses_only_its_own_text`, `broken_markup_inside_a_paragraph_keeps_the_paragraph`, `unclosed_blocks_at_eof_keep_their_text`, `nav_toc_reads_only_the_toc_nav`, `ncx_lists_nested_nav_points_parent_first` and the rest of the module, plus `tests/integration.rs`. New tests:
- `entities_and_bare_ampersands_in_text` (replaces `unescape_lenient_keeps_what_it_cannot_unescape`, same cases through `texts`): `"<p>A &amp; B &</p>"` → `["A & B &"]`. `"<p>& &CounterClockwiseContourIntegral;</p>"` → `["& \u{2233}"]`. `"<p>&#x41;&#66; &bogus; a & b; c</p>"` → `["AB &bogus; a & b; c"]`. `"<p>Faith & Reason</p><p>x;</p>"` → `["Faith & Reason", "x;"]`.
- `stray_end_tags_are_ignored`: `texts("</div><p>a</p></p></div><p>b</p>")` → `["a", "b"]`.
- `opf_title_and_author_keep_entities_and_spacing` (in `opf_tests`): `<dc:title>  Faith &amp; Reason &mdash; Two  </dc:title><dc:creator>A & B</dc:creator>` → title `"Faith & Reason — Two"`, author `"A & B"`. A second `<dc:title>` is ignored.
- `toc_labels_keep_entities`: a nav `<a href="c.xhtml">One&nbsp;&amp; Two</a>` and an NCX `<text>One &amp; Two</text>` both give the label `"One & Two"`.

Regression check, not committed: a scratch binary that prints every chapter's `file_name`, `title` and paragraphs from `parse_epub`, plus the book title and author, for the six books in `~/Documents/books` and `test.epub`. Run it on `main` and on the branch, and the diff must be empty (today: 210 chapters, 7,196 paragraphs).

## 6. README
- In the `epub.rs` paragraph of "What's actually verified", change "via quick-xml's `escape-html` feature" to describe the 0.42 behavior (entities resolved from quick-xml's reference events through `escape-html`), and add that the 0.42 port was checked by diffing parser output over the six books and `test.epub` against 0.31's. No limitation or roadmap item changes.

## Verification
1. `cargo test -p ebook_research_core`
2. `cargo clippy --workspace --all-targets -- -D warnings`, with and without `--features pitaka/semantic`
3. The corpus diff in §5 is empty.
4. Not planned: re-importing in the Tauri window. No UI or `db` code changes, and §5's diff covers the parser output that import stores.
