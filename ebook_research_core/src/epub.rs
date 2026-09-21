//! Minimal EPUB parser: no dependency on a high-level "epub" crate, so we
//! have full control over paragraph splitting and offset tracking.
//!
//! EPUB is a zip file. The steps are:
//!   1. Read META-INF/container.xml to find the path to the OPF file.
//!   2. Parse the OPF: manifest (id -> href, properties) + spine (reading
//!      order of ids) + Dublin Core metadata (title, creator).
//!   3. For each spine item except the EPUB 3 navigation document, read its
//!      XHTML and split it into paragraphs
//!      by block-level tag, tracking char offsets within the chapter.

use anyhow::{anyhow, Context, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::HashMap;
use std::io::Read;

pub struct ParsedChapter {
    pub file_name: String,
    /// First `<h1>`/`<h2>` text, falling back to `file_name`.
    pub title: String,
    /// (char_start, char_end, text) within this chapter's joined plain text
    pub paragraphs: Vec<(usize, usize, String)>,
}

pub struct ParsedBook {
    pub title: Option<String>,
    pub author: Option<String>,
    pub chapters: Vec<ParsedChapter>,
}

const BLOCK_TAGS: &[&str] = &[
    "p",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "blockquote",
];

pub fn parse_epub(path: &str) -> Result<ParsedBook> {
    let file = std::fs::File::open(path).with_context(|| format!("opening {path}"))?;
    let mut zip = zip::ZipArchive::new(file)?;

    // --- Step 1: container.xml -> OPF path ---
    let opf_path = {
        let mut container = String::new();
        zip.by_name("META-INF/container.xml")?
            .read_to_string(&mut container)?;
        extract_opf_path(&container)?
    };

    // --- Step 2: parse OPF for manifest, spine, metadata ---
    let opf_xml = {
        let mut s = String::new();
        zip.by_name(&opf_path)?.read_to_string(&mut s)?;
        s
    };
    let opf_dir = std::path::Path::new(&opf_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let (manifest, spine_ids, title, author) = parse_opf(&opf_xml)?;

    // --- Step 3: walk spine, extract paragraphs per chapter ---
    let mut chapters = Vec::new();
    for id in spine_ids {
        let Some(item) = manifest.get(&id) else {
            continue;
        };
        // The nav document is the book's table of contents, not reading
        // content: as a chapter it clutters the reader's chapter list and
        // its entries produce search hits. `linear="no"` items and cover
        // pages are kept, since they can hold real text (notes etc.).
        if item.is_nav() {
            continue;
        }
        let href = &item.href;
        let full_path = if opf_dir.is_empty() {
            href.clone()
        } else {
            format!("{opf_dir}/{href}")
        };

        let xhtml = {
            let mut s = String::new();
            match zip.by_name(&full_path) {
                Ok(mut f) => f.read_to_string(&mut s)?,
                Err(_) => continue, // manifest referenced a missing file; skip rather than fail the whole book
            };
            s
        };

        let blocks = extract_paragraphs(&xhtml);
        if blocks.is_empty() {
            continue;
        }

        let title = blocks
            .iter()
            .find(|(is_heading, _)| *is_heading)
            .map(|(_, text)| text.clone())
            .unwrap_or_else(|| full_path.clone());

        let mut paragraphs = Vec::new();
        let mut cursor = 0usize;
        for (_, text) in blocks {
            let start = cursor;
            let end = start + text.chars().count();
            cursor = end + 2; // account for the "\n\n" joiner, matching the Python prototype
            paragraphs.push((start, end, text));
        }

        chapters.push(ParsedChapter {
            file_name: full_path,
            title,
            paragraphs,
        });
    }

    Ok(ParsedBook {
        title,
        author,
        chapters,
    })
}

fn extract_opf_path(container_xml: &str) -> Result<String> {
    let mut reader = Reader::from_str(container_xml);
    reader.trim_text(true);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Empty(e) | Event::Start(e) if e.name().as_ref() == b"rootfile" => {
                for attr in e.attributes().flatten() {
                    if attr.key.as_ref() == b"full-path" {
                        return Ok(attr.unescape_value()?.to_string());
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Err(anyhow!(
        "no <rootfile full-path=...> found in container.xml"
    ))
}

/// A manifest `<item>`: its path relative to the OPF, and its
/// space-separated `properties` (empty if absent).
struct ManifestItem {
    href: String,
    properties: String,
}

impl ManifestItem {
    /// True for the EPUB 3 navigation document (`properties` contains the
    /// `nav` token).
    fn is_nav(&self) -> bool {
        self.properties.split_ascii_whitespace().any(|p| p == "nav")
    }
}

/// (manifest id->item, spine idrefs in order, title, author)
type Opf = (
    HashMap<String, ManifestItem>,
    Vec<String>,
    Option<String>,
    Option<String>,
);

fn parse_opf(opf_xml: &str) -> Result<Opf> {
    let mut reader = Reader::from_str(opf_xml);
    reader.trim_text(true);
    let mut buf = Vec::new();

    let mut manifest = HashMap::new();
    let mut spine = Vec::new();
    let mut title = None;
    let mut author = None;
    let mut in_title_tag = false;
    let mut in_creator_tag = false;

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Empty(e) | Event::Start(e) => {
                let name = e.name();
                let local = local_name(name.as_ref());
                match local {
                    "item" => {
                        let mut id = None;
                        let mut href = None;
                        let mut properties = String::new();
                        for attr in e.attributes().flatten() {
                            match attr.key.as_ref() {
                                b"id" => id = Some(attr.unescape_value()?.to_string()),
                                b"href" => href = Some(attr.unescape_value()?.to_string()),
                                b"properties" => properties = attr.unescape_value()?.to_string(),
                                _ => {}
                            }
                        }
                        if let (Some(id), Some(href)) = (id, href) {
                            manifest.insert(id, ManifestItem { href, properties });
                        }
                    }
                    "itemref" => {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"idref" {
                                spine.push(attr.unescape_value()?.to_string());
                            }
                        }
                    }
                    "title" => in_title_tag = true,
                    "creator" => in_creator_tag = true,
                    _ => {}
                }
            }
            Event::Text(e) => {
                let text = e.unescape()?.to_string();
                if in_title_tag && title.is_none() {
                    title = Some(text.clone());
                }
                if in_creator_tag && author.is_none() {
                    author = Some(text.clone());
                }
            }
            Event::End(e) => {
                let name = e.name();
                let local = local_name(name.as_ref());
                if local == "title" {
                    in_title_tag = false;
                }
                if local == "creator" {
                    in_creator_tag = false;
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok((manifest, spine, title, author))
}

#[cfg(test)]
mod opf_tests {
    use super::parse_opf;

    #[test]
    fn only_the_nav_properties_token_marks_the_nav_document() {
        let opf = r#"<package><manifest>
            <item id="nav" href="nav.xhtml" properties="nav scripted"/>
            <item id="toc" href="toc.xhtml" properties="scripted  nav"/>
            <item id="cover" href="cover.xhtml" properties="cover-image"/>
            <item id="navish" href="navish.xhtml" properties="navigation"/>
            <item id="ch1" href="ch1.xhtml"/>
        </manifest></package>"#;
        let (manifest, ..) = parse_opf(opf).unwrap();
        let is_nav = |id: &str| manifest[id].is_nav();
        assert!(is_nav("nav"));
        assert!(is_nav("toc"));
        assert!(!is_nav("cover"));
        assert!(!is_nav("navish"));
        assert!(!is_nav("ch1"));
        assert_eq!(manifest["ch1"].href, "ch1.xhtml");
    }
}

/// Strips an XML namespace prefix, e.g. "dc:title" -> "title".
fn local_name(tag: &[u8]) -> &str {
    let s = std::str::from_utf8(tag).unwrap_or("");
    s.rsplit(':').next().unwrap_or(s)
}

/// Elements that never have children, even when sloppy markup opens them
/// with a bare `<br>` instead of `<br/>`.
const VOID_TAGS: &[&str] = &[
    "br", "hr", "img", "meta", "link", "col", "input", "base", "source",
];

/// Void elements that imply a break between the words either side.
const BREAK_TAGS: &[&str] = &["br", "hr", "img"];

/// Elements whose content is never prose.
const SKIP_TAGS: &[&str] = &["script", "style"];

/// A chapter's XHTML as a minimal tree: just element names and text.
enum Node {
    Text(String),
    Elem { name: String, children: Vec<Node> },
}

fn is_block(name: &str) -> bool {
    BLOCK_TAGS.contains(&name)
}

/// Walks a chapter's XHTML and returns `(is_heading, text)` per paragraph,
/// with inline whitespace normalized. `is_heading` is true only for
/// `<h1>`/`<h2>`.
///
/// A block element that directly contains text (not only inside nested
/// blocks) is a paragraph and emits all of its text, nested blocks
/// included. A block that only contains other blocks is a wrapper and is
/// recursed into. This keeps `<div>Intro <div>inner</div> tail</div>` as
/// one paragraph while still splitting a container `<div>` of paragraph
/// `<div>`s into its children.
fn extract_paragraphs(xhtml: &str) -> Vec<(bool, String)> {
    let mut paragraphs = Vec::new();
    collect_paragraphs(&build_tree(xhtml), &mut paragraphs);
    paragraphs
}

/// Parses XHTML into a list of top-level nodes, tolerating the malformed
/// markup real-world EPUBs contain: unclosed void tags, mismatched end
/// tags, and elements still open at EOF or at a parse error.
fn build_tree(xhtml: &str) -> Vec<Node> {
    let mut reader = Reader::from_str(xhtml);
    reader.trim_text(false);
    reader.check_end_names(false); // real-world XHTML is sometimes malformed
    let mut buf = Vec::new();

    // Open elements, outermost first. The first frame is the document root
    // and is never closed by an end tag.
    let mut stack: Vec<(String, Vec<Node>)> = vec![(String::new(), Vec::new())];

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref()).to_string();
                if VOID_TAGS.contains(&name.as_str()) {
                    push_child(
                        &mut stack,
                        Node::Elem {
                            name,
                            children: Vec::new(),
                        },
                    );
                } else {
                    stack.push((name, Vec::new()));
                }
            }
            Ok(Event::Empty(e)) => {
                let name = local_name(e.name().as_ref()).to_string();
                if !SKIP_TAGS.contains(&name.as_str()) {
                    push_child(
                        &mut stack,
                        Node::Elem {
                            name,
                            children: Vec::new(),
                        },
                    );
                }
            }
            Ok(Event::Text(e)) => {
                if let Ok(t) = e.unescape() {
                    push_child(&mut stack, Node::Text(t.into_owned()));
                }
            }
            Ok(Event::End(e)) => {
                // Close up to the nearest open element with this name; an
                // end tag with no matching open element is ignored.
                let qname = e.name();
                let name = local_name(qname.as_ref());
                if let Some(pos) = stack.iter().skip(1).rposition(|(n, _)| n == name) {
                    while stack.len() > pos + 1 {
                        close_top(&mut stack);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break, // tolerate malformed XHTML rather than aborting the whole book
            _ => {}
        }
        buf.clear();
    }

    // Implicitly close whatever is still open, keeping its text.
    while stack.len() > 1 {
        close_top(&mut stack);
    }
    stack
        .pop()
        .map(|(_, children)| children)
        .unwrap_or_default()
}

fn push_child(stack: &mut [(String, Vec<Node>)], node: Node) {
    if let Some((_, children)) = stack.last_mut() {
        children.push(node);
    }
}

/// Pops the innermost open element into its parent, dropping it entirely if
/// it's a `<script>` or `<style>`.
fn close_top(stack: &mut Vec<(String, Vec<Node>)>) {
    if let Some((name, children)) = stack.pop() {
        if !SKIP_TAGS.contains(&name.as_str()) {
            push_child(stack, Node::Elem { name, children });
        }
    }
}

/// Emits one paragraph per leaf block (see `extract_paragraphs`), recursing
/// through wrapper blocks and non-block elements.
fn collect_paragraphs(nodes: &[Node], out: &mut Vec<(bool, String)>) {
    for node in nodes {
        let Node::Elem { name, children } = node else {
            continue; // text outside any block is dropped
        };
        if is_block(name) && has_direct_text(children) {
            let cleaned = normalize_whitespace(&text_of(node));
            if !cleaned.is_empty() {
                out.push((name == "h1" || name == "h2", cleaned));
            }
        } else {
            collect_paragraphs(children, out);
        }
    }
}

/// True if any non-whitespace text sits directly in these children, or
/// inside a non-block child (so `<p><span>x</span></p>` counts).
fn has_direct_text(children: &[Node]) -> bool {
    children.iter().any(|child| match child {
        Node::Text(t) => !t.trim().is_empty(),
        Node::Elem { name, children } => !is_block(name) && has_direct_text(children),
    })
}

/// A node's whole text content, with separators as in `push_text`.
fn text_of(node: &Node) -> String {
    let mut text = String::new();
    push_text(node, &mut text);
    text
}

/// Appends a node's text verbatim: inline tags add nothing, so the source's
/// own spacing survives. A space is added only where the markup implies a
/// break: at `br`/`hr`/`img`, and around a block nested inside a paragraph.
fn push_text(node: &Node, out: &mut String) {
    match node {
        Node::Text(t) => out.push_str(t),
        Node::Elem { name, children } => {
            if BREAK_TAGS.contains(&name.as_str()) {
                out.push(' ');
                return;
            }
            let block = is_block(name);
            if block {
                out.push(' ');
            }
            for child in children {
                push_text(child, out);
            }
            if block {
                out.push(' ');
            }
        }
    }
}

fn normalize_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::extract_paragraphs;

    #[test]
    fn flags_h1_and_h2_as_headings() {
        let blocks = extract_paragraphs(
            "<body><h1>Title <em>One</em></h1><p>x</p><h2>Sub</h2><h3>Minor</h3></body>",
        );
        assert_eq!(
            blocks,
            vec![
                (true, "Title One".to_string()),
                (false, "x".to_string()),
                (true, "Sub".to_string()),
                (false, "Minor".to_string()),
            ]
        );
    }

    #[test]
    fn div_based_paragraphs_are_extracted() {
        let blocks = extract_paragraphs(
            "<body><div class=\"tx\">First <i>para</i> here</div>\
             <div class=\"atx1\"><div class=\"tx1\">Nested<br/>verse</div></div>\
             <div>Intro <div>inner</div> tail</div></body>",
        );
        let texts: Vec<_> = blocks.into_iter().map(|(_, t)| t).collect();
        assert_eq!(
            texts,
            vec!["First para here", "Nested verse", "Intro inner tail"]
        );
    }

    fn texts(xhtml: &str) -> Vec<String> {
        extract_paragraphs(xhtml)
            .into_iter()
            .map(|(_, t)| t)
            .collect()
    }

    #[test]
    fn nested_blocks_emit_one_paragraph_per_content_block() {
        assert_eq!(texts("<body><ul><li><p>x</p></li></ul></body>"), vec!["x"]);
        assert_eq!(
            texts("<body><ul><li><p>a</p><p>b</p></li></ul></body>"),
            vec!["a", "b"]
        );
        assert_eq!(
            texts("<body><div><div><p>x</p></div></div></body>"),
            vec!["x"]
        );
        assert_eq!(
            texts(
                "<body><div class=\"atx1\"><div class=\"tx1\">a</div>\
                 <div class=\"tx1\">b</div></div></body>"
            ),
            vec!["a", "b"]
        );
    }

    #[test]
    fn inline_tags_add_no_spaces() {
        assert_eq!(
            texts("<body><p><b>B</b>EFORE the rain</p></body>"),
            vec!["BEFORE the rain"]
        );
        assert_eq!(texts("<body><p>(<i>dhatu</i>)</p></body>"), vec!["(dhatu)"]);
        assert_eq!(
            texts("<body><p>as the <i>Buddha</i> said</p></body>"),
            vec!["as the Buddha said"]
        );
    }

    #[test]
    fn line_breaks_separate_words() {
        assert_eq!(
            texts("<body><p>Nested<br/>verse</p></body>"),
            vec!["Nested verse"]
        );
        assert_eq!(
            texts("<body><p>Nested<br>verse</p></body>"),
            vec!["Nested verse"]
        );
    }

    #[test]
    fn unclosed_blocks_at_eof_keep_their_text() {
        assert_eq!(texts("<p>one</p><p>two"), vec!["one", "two"]);
    }

    #[test]
    fn script_text_is_not_prose() {
        assert_eq!(
            texts("<body><p>text<script>var x = \"hello\";</script></p></body>"),
            vec!["text"]
        );
    }

    #[test]
    fn no_headings_means_no_title_candidate() {
        let blocks = extract_paragraphs("<body><p>only text</p><li>item</li></body>");
        assert!(blocks.iter().all(|(is_heading, _)| !is_heading));
    }
}
