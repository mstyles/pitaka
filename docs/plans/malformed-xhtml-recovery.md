# Recover from malformed XHTML

## Context
README limitation 5: `build_tree` in `epub.rs` stops at the first parse error and keeps only the text read so far, so one broken comment early in a chapter loses the rest of it without telling anyone. This is the "Recover from malformed XHTML" item under Next up.

Research turned up a second silent loss that is more likely in real books. quick-xml only knows the five XML entities, so a text node holding `&nbsp;`, `&mdash;` or a bare `&` ("Faith & Reason") fails `unescape()`, and `build_tree` drops that whole text node. EPUBs converted from HTML use HTML entities often. This plan fixes both, since both quietly lose text from a chapter.

What was checked, with a scratch program against quick-xml 0.31 using `build_tree`'s settings (`trim_text(false)`, `check_end_names(false)`):
- Unquoted attributes, duplicate attributes, `<!DOCTYPE html>`, a stray `<` in text and unclosed tags at EOF all parse without an `Err`, and are handled already.
- `Err` comes from markup that never closes: `<!- x ->`, an unclosed `<!--`, a misspelt `<![CDAT[`, and `<? x` all give "Unexpected EOF during reading …". After the error the reader is at EOF, so there's no way to carry on with the same `Reader`.
- `buffer_position()` taken before the failing `read_event_into` call points at the broken `<`. Text before it has already come out as its own event.
- `<p>a&nbsp;b</p>` and `<p>A & B</p>` both give an `unescape` error, so the paragraph's text is dropped and the `<p>` comes out empty.
- None of this affects the current library. All 227 chapter files in the six books in `~/Documents/books` and in `test.epub` parse with no `Err` and no failed unescape. The fix is defensive, and books already imported don't change.

Out of scope: books already imported keep their paragraphs until they're removed and imported again (limitation 4). Attribute values are left alone. They only matter for hrefs and ids, and the OPF/nav readers already use `?` or `.ok()` on them.

Ruled out: an HTML-mode parser (`html5ever`/`scraper`), which is what the README suggests. It's a new dependency tree, for a problem none of the current books has. Skipping and resuming gets close to the same result for the errors quick-xml actually raises.

## 1. Entities: `ebook_research_core/Cargo.toml`
- Turn on quick-xml's `escape-html` feature: `quick-xml = { version = "0.31", features = ["escape-html"] }`. With it, `unescape()` knows every HTML5 named entity (`&nbsp;` → U+00A0, which `normalize_whitespace` turns into an ordinary space). This is a feature of a crate we already use, not a new dependency.

## 2. Lenient unescape: `epub.rs`
- `fn unescape_lenient(raw: &str) -> String`: when `quick_xml::escape::unescape(raw)` succeeds, return its result. Otherwise go through `raw` one `&` at a time: a `&` followed by a `;` within 32 bytes whose `&…;` span unescapes cleanly is replaced; any other `&` is kept as a literal `&`. So "A & B &amp; C" becomes "A & B & C", and an unknown `&foo;` stays as written.
- Use it for every text event in `epub.rs`, through `String::from_utf8_lossy(&e)` on the `BytesText`:
  - `build_tree` (`Ok(Event::Text(e))`): always pushes the text instead of `if let Ok(t) = e.unescape()`.
  - The nav TOC label (around line 398) and the NCX label (around line 478): the same change, so a label with `&nbsp;` isn't lost and the chapter doesn't fall back to its head title.
  - OPF metadata (line 252, `e.unescape()?`): today a bare `&` in `<dc:title>` fails the whole import. It now imports with the `&` kept.

## 3. Resume after a parse error: `epub.rs` `build_tree`
- Keep `stack` across restarts and wrap the read loop in an outer loop over `base: usize`, the byte offset the current `Reader` started at (`Reader::from_str(&xhtml[base..])`, with the same two settings).
- Before each `read_event_into`, note `let at = base + reader.buffer_position();`.
- On `Err(_)`: skip the broken markup from `at`, set `base` to the end of it and start a fresh `Reader`. Open elements stay on `stack`, so text after the bad markup still lands in the paragraph it belongs to. The broken markup ends at whichever comes first after `at`:
  - just past the next `>`, so `<![CDAT[x]]> after` keeps " after";
  - just before the next `<`, so an unclosed `<!-- x <p>next</p>` keeps the `<p>`. Skipping to the `>` there would eat the `<p>` and leave "next" as body-level text, which `collect_paragraphs` drops;
  - the end of the input.
- Each restart moves `base` forward by at least one byte, so the loop always ends. Replace the `Err(_) => break` comment and the doc comment on `build_tree` to describe this.

## 4. Tests: `epub.rs` `#[cfg(test)]`
- `html_entities_are_decoded`: `texts("<p>a&nbsp;b&mdash;c</p>")` == `["a b—c"]`.
- `bare_ampersand_is_kept`: `texts("<p>Faith & Reason &amp; more</p>")` == `["Faith & Reason & more"]`, and `texts("<p>x &bogus; y</p>")` == `["x &bogus; y"]`.
- `parsing_resumes_after_a_broken_comment`: `texts("<p>one</p><!- bad -><p>two</p>")` == `["one", "two"]`.
- `unclosed_comment_loses_only_its_own_text`: `texts("<p>one</p><!-- x <p>two</p><p>three</p>")` == `["one", "two", "three"]`.
- `broken_markup_inside_a_paragraph_keeps_the_paragraph`: `texts("<p>before <![CDAT[x]]> after</p>")` == `["before after"]` (the `>` comes before the next `<`).
- `unescape_lenient` unit tests: an empty string, a `&` at the very end, and a `;` more than 32 bytes away (stays literal).
- The existing `unclosed_blocks_at_eof_keep_their_text` and the `test.epub` integration tests must pass unchanged.

## 5. README
- Limitation 5: remove it and renumber 6–9 (and the "(limitation 6)" / "(limitation 9)" references in limitation 9 and the roadmap). A short note goes under limitation 4 instead: books imported before this fix keep any text the old parser dropped until they're re-imported.
- "What's actually verified", `epub.rs` entry: HTML named entities and bare `&` are kept, and parsing resumes after markup that never closes, covered by the unit tests above.
- Roadmap: move "Recover from malformed XHTML…" to Done.

## Verification
1. `cargo test -p ebook_research_core`, `cargo clippy --workspace --all-targets`, `npx tsc --noEmit`, `npm test`.
2. Re-run the scratch scan over the six books: still no errors, and importing `understandingourmind.epub` into a fresh db gives the same chapter and paragraph counts as before, so well-formed books come out identical.
