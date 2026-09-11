//! Minimal EPUB parser: no dependency on a high-level "epub" crate, so we
//! have full control over paragraph splitting and offset tracking.
//!
//! EPUB is a zip file. The steps are:
//!   1. Read META-INF/container.xml to find the path to the OPF file.
//!   2. Parse the OPF: manifest (id -> href) + spine (reading order of ids)
//!      + Dublin Core metadata (title, creator).
//!   3. For each spine item, read its XHTML and split it into paragraphs
//!      by block-level tag, tracking char offsets within the chapter.

use anyhow::{anyhow, Context, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::HashMap;
use std::io::Read;

pub struct ParsedChapter {
    pub file_name: String,
    /// (char_start, char_end, text) within this chapter's joined plain text
    pub paragraphs: Vec<(usize, usize, String)>,
}

pub struct ParsedBook {
    pub title: Option<String>,
    pub author: Option<String>,
    pub chapters: Vec<ParsedChapter>,
}

const BLOCK_TAGS: &[&str] = &[
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote",
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
        let Some(href) = manifest.get(&id) else { continue };
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

        let paragraph_texts = extract_paragraphs(&xhtml);
        if paragraph_texts.is_empty() {
            continue;
        }

        let mut paragraphs = Vec::new();
        let mut cursor = 0usize;
        for text in paragraph_texts {
            let start = cursor;
            let end = start + text.chars().count();
            cursor = end + 2; // account for the "\n\n" joiner, matching the Python prototype
            paragraphs.push((start, end, text));
        }

        chapters.push(ParsedChapter {
            file_name: full_path,
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
    Err(anyhow!("no <rootfile full-path=...> found in container.xml"))
}

/// Returns (manifest id->href, spine idrefs in order, title, author)
fn parse_opf(
    opf_xml: &str,
) -> Result<(HashMap<String, String>, Vec<String>, Option<String>, Option<String>)> {
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
                        for attr in e.attributes().flatten() {
                            match attr.key.as_ref() {
                                b"id" => id = Some(attr.unescape_value()?.to_string()),
                                b"href" => href = Some(attr.unescape_value()?.to_string()),
                                _ => {}
                            }
                        }
                        if let (Some(id), Some(href)) = (id, href) {
                            manifest.insert(id, href);
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

/// Strips an XML namespace prefix, e.g. "dc:title" -> "title".
fn local_name(tag: &[u8]) -> &str {
    let s = std::str::from_utf8(tag).unwrap_or("");
    s.rsplit(':').next().unwrap_or(s)
}

/// Walks a chapter's XHTML and returns one string per block-level element,
/// with inline whitespace normalized. This mirrors the Python prototype's
/// BeautifulSoup-based extraction but via a streaming XML parser.
fn extract_paragraphs(xhtml: &str) -> Vec<String> {
    let mut reader = Reader::from_str(xhtml);
    reader.trim_text(false);
    reader.check_end_names(false); // real-world XHTML is sometimes malformed
    let mut buf = Vec::new();

    let mut paragraphs = Vec::new();
    let mut depth_stack: Vec<bool> = Vec::new(); // true = inside a block tag we care about
    let mut current = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let local = local_name(e.name().as_ref()).to_string();
                let is_block = BLOCK_TAGS.contains(&local.as_str());
                if is_block {
                    current.clear();
                }
                depth_stack.push(is_block);
            }
            Ok(Event::Text(e)) => {
                // Check the whole stack, not just the top: real-world XHTML
                // wraps paragraph text in inline tags (`<span>`, `<a>`, `<em>`,
                // ...), so the innermost open tag is rarely the block tag
                // itself even when we're still nested inside one.
                if depth_stack.iter().any(|&is_block| is_block) {
                    if let Ok(t) = e.unescape() {
                        current.push_str(&t);
                        current.push(' ');
                    }
                }
            }
            Ok(Event::End(_)) => {
                if let Some(was_block) = depth_stack.pop() {
                    if was_block {
                        let cleaned = normalize_whitespace(&current);
                        if !cleaned.is_empty() {
                            paragraphs.push(cleaned);
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
