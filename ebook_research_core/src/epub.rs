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

/// Walks a chapter's XHTML and returns `(is_heading, text)` per block-level
/// element, with inline whitespace normalized. `is_heading` is true only for
/// `<h1>`/`<h2>`. This mirrors the Python prototype's BeautifulSoup-based
/// extraction but via a streaming XML parser.
fn extract_paragraphs(xhtml: &str) -> Vec<(bool, String)> {
    let mut reader = Reader::from_str(xhtml);
    reader.trim_text(false);
    reader.check_end_names(false); // real-world XHTML is sometimes malformed
    let mut buf = Vec::new();

    let mut paragraphs = Vec::new();
    // (is_block, is_heading) per open tag
    let mut depth_stack: Vec<(bool, bool)> = Vec::new();
    let mut current = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let local = local_name(e.name().as_ref()).to_string();
                let is_block = BLOCK_TAGS.contains(&local.as_str());
                if is_block {
                    // Emit any text the enclosing block collected before this
                    // nested one opened (e.g. `<div>intro<div>...</div></div>`)
                    // rather than dropping it.
                    if let Some(&(_, parent_heading)) = depth_stack.iter().rev().find(|&&(b, _)| b)
                    {
                        let cleaned = normalize_whitespace(&current);
                        if !cleaned.is_empty() {
                            paragraphs.push((parent_heading, cleaned));
                        }
                    }
                    current.clear();
                }
                depth_stack.push((is_block, local == "h1" || local == "h2"));
            }
            Ok(Event::Text(e)) => {
                // Check the whole stack, not just the top: real-world XHTML
                // wraps paragraph text in inline tags (`<span>`, `<a>`, `<em>`,
                // ...), so the innermost open tag is rarely the block tag
                // itself even when we're still nested inside one.
                if depth_stack.iter().any(|&(is_block, _)| is_block) {
                    if let Ok(t) = e.unescape() {
                        current.push_str(&t);
                        current.push(' ');
                    }
                }
            }
            Ok(Event::End(_)) => {
                if let Some((was_block, was_heading)) = depth_stack.pop() {
                    if was_block {
                        let cleaned = normalize_whitespace(&current);
                        if !cleaned.is_empty() {
                            paragraphs.push((was_heading, cleaned));
                        }
                        current.clear();
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break, // tolerate malformed XHTML rather than aborting the whole book
            _ => {}
        }
        buf.clear();
    }

    paragraphs
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
            vec!["First para here", "Nested verse", "Intro", "inner", "tail"]
        );
    }

    #[test]
    fn no_headings_means_no_title_candidate() {
        let blocks = extract_paragraphs("<body><p>only text</p><li>item</li></body>");
        assert!(blocks.iter().all(|(is_heading, _)| !is_heading));
    }
}
