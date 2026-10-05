//! Minimal EPUB parser: no dependency on a high-level "epub" crate, so we
//! have full control over paragraph splitting and offset tracking.
//!
//! EPUB is a zip file. The steps are:
//!   1. Read META-INF/container.xml to find the path to the OPF file.
//!   2. Parse the OPF: manifest (id -> href, properties) + spine (reading
//!      order of ids) + Dublin Core metadata (title, creator).
//!   3. Read the table of contents (the EPUB 3 nav document, else the
//!      EPUB 2 NCX) for each file's first label.
//!   4. For each spine item except the EPUB 3 navigation document, read its
//!      XHTML and split it into paragraphs
//!      by block-level tag, tracking char offsets within the chapter. A
//!      chapter's title is its first `<h1>`/`<h2>`, else its TOC label,
//!      else its `<head><title>`, else its file path.

use anyhow::{anyhow, Context, Result};
use quick_xml::events::{BytesEnd, BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Read;

pub struct ParsedChapter {
    pub file_name: String,
    /// First `<h1>`/`<h2>` text, else the file's first table-of-contents
    /// label, else its `<head><title>`, else `file_name`.
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

    let opf = parse_opf(&opf_xml)?;

    // --- Step 3: table of contents -> first label per file ---
    let toc = toc_titles(&mut zip, &opf_dir, &opf);

    // --- Step 4: walk spine, extract paragraphs per chapter ---
    let mut chapters = Vec::new();
    for id in &opf.spine {
        let Some(item) = opf.manifest.get(id) else {
            continue;
        };
        // The nav document is the book's table of contents, not reading
        // content: as a chapter it clutters the reader's chapter list and
        // its entries produce search hits. `linear="no"` items and cover
        // pages are kept, since they can hold real text (notes etc.).
        if item.is_nav() {
            continue;
        }
        let full_path = resolve_href(&opf_dir, &item.href);

        let xhtml = {
            let mut s = String::new();
            match zip.by_name(&full_path) {
                Ok(mut f) => f.read_to_string(&mut s)?,
                Err(_) => continue, // manifest referenced a missing file; skip rather than fail the whole book
            };
            s
        };

        let ChapterText {
            blocks,
            heading,
            head_title,
        } = extract_chapter(&xhtml);
        if blocks.is_empty() {
            continue;
        }
        let title = heading
            .or_else(|| toc.get(&full_path).cloned())
            .or(head_title)
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
        title: opf.title,
        author: opf.author,
        chapters,
    })
}

fn extract_opf_path(container_xml: &str) -> Result<String> {
    for event in LenientReader::new(container_xml) {
        match event {
            XmlEvent::Empty(e) | XmlEvent::Start(e) if e.name().as_ref() == "rootfile" => {
                for attr in e.attributes().flatten() {
                    if attr.key.as_ref() == "full-path" {
                        return Ok(attr.normalized_value(XmlVersion::Implicit1_0)?.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    Err(anyhow!(
        "no <rootfile full-path=...> found in container.xml"
    ))
}

/// A manifest `<item>`: its path relative to the OPF, its `media-type`,
/// and its space-separated `properties` (empty if absent).
struct ManifestItem {
    href: String,
    media_type: String,
    properties: String,
}

impl ManifestItem {
    /// True for the EPUB 3 navigation document (`properties` contains the
    /// `nav` token).
    fn is_nav(&self) -> bool {
        self.properties.split_ascii_whitespace().any(|p| p == "nav")
    }
}

struct Opf {
    /// Manifest id -> item.
    manifest: HashMap<String, ManifestItem>,
    /// Spine idrefs in reading order.
    spine: Vec<String>,
    /// The spine's `toc` attribute: the NCX's manifest id.
    toc_id: Option<String>,
    title: Option<String>,
    author: Option<String>,
}

fn parse_opf(opf_xml: &str) -> Result<Opf> {
    let mut manifest = HashMap::new();
    let mut spine = Vec::new();
    let mut toc_id = None;
    let mut title = None;
    let mut author = None;
    // The text so far of the open `<title>` or `<creator>`, which arrives
    // in pieces split at each entity.
    let mut title_text: Option<String> = None;
    let mut creator_text: Option<String> = None;

    for event in LenientReader::new(opf_xml) {
        match event {
            XmlEvent::Empty(e) | XmlEvent::Start(e) => {
                let name = e.name();
                let local = local_name(name.as_ref());
                match local {
                    "item" => {
                        let mut id = None;
                        let mut href = None;
                        let mut media_type = String::new();
                        let mut properties = String::new();
                        for attr in e.attributes().flatten() {
                            match attr.key.as_ref() {
                                "id" => {
                                    id = Some(
                                        attr.normalized_value(XmlVersion::Implicit1_0)?.to_string(),
                                    )
                                }
                                "href" => {
                                    href = Some(
                                        attr.normalized_value(XmlVersion::Implicit1_0)?.to_string(),
                                    )
                                }
                                "media-type" => {
                                    media_type =
                                        attr.normalized_value(XmlVersion::Implicit1_0)?.to_string()
                                }
                                "properties" => {
                                    properties =
                                        attr.normalized_value(XmlVersion::Implicit1_0)?.to_string()
                                }
                                _ => {}
                            }
                        }
                        if let (Some(id), Some(href)) = (id, href) {
                            manifest.insert(
                                id,
                                ManifestItem {
                                    href,
                                    media_type,
                                    properties,
                                },
                            );
                        }
                    }
                    "spine" => {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == "toc" {
                                toc_id = Some(
                                    attr.normalized_value(XmlVersion::Implicit1_0)?.to_string(),
                                );
                            }
                        }
                    }
                    "itemref" => {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == "idref" {
                                spine.push(
                                    attr.normalized_value(XmlVersion::Implicit1_0)?.to_string(),
                                );
                            }
                        }
                    }
                    "title" => title_text = Some(String::new()),
                    "creator" => creator_text = Some(String::new()),
                    _ => {}
                }
            }
            XmlEvent::Text(text) => {
                for open in [&mut title_text, &mut creator_text].into_iter().flatten() {
                    open.push_str(&text);
                }
            }
            XmlEvent::End(e) => {
                // The first non-empty `<title>`/`<creator>` wins.
                let (open, field) = match local_name(e.name().as_ref()) {
                    "title" => (&mut title_text, &mut title),
                    "creator" => (&mut creator_text, &mut author),
                    _ => continue,
                };
                if let Some(text) = open.take() {
                    let text = text.trim();
                    if field.is_none() && !text.is_empty() {
                        *field = Some(text.to_string());
                    }
                }
            }
        }
    }

    Ok(Opf {
        manifest,
        spine,
        toc_id,
        title,
        author,
    })
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
        let manifest = parse_opf(opf).unwrap().manifest;
        let is_nav = |id: &str| manifest[id].is_nav();
        assert!(is_nav("nav"));
        assert!(is_nav("toc"));
        assert!(!is_nav("cover"));
        assert!(!is_nav("navish"));
        assert!(!is_nav("ch1"));
        assert_eq!(manifest["ch1"].href, "ch1.xhtml");
    }

    #[test]
    fn opf_title_and_author_keep_entities_and_spacing() {
        let opf = r#"<package><metadata>
            <dc:title>  Faith &amp; Reason &mdash; Two  </dc:title>
            <dc:creator>A & B</dc:creator>
            <dc:title>Second</dc:title>
        </metadata></package>"#;
        let opf = parse_opf(opf).unwrap();
        assert_eq!(opf.title.as_deref(), Some("Faith & Reason \u{2014} Two"));
        assert_eq!(opf.author.as_deref(), Some("A & B"));
    }
}

const NCX_MEDIA_TYPE: &str = "application/x-dtbncx+xml";

/// Parses a TOC file into `(href, label)` pairs in document order.
type TocParser = fn(&str) -> Vec<(String, String)>;

/// Full zip path of each file the table of contents names -> its first
/// label. Reads the EPUB 3 nav document if there is one and it has any
/// entries, else the EPUB 2 NCX. A missing or unreadable TOC gives an
/// empty map: titles then fall back to `<head><title>`.
fn toc_titles<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    opf_dir: &str,
    opf: &Opf,
) -> HashMap<String, String> {
    let nav = opf.manifest.values().find(|item| item.is_nav());
    let ncx = opf
        .toc_id
        .as_ref()
        .and_then(|id| opf.manifest.get(id))
        .or_else(|| {
            opf.manifest
                .values()
                .find(|item| item.media_type == NCX_MEDIA_TYPE)
        });
    let sources: [(Option<&ManifestItem>, TocParser); 2] = [(nav, parse_nav_toc), (ncx, parse_ncx)];

    for (item, parse) in sources {
        let Some(item) = item else { continue };
        let path = resolve_href(opf_dir, &item.href);
        let mut xml = String::new();
        let Ok(mut file) = zip.by_name(&path) else {
            continue;
        };
        if file.read_to_string(&mut xml).is_err() {
            continue;
        }
        let toc_dir = path.rsplit_once('/').map_or("", |(dir, _)| dir);
        let mut titles = HashMap::new();
        for (href, label) in parse(&xml) {
            titles.entry(resolve_href(toc_dir, &href)).or_insert(label);
        }
        if !titles.is_empty() {
            return titles;
        }
    }
    HashMap::new()
}

/// `(href, label)` for each link in the nav document's `toc` nav (the
/// `<nav>` whose `epub:type` includes `toc`), in document order. Other
/// navs such as `landmarks` and `page-list` are ignored, as are links
/// with no href or an empty label.
fn parse_nav_toc(xml: &str) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    // Depth of nested `<nav>`s, and the depth at which the toc nav opened.
    let mut nav_depth = 0usize;
    let mut toc_depth = None;
    // The open link's href and label so far.
    let mut link: Option<(String, String)> = None;

    for event in LenientReader::new(xml) {
        match event {
            XmlEvent::Start(e) => match local_name(e.name().as_ref()) {
                "nav" => {
                    nav_depth += 1;
                    let is_toc = e.attributes().flatten().any(|attr| {
                        local_name(attr.key.as_ref()) == "type"
                            && attr
                                .normalized_value(XmlVersion::Implicit1_0)
                                .is_ok_and(|v| v.split_ascii_whitespace().any(|t| t == "toc"))
                    });
                    if is_toc && toc_depth.is_none() {
                        toc_depth = Some(nav_depth);
                    }
                }
                "a" if toc_depth.is_some() => {
                    link = e
                        .attributes()
                        .flatten()
                        .find(|attr| attr.key.as_ref() == "href")
                        .and_then(|attr| attr.normalized_value(XmlVersion::Implicit1_0).ok())
                        .map(|href| (href.into_owned(), String::new()));
                }
                _ => {}
            },
            XmlEvent::Text(text) => {
                if let Some((_, label)) = link.as_mut() {
                    label.push_str(&text);
                }
            }
            XmlEvent::End(e) => match local_name(e.name().as_ref()) {
                "nav" => {
                    if toc_depth == Some(nav_depth) {
                        toc_depth = None;
                    }
                    nav_depth = nav_depth.saturating_sub(1);
                }
                "a" => {
                    if let Some((href, label)) = link.take() {
                        let label = normalize_whitespace(&label);
                        if !label.is_empty() {
                            entries.push((href, label));
                        }
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    entries
}

/// `(src, label)` for each `navPoint` in an NCX, in document order, from
/// its `navLabel/text` and `content src`. A nested navPoint comes after
/// its parent, so a file's first entry is its outermost one. Entries with
/// no src or an empty label are dropped.
fn parse_ncx(xml: &str) -> Vec<(String, String)> {
    // One (label, src) per open navPoint. An entry is emitted once both
    // are known, which is at the parent's `<content>`, before any child.
    let mut open: Vec<(String, Option<String>, bool)> = Vec::new();
    let mut in_label_text = false;
    let mut entries = Vec::new();

    fn emit(entry: &mut (String, Option<String>, bool), out: &mut Vec<(String, String)>) {
        let (label, src, emitted) = entry;
        if *emitted {
            return;
        }
        if let Some(src) = src {
            *emitted = true;
            let label = normalize_whitespace(label);
            if !label.is_empty() {
                out.push((src.clone(), label));
            }
        }
    }

    for event in LenientReader::new(xml) {
        match event {
            XmlEvent::Start(e) if local_name(e.name().as_ref()) == "navPoint" => {
                open.push((String::new(), None, false));
            }
            XmlEvent::Start(e) if local_name(e.name().as_ref()) == "text" => {
                in_label_text = !open.is_empty();
            }
            XmlEvent::Start(e) | XmlEvent::Empty(e)
                if local_name(e.name().as_ref()) == "content" =>
            {
                let src = e
                    .attributes()
                    .flatten()
                    .find(|attr| attr.key.as_ref() == "src")
                    .and_then(|attr| attr.normalized_value(XmlVersion::Implicit1_0).ok())
                    .map(|src| src.into_owned());
                if let Some(entry) = open.last_mut() {
                    if entry.1.is_none() {
                        entry.1 = src;
                    }
                    emit(entry, &mut entries);
                }
            }
            XmlEvent::Text(text) if in_label_text => {
                if let Some(entry) = open.last_mut() {
                    if !entry.2 {
                        entry.0.push_str(&text);
                    }
                }
            }
            XmlEvent::End(e) => match local_name(e.name().as_ref()) {
                "text" => in_label_text = false,
                "navPoint" => {
                    if let Some(mut entry) = open.pop() {
                        emit(&mut entry, &mut entries);
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    entries
}

/// Resolves an href from a file in `base_dir` to a full zip path: drops
/// the `#fragment`, decodes `%XX` escapes and resolves `.`/`..` segments.
/// Spine paths go through this too, so both sides compare equal.
fn resolve_href(base_dir: &str, href: &str) -> String {
    let href = href.split('#').next().unwrap_or("");
    let href = percent_decode(href);
    let mut segments: Vec<&str> = base_dir.split('/').filter(|s| !s.is_empty()).collect();
    for segment in href.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            s => segments.push(s),
        }
    }
    segments.join("/")
}

/// Decodes `%XX` escapes; a `%` not followed by two hex digits is kept
/// as is, and invalid UTF-8 is replaced.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Strips an XML namespace prefix, e.g. "dc:title" -> "title".
fn local_name(tag: &str) -> &str {
    tag.rsplit(':').next().unwrap_or(tag)
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

/// A chapter's paragraphs and its title candidates from its own markup.
struct ChapterText {
    /// `(is_heading, text)` per paragraph; `is_heading` is true only for
    /// `<h1>`/`<h2>`.
    blocks: Vec<(bool, String)>,
    /// The first `<h1>`/`<h2>`.
    heading: Option<String>,
    /// The document's non-empty `<head><title>`.
    head_title: Option<String>,
}

/// Walks a chapter's XHTML and returns its paragraphs, with inline
/// whitespace normalized.
///
/// A block element that directly contains text (not only inside nested
/// blocks) is a paragraph and emits all of its text, nested blocks
/// included. A block that only contains other blocks is a wrapper and is
/// recursed into. This keeps `<div>Intro <div>inner</div> tail</div>` as
/// one paragraph while still splitting a container `<div>` of paragraph
/// `<div>`s into its children.
///
/// Also returns the chapter's first `<h1>`/`<h2>` and its `<head><title>`
/// separately; `parse_epub` puts the book's TOC label between them. Front
/// matter such as a half-title page often has no heading but does have a
/// `<title>`.
fn extract_chapter(xhtml: &str) -> ChapterText {
    let tree = build_tree(xhtml);
    let mut blocks = Vec::new();
    collect_paragraphs(&tree, &mut blocks);
    let heading = blocks
        .iter()
        .find(|(is_heading, _)| *is_heading)
        .map(|(_, text)| text.clone());
    ChapterText {
        blocks,
        heading,
        head_title: head_title(&tree),
    }
}

/// The non-empty text of `<html><head><title>`. Only `html` and `head` are
/// descended into, so a `<title>` in the body (e.g. inside an SVG) is
/// ignored.
fn head_title(nodes: &[Node]) -> Option<String> {
    nodes.iter().find_map(|node| match node {
        Node::Elem { name, children } if name == "html" => head_title(children),
        Node::Elem { name, children } if name == "head" => {
            children.iter().find_map(|child| match child {
                Node::Elem { name, .. } if name == "title" => {
                    Some(normalize_whitespace(&text_of(child))).filter(|t| !t.is_empty())
                }
                _ => None,
            })
        }
        _ => None,
    })
}

/// Parses XHTML into a list of top-level nodes, tolerating the malformed
/// markup real-world EPUBs contain: unclosed void tags, mismatched end
/// tags, and elements still open at EOF. Broken markup and bare `&`s are
/// handled by `LenientReader`; open elements are kept across its
/// restarts, so the text that follows still lands in the paragraph it
/// belongs to.
fn build_tree(xhtml: &str) -> Vec<Node> {
    // Open elements, outermost first. The first frame is the document root
    // and is never closed by an end tag.
    let mut stack: Vec<(String, Vec<Node>)> = vec![(String::new(), Vec::new())];

    for event in LenientReader::new(xhtml) {
        match event {
            XmlEvent::Start(e) => {
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
            XmlEvent::Empty(e) => {
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
            XmlEvent::Text(text) => {
                // Text arrives in pieces split at each entity, so join it
                // back into one node.
                if let Some((_, children)) = stack.last_mut() {
                    match children.last_mut() {
                        Some(Node::Text(prev)) => prev.push_str(&text),
                        _ => children.push(Node::Text(text.into_owned())),
                    }
                }
            }
            XmlEvent::End(e) => {
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
        }
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

/// An event from `LenientReader`.
enum XmlEvent<'a> {
    Start(BytesStart<'a>),
    Empty(BytesStart<'a>),
    End(BytesEnd<'a>),
    /// Text with its entities resolved. Entities come from quick-xml as
    /// separate events, so one text node can arrive in several pieces.
    Text(Cow<'a, str>),
}

/// The start, end and text events of an XML or XHTML document, never
/// failing on malformed markup. Comments, CDATA, doctypes and processing
/// instructions are skipped.
///
/// quick-xml gives up on markup that never closes (a broken comment like
/// `<!- x ->`, an unclosed `<!--`, a misspelt `<![CDAT[`) and on a bare
/// `&` ("Faith & Reason"), and its reader can't carry on after that. So
/// on an error a bare `&` is returned as text, or else the broken markup
/// is skipped (see `skip_broken_markup`), and a fresh reader starts after
/// it.
struct LenientReader<'a> {
    xml: &'a str,
    /// The byte offset in `xml` the current reader started at.
    base: usize,
    reader: Reader<&'a [u8]>,
}

impl<'a> LenientReader<'a> {
    fn new(xml: &'a str) -> Self {
        LenientReader {
            xml,
            base: 0,
            reader: Self::reader_at(xml, 0),
        }
    }

    fn reader_at(xml: &'a str, base: usize) -> Reader<&'a [u8]> {
        let mut reader = Reader::from_str(&xml[base..]);
        let config = reader.config_mut();
        // Real-world XHTML is sometimes malformed: `build_tree` matches end
        // tags itself.
        config.check_end_names = false;
        config.allow_unmatched_ends = true;
        reader
    }

    fn restart(&mut self, at: usize) {
        self.base = at;
        self.reader = Self::reader_at(self.xml, at);
    }
}

impl<'a> Iterator for LenientReader<'a> {
    type Item = XmlEvent<'a>;

    fn next(&mut self) -> Option<XmlEvent<'a>> {
        loop {
            let at = self.base + self.reader.buffer_position() as usize;
            match self.reader.read_event() {
                Ok(Event::Start(e)) => return Some(XmlEvent::Start(e)),
                Ok(Event::Empty(e)) => return Some(XmlEvent::Empty(e)),
                Ok(Event::End(e)) => return Some(XmlEvent::End(e)),
                Ok(Event::Text(e)) => return Some(XmlEvent::Text(e.into_inner())),
                Ok(Event::GeneralRef(e)) => return Some(XmlEvent::Text(resolve_ref(&e).into())),
                Ok(Event::Eof) => return None,
                Ok(_) => {}
                // The reader is stuck at EOF after an error, so start a new
                // one past the `&` or the broken markup.
                Err(_) if self.xml.as_bytes().get(at) == Some(&b'&') => {
                    self.restart(at + 1);
                    return Some(XmlEvent::Text(Cow::Borrowed("&")));
                }
                Err(_) => self.restart(skip_broken_markup(self.xml, at)),
            }
        }
    }
}

/// The text of the entity or character reference `&name;`. With
/// quick-xml's `escape-html` feature every HTML5 named entity (`&nbsp;`,
/// `&mdash;`) is known; an unknown `&foo;` is kept as written.
fn resolve_ref(name: &str) -> String {
    let written = format!("&{name};");
    match quick_xml::escape::unescape(&written) {
        Ok(text) => text.into_owned(),
        Err(_) => written,
    }
}

/// Where parsing resumes after the broken markup starting at byte `at`:
/// just past the next `>` (so `<![CDAT[x]]> after` keeps " after"), or
/// just before the next `<` if that comes first (so an unclosed
/// `<!-- x <p>next</p>` keeps the `<p>`), or the end of the input. Always
/// past `at`, so `LenientReader`'s restarts end.
fn skip_broken_markup(xhtml: &str, at: usize) -> usize {
    let bytes = xhtml.as_bytes();
    let from = (at + 1).min(bytes.len());
    bytes[from..]
        .iter()
        .position(|&b| b == b'>' || b == b'<')
        .map_or(bytes.len(), |i| {
            let pos = from + i;
            if bytes[pos] == b'>' {
                pos + 1
            } else {
                pos
            }
        })
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
    use super::extract_chapter;

    fn extract_paragraphs(xhtml: &str) -> Vec<(bool, String)> {
        extract_chapter(xhtml).blocks
    }

    /// The title from the chapter's own markup: heading, else head title.
    fn title(xhtml: &str) -> Option<String> {
        let chapter = extract_chapter(xhtml);
        chapter.heading.or(chapter.head_title)
    }

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
    fn html_entities_are_decoded() {
        assert_eq!(texts("<p>a&nbsp;b&mdash;c</p>"), vec!["a b\u{2014}c"]);
    }

    #[test]
    fn bare_ampersand_is_kept() {
        assert_eq!(
            texts("<p>Faith & Reason &amp; more</p>"),
            vec!["Faith & Reason & more"]
        );
        assert_eq!(texts("<p>x &bogus; y</p>"), vec!["x &bogus; y"]);
    }

    #[test]
    fn parsing_resumes_after_a_broken_comment() {
        assert_eq!(texts("<p>one</p><!- bad -><p>two</p>"), vec!["one", "two"]);
    }

    #[test]
    fn unclosed_comment_loses_only_its_own_text() {
        assert_eq!(
            texts("<p>one</p><!-- x <p>two</p><p>three</p>"),
            vec!["one", "two", "three"]
        );
    }

    #[test]
    fn broken_markup_inside_a_paragraph_keeps_the_paragraph() {
        assert_eq!(
            texts("<p>before <![CDAT[x]]> after</p>"),
            vec!["before after"]
        );
    }

    #[test]
    fn entities_and_bare_ampersands_in_text() {
        assert_eq!(texts("<p>A &amp; B &</p>"), vec!["A & B &"]);
        assert_eq!(
            texts("<p>& &CounterClockwiseContourIntegral;</p>"),
            vec!["& \u{2233}"]
        );
        assert_eq!(
            texts("<p>&#x41;&#66; &bogus; a & b; c</p>"),
            vec!["AB &bogus; a & b; c"]
        );
        // A bare `&` never swallows the markup up to a later `;`.
        assert_eq!(
            texts("<p>Faith & Reason</p><p>x;</p>"),
            vec!["Faith & Reason", "x;"]
        );
    }

    #[test]
    fn stray_end_tags_are_ignored() {
        assert_eq!(texts("</div><p>a</p></p></div><p>b</p>"), vec!["a", "b"]);
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

    #[test]
    fn title_falls_back_to_head_title() {
        let xhtml = "<html><head><title> Front\n  Matter </title></head>\
                     <body><p>text</p></body></html>";
        assert_eq!(title(xhtml).as_deref(), Some("Front Matter"));
    }

    #[test]
    fn heading_wins_over_head_title() {
        let xhtml = "<html><head><title>Book</title></head>\
                     <body><p>intro</p><h2>Chapter One</h2></body></html>";
        assert_eq!(title(xhtml).as_deref(), Some("Chapter One"));
    }

    #[test]
    fn empty_or_missing_head_title_gives_none() {
        assert_eq!(
            title("<html><head><title> </title></head><body><p>x</p></body></html>"),
            None
        );
        assert_eq!(
            title("<html><head></head><body><p>x</p></body></html>"),
            None
        );
    }

    #[test]
    fn title_in_body_is_ignored() {
        let xhtml = "<html><head></head><body><svg><title>Cover image</title></svg>\
                     <p>text</p></body></html>";
        assert_eq!(title(xhtml), None);
    }
}

#[cfg(test)]
mod toc_tests {
    use super::{parse_epub, parse_nav_toc, parse_ncx, resolve_href};
    use std::io::Write;

    fn pairs(entries: &[(&str, &str)]) -> Vec<(String, String)> {
        entries
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn nav_toc_reads_only_the_toc_nav() {
        let xml = r#"<html xmlns:epub="http://www.idpf.org/2007/ops"><body>
            <nav epub:type="landmarks"><ol>
                <li><a href="cover.xhtml">Cover</a></li>
            </ol></nav>
            <nav epub:type="toc" id="toc"><ol>
                <li><a href="ch1.xhtml">1:  The Art
                    of <em>Transforming</em></a>
                    <ol><li><a href="ch1.xhtml#s1">Section</a></li></ol></li>
                <li><a href="ch2.xhtml"> </a></li>
                <li><a href="ch3.xhtml">Three</a></li>
            </ol></nav>
            <nav epub:type="page-list"><ol>
                <li><a href="ch1.xhtml#p1">1</a></li>
            </ol></nav>
        </body></html>"#;
        assert_eq!(
            parse_nav_toc(xml),
            pairs(&[
                ("ch1.xhtml", "1: The Art of Transforming"),
                ("ch1.xhtml#s1", "Section"),
                ("ch3.xhtml", "Three"),
            ])
        );
    }

    #[test]
    fn ncx_lists_nested_nav_points_parent_first() {
        let xml = r#"<ncx><navMap>
            <navPoint id="n1" playOrder="1">
                <navLabel><text>Chapter  1</text></navLabel>
                <content src="c01.html"/>
                <navPoint id="n2" playOrder="2">
                    <navLabel><text>Section</text></navLabel>
                    <content src="c01.html#h1"/>
                </navPoint>
            </navPoint>
            <navPoint id="n3" playOrder="3">
                <navLabel><text>Chapter 2</text></navLabel>
                <content src="c02.html"></content>
            </navPoint>
        </navMap></ncx>"#;
        assert_eq!(
            parse_ncx(xml),
            pairs(&[
                ("c01.html", "Chapter 1"),
                ("c01.html#h1", "Section"),
                ("c02.html", "Chapter 2"),
            ])
        );
    }

    #[test]
    fn toc_labels_keep_entities() {
        let nav = r#"<html><body><nav epub:type="toc"><ol>
            <li><a href="c.xhtml">One&nbsp;&amp; Two</a></li>
        </ol></nav></body></html>"#;
        assert_eq!(parse_nav_toc(nav), pairs(&[("c.xhtml", "One & Two")]));
        let ncx = r#"<ncx><navMap><navPoint>
            <navLabel><text>One &amp; Two</text></navLabel>
            <content src="c.xhtml"/>
        </navPoint></navMap></ncx>"#;
        assert_eq!(parse_ncx(ncx), pairs(&[("c.xhtml", "One & Two")]));
    }

    #[test]
    fn resolve_href_normalizes_paths() {
        assert_eq!(
            resolve_href("OEBPS", "xhtml/Ch%201.xhtml#ch1"),
            "OEBPS/xhtml/Ch 1.xhtml"
        );
        assert_eq!(
            resolve_href("OEBPS/nav", "../Text/a.html"),
            "OEBPS/Text/a.html"
        );
        assert_eq!(resolve_href("", "./a.html"), "a.html");
        assert_eq!(resolve_href("", "100%.html"), "100%.html");
    }

    /// Writes an EPUB with the given files (besides container.xml) to a
    /// temp path.
    fn write_epub(name: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("pitaka-{name}-{}.epub", std::process::id()));
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        let container = r#"<container><rootfiles>
            <rootfile full-path="OEBPS/content.opf"/>
        </rootfiles></container>"#;
        for (file, content) in [("META-INF/container.xml", container)].iter().chain(files) {
            zip.start_file(*file, options).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    fn chapter(head_title: &str, body: &str) -> String {
        format!("<html><head><title>{head_title}</title></head><body>{body}</body></html>")
    }

    fn titles(path: &std::path::Path) -> Vec<String> {
        let book = parse_epub(path.to_str().unwrap()).unwrap();
        std::fs::remove_file(path).unwrap();
        book.chapters.into_iter().map(|c| c.title).collect()
    }

    const OPF: &str = r#"<package><manifest>
        <item id="nav" href="nav/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        <item id="h" href="Text/heading.xhtml" media-type="application/xhtml+xml"/>
        <item id="d" href="Text/div%20heading.xhtml" media-type="application/xhtml+xml"/>
        <item id="n" href="Text/none.xhtml" media-type="application/xhtml+xml"/>
    </manifest><spine toc="ncx">
        <itemref idref="nav"/><itemref idref="h"/><itemref idref="d"/><itemref idref="n"/>
    </spine></package>"#;

    const NCX: &str = r#"<ncx><navMap>
        <navPoint><navLabel><text>NCX heading</text></navLabel>
            <content src="Text/heading.xhtml"/></navPoint>
        <navPoint><navLabel><text>NCX div</text></navLabel>
            <content src="Text/div%20heading.xhtml#top"/></navPoint>
    </navMap></ncx>"#;

    #[test]
    fn heading_then_toc_then_head_title() {
        let nav = r#"<html><body><nav epub:type="toc"><ol>
            <li><a href="../Text/heading.xhtml">Nav heading</a></li>
            <li><a href="../Text/div%20heading.xhtml">1: The Art of Transforming Suffering</a></li>
        </ol></nav></body></html>"#;
        let path = write_epub(
            "precedence",
            &[
                ("OEBPS/content.opf", OPF),
                ("OEBPS/nav/nav.xhtml", nav),
                ("OEBPS/toc.ncx", NCX),
                (
                    "OEBPS/Text/heading.xhtml",
                    &chapter("Book", "<h2>Chapter One</h2><p>x</p>"),
                ),
                (
                    "OEBPS/Text/div heading.xhtml",
                    &chapter("Book", r#"<div class="ct">1 The Art</div><p>x</p>"#),
                ),
                ("OEBPS/Text/none.xhtml", &chapter("Half Title", "<p>x</p>")),
            ],
        );
        assert_eq!(
            titles(&path),
            [
                "Chapter One",
                "1: The Art of Transforming Suffering",
                "Half Title"
            ]
        );
    }

    #[test]
    fn empty_nav_falls_back_to_ncx() {
        let nav = r#"<html><body><nav epub:type="toc"><ol></ol></nav></body></html>"#;
        let path = write_epub(
            "ncx-fallback",
            &[
                ("OEBPS/content.opf", OPF),
                ("OEBPS/nav/nav.xhtml", nav),
                ("OEBPS/toc.ncx", NCX),
                ("OEBPS/Text/heading.xhtml", &chapter("Book", "<p>x</p>")),
                ("OEBPS/Text/div heading.xhtml", &chapter("Book", "<p>x</p>")),
                ("OEBPS/Text/none.xhtml", &chapter("Half Title", "<p>x</p>")),
            ],
        );
        assert_eq!(titles(&path), ["NCX heading", "NCX div", "Half Title"]);
    }
}
