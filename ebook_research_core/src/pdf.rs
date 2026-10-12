//! PDF parser for books with a text layer (docs/plans/pdf-import.md). It
//! produces the same `ParsedBook` as `parse_epub`, so importing, search and
//! the reader treat both formats alike.
//!
//! The steps are:
//!   1. Load the document with lopdf, decrypting it if it only has an
//!      owner password.
//!   2. Extract each page's text with pdf-extract, guarded against its
//!      panics. A PDF with almost no text is refused as a scan.
//!   3. Drop running headers and footers, split each page into paragraphs
//!      on blank lines (joining hyphenated line breaks), and join a
//!      paragraph that runs onto the next page.
//!   4. Cut chapters at the pages of the outline's top-level entries, else
//!      into blocks of `PAGES_PER_CHAPTER` pages.
//!   5. Take the title from the document metadata, else the largest text
//!      on the first pages, else the most frequent running header, else the
//!      file name.

use crate::epub::{normalize_whitespace, resolve_ref, ParsedBook, ParsedChapter};
use anyhow::{anyhow, bail, Context, Result};
use pdf_extract::{
    output_doc_page, Document, MediaBox, Object, OutputDev, OutputError, PlainTextOutput, Transform,
};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::any::Any;
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

/// Fewer non-whitespace characters than this per page, on average, means
/// the PDF is a scan. A text page has thousands; a scan has none, or a few
/// from stamped page numbers or a short text cover.
const MIN_CHARS_PER_PAGE: usize = 50;

/// The chapter size for a PDF without an outline.
const PAGES_PER_CHAPTER: usize = 20;

/// A first or last line repeated at that position on this many pages is a
/// running header or footer.
const MIN_REPEATS: usize = 3;

/// How many pages are searched for the title page's large text.
const TITLE_PAGES: u32 = 5;

/// The title page's text must be at least this many times the body size.
const TITLE_SCALE: f64 = 1.5;

/// The title of the chapter holding the pages before the outline's first
/// entry.
const FRONT_MATTER: &str = "Front matter";

pub fn parse_pdf(path: &str) -> Result<ParsedBook> {
    let bytes = std::fs::read(path).with_context(|| format!("opening {path}"))?;
    let doc = load(path, &bytes)?;

    let pages = guarded(|| page_texts(&doc))
        .map_err(|reason| anyhow!("couldn't read the text in {path}: {reason}"))?;
    if pages.is_empty() {
        bail!("{path} has no pages");
    }
    let chars: usize = pages
        .iter()
        .map(|p| p.chars().filter(|c| !c.is_whitespace()).count())
        .sum();
    if chars < MIN_CHARS_PER_PAGE * pages.len() {
        bail!(
            "{path} has no text layer (it's probably scanned), and Pitaka can't search \
             scanned PDFs yet"
        );
    }

    let mut lines: Vec<Vec<String>> = pages
        .iter()
        .map(|p| p.lines().map(str::to_string).collect())
        .collect();
    let header_counts = strip_running_lines(&mut lines);
    let mut paragraphs: Vec<Vec<String>> = lines.iter().map(|l| page_paragraphs(l)).collect();
    join_across_pages(&mut paragraphs);

    let mut spans = outline_spans(outline_entries(&doc), pages.len());
    if spans.is_empty() {
        spans = page_block_spans(pages.len());
    }
    let chapters = build_chapters(&paragraphs, &spans);

    let stem = std::path::Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let chapter_titles: Vec<&str> = chapters.iter().map(|c| c.title.as_str()).collect();
    let title = book_title(&doc, &pages, &header_counts, &chapter_titles, &stem);
    let author = book_author(&doc);

    Ok(ParsedBook {
        title: Some(title),
        author,
        format: "pdf",
        chapters,
    })
}

/// Loads the document, decrypting it with the empty password if it's
/// encrypted. That opens PDFs that only restrict printing or copying,
/// which have an owner password but no user password.
fn load(path: &str, bytes: &[u8]) -> Result<Document> {
    let mut doc = guarded(|| Ok(Document::load_mem(bytes)?))
        .map_err(|reason| anyhow!("couldn't read {path} as a PDF: {reason}"))?;
    if doc.is_encrypted() && doc.decrypt("").is_err() {
        bail!("{path} is password-protected");
    }
    Ok(doc)
}

/// Runs `f`, turning a panic into an error. pdf-extract panics on fonts
/// and encodings it doesn't understand, and a release build would abort
/// on a panic without this (the workspace's release profile unwinds for
/// it).
fn guarded<T>(f: impl FnOnce() -> Result<T, OutputError>) -> Result<T, String> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(e)) => Err(e.to_string()),
        Err(payload) => Err(panic_reason(payload)),
    }
}

fn panic_reason(payload: Box<dyn Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "the PDF uses a feature Pitaka can't read".to_string()
    }
}

/// Each page's text, in page order. Unlike pdf-extract's own
/// `extract_text_from_mem_by_pages`, a page that fails is an error rather
/// than the silent end of the book.
fn page_texts(doc: &Document) -> Result<Vec<String>, OutputError> {
    let mut pages = Vec::new();
    for page_num in doc.get_pages().into_keys() {
        let mut text = String::new();
        output_doc_page(doc, &mut PlainTextOutput::new(&mut text), page_num)?;
        pages.push(text);
    }
    Ok(pages)
}

/// Removes running headers and footers from each page's lines, and returns
/// how many pages each first-line key (see `running_key`) heads, for
/// `header_title`.
///
/// A page's first or last non-blank line is dropped if its key is at that
/// position on `MIN_REPEATS` or more pages, or if it's only a page number.
/// Dropped lines are blanked rather than removed, which doesn't change
/// the paragraphs since they're at a page's edge.
fn strip_running_lines(pages: &mut [Vec<String>]) -> HashMap<String, usize> {
    let ends: Vec<Option<(usize, usize)>> = pages
        .iter()
        .map(|lines| {
            let first = lines.iter().position(|l| !l.trim().is_empty())?;
            let last = lines.iter().rposition(|l| !l.trim().is_empty())?;
            Some((first, last))
        })
        .collect();

    let mut firsts: HashMap<String, usize> = HashMap::new();
    let mut lasts: HashMap<String, usize> = HashMap::new();
    for (lines, end) in pages.iter().zip(&ends) {
        let Some((first, last)) = *end else { continue };
        let key = running_key(&lines[first]);
        if !key.is_empty() {
            *firsts.entry(key).or_default() += 1;
        }
        let key = running_key(&lines[last]);
        if last != first && !key.is_empty() {
            *lasts.entry(key).or_default() += 1;
        }
    }

    let is_running = |line: &str, counts: &HashMap<String, usize>| {
        let key = running_key(line);
        key.is_empty() || counts.get(&key).is_some_and(|&n| n >= MIN_REPEATS)
    };
    for (lines, end) in pages.iter_mut().zip(&ends) {
        let Some((first, last)) = *end else { continue };
        if last != first && is_running(&lines[last], &lasts) {
            lines[last].clear();
        }
        if is_running(&lines[first], &firsts) {
            lines[first].clear();
        }
    }
    firsts
}

/// A line with a leading or trailing page number removed and its
/// whitespace collapsed, so "6   Buddhist Life/Buddhist Path" and
/// "Buddhist Life/Buddhist Path   7" share the key "Buddhist Life/Buddhist
/// Path". Empty for a line that's only a page number.
fn running_key(line: &str) -> String {
    let mut words: Vec<&str> = line.split_whitespace().collect();
    if words.first().is_some_and(|w| is_page_number(w)) {
        words.remove(0);
    }
    if words.last().is_some_and(|w| is_page_number(w)) {
        words.pop();
    }
    words.join(" ")
}

/// An arabic page number, or a roman one up to 199 in one case ("xiv",
/// "XIV"). The cap keeps words like "mix" (1009) from counting.
fn is_page_number(word: &str) -> bool {
    if !word.is_empty() && word.len() <= 4 && word.bytes().all(|b| b.is_ascii_digit()) {
        return true;
    }
    let lower = word.to_ascii_lowercase();
    if word != lower && word != word.to_ascii_uppercase() {
        return false;
    }
    roman_value(&lower).is_some_and(|n| (1..200).contains(&n))
}

/// The value of a lowercase roman numeral written the standard way, so
/// "iv" is 4 but "iiii" and "mid" aren't numerals.
fn roman_value(s: &str) -> Option<u32> {
    const DIGITS: [(u32, &str); 13] = [
        (1000, "m"),
        (900, "cm"),
        (500, "d"),
        (400, "cd"),
        (100, "c"),
        (90, "xc"),
        (50, "l"),
        (40, "xl"),
        (10, "x"),
        (9, "ix"),
        (5, "v"),
        (4, "iv"),
        (1, "i"),
    ];
    if s.is_empty() || !s.chars().all(|c| "ivxlcdm".contains(c)) {
        return None;
    }
    let mut value = 0;
    let mut rest = s;
    for (n, digit) in DIGITS {
        // Only "m" may repeat more than three times, and the cap above
        // makes that moot.
        let mut repeats = 0;
        while let Some(after) = rest.strip_prefix(digit) {
            rest = after;
            value += n;
            repeats += 1;
            if repeats > 3 || (digit.len() == 2 && repeats > 1) {
                return None;
            }
        }
    }
    // Writing the value back out catches orders like "ivi" or "vv".
    (rest.is_empty() && to_roman(value, &DIGITS) == s).then_some(value)
}

fn to_roman(mut n: u32, digits: &[(u32, &str)]) -> String {
    let mut out = String::new();
    for &(value, digit) in digits {
        while n >= value {
            out.push_str(digit);
            n -= value;
        }
    }
    out
}

/// Splits a page's lines into paragraphs on blank lines, except after a
/// soft hyphen, whose word goes on past the gap. Within a paragraph,
/// lines are joined by `join_line`.
fn page_paragraphs(lines: &[String]) -> Vec<String> {
    let mut paragraphs = Vec::new();
    let mut current = String::new();
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            if !current.is_empty() && !current.ends_with('\u{ad}') {
                paragraphs.push(normalize_whitespace(&current));
                current.clear();
            }
        } else {
            join_line(&mut current, line);
        }
    }
    if !current.is_empty() {
        paragraphs.push(normalize_whitespace(&current));
    }
    paragraphs
}

/// Appends `line` to `text` with a space, except after a letter and a
/// hyphen. Then a following lowercase letter means a word broken across
/// the line ("gen-" / "erosity" gives "generosity"), and anything else a
/// hyphenated compound ("Attribution-" / "NonCommercial" gives
/// "Attribution-NonCommercial"). A soft hyphen (U+00AD), which OCR tools
/// like ABBYY FineReader put at line ends, only ever marks a broken word,
/// so it's dropped, with any stray space OCR left before it, and the halves
/// joined whatever case follows.
fn join_line(text: &mut String, line: &str) {
    if text.is_empty() {
        text.push_str(line);
        return;
    }
    if text.ends_with('\u{ad}') {
        text.truncate(text.trim_end_matches('\u{ad}').trim_end().len());
        text.push_str(line);
        return;
    }
    let mut end = text.chars().rev();
    let hyphenated = end.next() == Some('-') && end.next().is_some_and(char::is_alphabetic);
    if hyphenated {
        if starts_lowercase(line) {
            text.pop();
        }
    } else {
        text.push(' ');
    }
    text.push_str(line);
}

fn starts_lowercase(text: &str) -> bool {
    text.chars().next().is_some_and(char::is_lowercase)
}

/// Joins a page's last paragraph to the next page's first when it doesn't
/// end a sentence and the next one starts lowercase, or when it ends with a
/// soft hyphen, which always breaks a word. The joined paragraph
/// stays on the page where it starts, so a page it takes all of is left
/// empty, and the paragraph can carry on onto the page after.
fn join_across_pages(pages: &mut [Vec<String>]) {
    // The page holding the paragraph the next page might continue.
    let mut open = 0;
    for i in 1..pages.len() {
        let (before, after) = pages.split_at_mut(i);
        let mut joined = false;
        if let (Some(last), Some(next)) = (before[open].last_mut(), after[0].first()) {
            let ends_sentence = last.chars().last().is_some_and(|c| ".?!:\"”’)".contains(c));
            if (!ends_sentence && starts_lowercase(next)) || last.ends_with('\u{ad}') {
                let next = after[0].remove(0);
                join_line(last, &next);
                joined = true;
            }
        }
        if !(joined && after[0].is_empty()) {
            open = i;
        }
    }
}

/// The outline's entries as (level, title, page), or none if the PDF has
/// no outline or it can't be read.
fn outline_entries(doc: &Document) -> Vec<(usize, String, usize)> {
    let toc = catch_unwind(AssertUnwindSafe(|| doc.get_toc()));
    match toc {
        Ok(Ok(toc)) => toc
            .toc
            .into_iter()
            .map(|entry| (entry.level, entry.title, entry.page))
            .collect(),
        _ => Vec::new(),
    }
}

/// A chapter's title and its first and last page, counting from 1.
type Span = (String, usize, usize);

/// Chapters from the outline's shallowest level: each runs from its entry's
/// page to the page before the next entry's. When entries share a page,
/// the last one keeps it, as there's no text between them. Pages before
/// the first entry are "Front matter". Empty if there are no usable
/// entries.
fn outline_spans(entries: Vec<(usize, String, usize)>, page_count: usize) -> Vec<Span> {
    let entries: Vec<_> = entries
        .into_iter()
        .filter(|(_, _, page)| (1..=page_count).contains(page))
        .collect();
    let Some(top) = entries.iter().map(|(level, _, _)| *level).min() else {
        return Vec::new();
    };
    let mut starts: Vec<(usize, String)> = entries
        .into_iter()
        .filter(|(level, _, _)| *level == top)
        .map(|(_, title, page)| (page, normalize_whitespace(&title)))
        .collect();
    // Stable, so entries on one page keep their outline order.
    starts.sort_by_key(|(page, _)| *page);
    let mut kept: Vec<(usize, String)> = Vec::new();
    for start in starts {
        if kept.last().is_some_and(|(page, _)| *page == start.0) {
            kept.pop();
        }
        kept.push(start);
    }

    let mut spans = Vec::new();
    if kept[0].0 > 1 {
        spans.push((FRONT_MATTER.to_string(), 1, kept[0].0 - 1));
    }
    for (i, (first, title)) in kept.iter().enumerate() {
        let last = kept.get(i + 1).map_or(page_count, |(next, _)| next - 1);
        let title = if title.is_empty() {
            pages_title(*first, last)
        } else {
            title.clone()
        };
        spans.push((title, *first, last));
    }
    spans
}

/// Chapters of `PAGES_PER_CHAPTER` pages, for a PDF without an outline.
fn page_block_spans(page_count: usize) -> Vec<Span> {
    (1..=page_count)
        .step_by(PAGES_PER_CHAPTER)
        .map(|first| {
            let last = (first + PAGES_PER_CHAPTER - 1).min(page_count);
            (pages_title(first, last), first, last)
        })
        .collect()
}

fn pages_title(first: usize, last: usize) -> String {
    format!("Pages {first}–{last}")
}

/// The chapters' paragraphs from each span's pages, skipping chapters with
/// none.
fn build_chapters(pages: &[Vec<String>], spans: &[Span]) -> Vec<ParsedChapter> {
    spans
        .iter()
        .filter_map(|(title, first, last)| {
            let paragraphs: Vec<String> =
                pages[first - 1..*last].iter().flatten().cloned().collect();
            if paragraphs.is_empty() {
                return None;
            }
            Some(ParsedChapter {
                file_name: format!("pages {first}-{last}"),
                title: title.clone(),
                paragraphs: with_offsets(paragraphs),
            })
        })
        .collect()
}

/// Each paragraph with its char offsets in the chapter's text, joined with
/// "\n\n" as `parse_epub` does.
fn with_offsets(paragraphs: Vec<String>) -> Vec<(usize, usize, String)> {
    let mut cursor = 0;
    paragraphs
        .into_iter()
        .map(|text| {
            let start = cursor;
            let end = start + text.chars().count();
            cursor = end + 2;
            (start, end, text)
        })
        .collect()
}

/// The first usable title from: the document info, XMP metadata, the
/// title page's largest text, the most frequent running header, and the
/// file name.
fn book_title(
    doc: &Document,
    pages: &[String],
    header_counts: &HashMap<String, usize>,
    chapter_titles: &[&str],
    file_stem: &str,
) -> String {
    let sources: [&dyn Fn() -> Option<String>; 4] = [
        &|| info_string(doc, b"Title"),
        &|| xmp_field(&xmp(doc)?, "dc:title"),
        &|| title_page_text(doc, pages),
        &|| header_title(header_counts, pages.len(), chapter_titles),
    ];
    sources
        .iter()
        .filter_map(|source| source())
        .map(|title| normalize_whitespace(&title))
        .find(|title| !is_junk_title(title, file_stem))
        .unwrap_or_else(|| tidy_file_stem(file_stem))
}

/// The document info's author, else XMP's first creator.
fn book_author(doc: &Document) -> Option<String> {
    [
        info_string(doc, b"Author"),
        xmp(doc).and_then(|xml| xmp_field(&xml, "dc:creator")),
    ]
    .into_iter()
    .flatten()
    .map(|author| normalize_whitespace(&author))
    .find(|author| !is_junk_text(author))
}

/// A text string from the trailer's `/Info` dictionary.
fn info_string(doc: &Document, key: &[u8]) -> Option<String> {
    let (_, info) = doc.dereference(doc.trailer.get(b"Info").ok()?).ok()?;
    let (_, value) = doc.dereference(info.as_dict().ok()?.get(key).ok()?).ok()?;
    pdf_extract::decode_text_string(value).ok()
}

/// The catalog's XMP metadata stream, as text.
fn xmp(doc: &Document) -> Option<String> {
    let metadata = doc.catalog().ok()?.get(b"Metadata").ok()?;
    let (_, metadata) = doc.dereference(metadata).ok()?;
    let Object::Stream(stream) = metadata else {
        return None;
    };
    let bytes = stream
        .decompressed_content()
        .unwrap_or_else(|_| stream.content.clone());
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The first `rdf:li` under the XMP element `field` (`dc:title`,
/// `dc:creator`), or none if it's missing or the XML is unreadable.
fn xmp_field(xml: &str, field: &str) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    let mut in_field = false;
    let mut text: Option<String> = None;
    loop {
        match reader.read_event().ok()? {
            Event::Start(e) if e.name().as_ref() == field => in_field = true,
            Event::End(e) if e.name().as_ref() == field => in_field = false,
            Event::Start(e) if in_field && e.name().as_ref() == "rdf:li" => {
                text = Some(String::new());
            }
            Event::End(e) if e.name().as_ref() == "rdf:li" && text.is_some() => return text,
            Event::Text(e) => {
                if let Some(text) = &mut text {
                    text.push_str(&e.into_inner());
                }
            }
            Event::GeneralRef(e) => {
                if let Some(text) = &mut text {
                    text.push_str(&resolve_ref(&e));
                }
            }
            Event::Eof => return None,
            _ => {}
        }
    }
}

/// Records each character drawn on a page with its size on the page.
#[derive(Default)]
struct SizedChars(Vec<(f64, char)>);

impl OutputDev for SizedChars {
    fn begin_page(
        &mut self,
        _page_num: u32,
        _media_box: &MediaBox,
        _art_box: Option<(f64, f64, f64, f64)>,
    ) -> Result<(), OutputError> {
        Ok(())
    }

    fn end_page(&mut self) -> Result<(), OutputError> {
        Ok(())
    }

    fn output_character(
        &mut self,
        trm: &Transform,
        _width: f64,
        _spacing: f64,
        font_size: f64,
        char: &str,
    ) -> Result<(), OutputError> {
        // The font size scaled by the text matrix, as pdf-extract's
        // `HTMLOutput` works it out.
        let x = font_size * (trm.m11 + trm.m21);
        let y = font_size * (trm.m12 + trm.m22);
        let size = (x * y).abs().sqrt();
        self.0.extend(char.chars().map(|c| (size, c)));
        Ok(())
    }

    fn begin_word(&mut self) -> Result<(), OutputError> {
        Ok(())
    }

    fn end_word(&mut self) -> Result<(), OutputError> {
        Ok(())
    }

    fn end_line(&mut self) -> Result<(), OutputError> {
        Ok(())
    }
}

/// The largest text on the first `TITLE_PAGES` pages, if it's well above
/// the body size, spelled as in the page's extracted text.
fn title_page_text(doc: &Document, pages: &[String]) -> Option<String> {
    let sized: Vec<Vec<(f64, char)>> = (1..=TITLE_PAGES.min(pages.len() as u32))
        .map(|page_num| {
            let mut chars = SizedChars::default();
            // A page that fails or panics here was read fine as text, so
            // it just has no candidate.
            match guarded(|| output_doc_page(doc, &mut chars, page_num)) {
                Ok(()) => chars.0,
                Err(_) => Vec::new(),
            }
        })
        .collect();
    let (page, run) = title_run(&sized)?;
    match_in_page(&run, &pages[page])
}

/// The page index and text of the title run: of the runs of same-size
/// characters with 3–200 characters and a letter, the largest, the
/// earliest on a tie, if it's at least `TITLE_SCALE` times the size
/// covering the most characters. Runs carry on across lines, so a title
/// set on two lines is one run.
fn title_run(pages: &[Vec<(f64, char)>]) -> Option<(usize, String)> {
    let mut by_size: HashMap<i64, usize> = HashMap::new();
    for &(size, c) in pages.iter().flatten() {
        if !c.is_whitespace() {
            *by_size.entry((size * 2.0).round() as i64).or_default() += 1;
        }
    }
    let body = by_size
        .iter()
        .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
        .map(|(&size, _)| size as f64 / 2.0)?;

    let mut best: Option<(f64, usize, String)> = None;
    for (page, chars) in pages.iter().enumerate() {
        for (size, text) in size_runs(chars) {
            let letters = text.chars().filter(|c| !c.is_whitespace()).count();
            let usable = (3..=200).contains(&letters) && text.chars().any(char::is_alphabetic);
            if usable
                && best
                    .as_ref()
                    .is_none_or(|(best_size, _, _)| size > *best_size)
            {
                best = Some((size, page, text));
            }
        }
    }
    let (size, page, text) = best?;
    (size >= TITLE_SCALE * body).then_some((page, text))
}

/// Splits a page's characters into runs whose neighbours are within 0.5pt
/// of each other's size, each with its first character's size.
fn size_runs(chars: &[(f64, char)]) -> Vec<(f64, String)> {
    let mut runs: Vec<(f64, String)> = Vec::new();
    let mut prev: Option<f64> = None;
    for &(size, c) in chars {
        match runs.last_mut() {
            Some((_, text)) if prev.is_some_and(|p| (size - p).abs() <= 0.5) => text.push(c),
            _ => runs.push((size, c.to_string())),
        }
        prev = Some(size);
    }
    runs
}

/// Finds `run`'s non-whitespace characters in `page` ignoring whitespace,
/// and returns that span of `page` with its own spacing. pdf-extract's
/// per-character callback spaces text unreliably ("Buddhi s t L i f e"),
/// while its page text is spaced right.
fn match_in_page(run: &str, page: &str) -> Option<String> {
    let needle: Vec<char> = run.chars().filter(|c| !c.is_whitespace()).collect();
    let hay: Vec<(usize, char)> = page
        .char_indices()
        .filter(|(_, c)| !c.is_whitespace())
        .collect();
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    let at = hay
        .windows(needle.len())
        .position(|w| w.iter().map(|(_, c)| *c).eq(needle.iter().copied()))?;
    let (start, _) = hay[at];
    let (last, c) = hay[at + needle.len() - 1];
    Some(normalize_whitespace(&page[start..last + c.len_utf8()]))
}

/// The most frequent running header's key, if it heads at least a quarter
/// of the pages and `MIN_REPEATS` of them, skipping chapter titles since
/// books often head odd pages with the chapter.
fn header_title(
    counts: &HashMap<String, usize>,
    page_count: usize,
    chapter_titles: &[&str],
) -> Option<String> {
    counts
        .iter()
        .filter(|&(key, &n)| {
            n >= MIN_REPEATS
                && n * 4 >= page_count
                && !chapter_titles.iter().any(|t| t.eq_ignore_ascii_case(key))
        })
        .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
        .map(|(key, _)| key.clone())
}

/// A title that says nothing about the book: see `is_junk_text`, or the
/// file name again, so the later sources get a chance.
fn is_junk_title(title: &str, file_stem: &str) -> bool {
    is_junk_text(title) || title.eq_ignore_ascii_case(file_stem)
}

/// Text that metadata tools leave in place of a real title or author: no
/// letters, "Untitled", "Slide 3", "Microsoft Word - draft.docx", or a
/// file name.
fn is_junk_text(text: &str) -> bool {
    const PREFIXES: [&str; 3] = [
        "microsoft word - ",
        "microsoft powerpoint - ",
        "microsoft excel - ",
    ];
    const EXTENSIONS: [&str; 10] = [
        ".doc", ".docx", ".odt", ".rtf", ".txt", ".pdf", ".indd", ".qxd", ".tex", ".dvi",
    ];
    let lower = text.to_lowercase();
    let is_slide = lower
        .strip_prefix("slide ")
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    !text.chars().any(char::is_alphabetic)
        || lower == "untitled"
        || lower == "untitled document"
        || is_slide
        || PREFIXES.iter().any(|p| lower.starts_with(p))
        || EXTENSIONS.iter().any(|e| lower.ends_with(e))
}

/// A file name made readable: `_` and `-` become spaces, and a space goes
/// between a lowercase letter and a following uppercase one.
fn tidy_file_stem(stem: &str) -> String {
    let mut out = String::new();
    let mut prev: Option<char> = None;
    for c in stem.chars() {
        let c = if c == '_' || c == '-' { ' ' } else { c };
        if c.is_uppercase() && prev.is_some_and(char::is_lowercase) {
            out.push(' ');
        }
        out.push(c);
        prev = Some(c);
    }
    normalize_whitespace(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<String> {
        text.lines().map(str::to_string).collect()
    }

    fn texts(page: &[String]) -> Vec<&str> {
        page.iter()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect()
    }

    #[test]
    fn strips_headers_repeated_on_three_pages() {
        let mut pages = vec![
            lines("Running Head   1\nbody one\nviii"),
            lines("2   Running Head\nbody two\nix"),
            lines("Running Head   iii\nbody three\n10"),
            lines("Twice Only\nbody four"),
            lines("Twice Only\nbody five"),
        ];
        let firsts = strip_running_lines(&mut pages);
        assert_eq!(texts(&pages[0]), ["body one"]);
        assert_eq!(texts(&pages[1]), ["body two"]);
        assert_eq!(texts(&pages[2]), ["body three"]);
        assert_eq!(texts(&pages[3]), ["Twice Only", "body four"]);
        assert_eq!(firsts["Running Head"], 3);
        assert_eq!(firsts["Twice Only"], 2);
    }

    #[test]
    fn page_numbers_are_arabic_or_small_roman() {
        for word in ["7", "2024", "iv", "XIV", "cxcix"] {
            assert!(is_page_number(word), "{word}");
        }
        for word in ["mix", "mid", "iiii", "Iv", "vv", "ivi", "12345", "civil"] {
            assert!(!is_page_number(word), "{word}");
        }
    }

    #[test]
    fn joins_lines_and_hyphenated_words() {
        let paragraphs = page_paragraphs(&lines(
            "The gift of gen-\nerosity comes  first.\n\nLicensed CC Attribution-\nNonCommercial.\n\nStruggle Toward Re\u{ad}\nbirth, pub\u{ad}\n\nlished it \u{ad}\nself.\n",
        ));
        assert_eq!(
            paragraphs,
            [
                "The gift of generosity comes first.",
                "Licensed CC Attribution-NonCommercial.",
                "Struggle Toward Rebirth, published itself."
            ]
        );
    }

    #[test]
    fn joins_a_paragraph_running_onto_the_next_page() {
        let mut pages = vec![
            vec!["He came from".to_string()],
            vec!["sandalwood country.".to_string(), "Next.".to_string()],
            vec!["He was an ascetic.".to_string()],
            vec!["Here, he stayed. Mon\u{ad}".to_string()],
            vec!["Key.".to_string()],
            vec!["It ran on over".to_string()],
            vec!["this whole page, and".to_string()],
            vec!["onto the next.".to_string()],
            vec!["It stopped at".to_string()],
            vec![],
            vec!["a blank page.".to_string()],
        ];
        join_across_pages(&mut pages);
        assert_eq!(pages[0], ["He came from sandalwood country."]);
        assert_eq!(pages[1], ["Next."]);
        assert_eq!(pages[2], ["He was an ascetic."]);
        assert_eq!(pages[3], ["Here, he stayed. MonKey."]);
        assert_eq!(
            pages[5],
            ["It ran on over this whole page, and onto the next."]
        );
        assert!(pages[6].is_empty() && pages[7].is_empty());
        assert_eq!(pages[8], ["It stopped at"]);
        assert_eq!(pages[10], ["a blank page."]);
    }

    fn entry(title: &str, page: usize) -> (usize, String, usize) {
        (1, title.to_string(), page)
    }

    #[test]
    fn outline_entries_on_one_page_keep_the_last() {
        let spans = outline_spans(vec![entry("A", 1), entry("B", 1), entry("C", 3)], 4);
        assert_eq!(spans, [("B".to_string(), 1, 2), ("C".to_string(), 3, 4)]);
    }

    #[test]
    fn pages_before_the_outline_are_front_matter() {
        let spans = outline_spans(vec![entry("Intro", 3), (2, "Sub".into(), 4)], 4);
        assert_eq!(
            spans,
            [
                (FRONT_MATTER.to_string(), 1, 2),
                ("Intro".to_string(), 3, 4)
            ]
        );
        assert!(outline_spans(vec![entry("Gone", 9)], 4).is_empty());
    }

    #[test]
    fn no_outline_gives_twenty_page_blocks() {
        let titles: Vec<String> = page_block_spans(45).into_iter().map(|s| s.0).collect();
        assert_eq!(titles, ["Pages 1–20", "Pages 21–40", "Pages 41–45"]);
    }

    #[test]
    fn offsets_leave_a_two_character_gap() {
        let offsets = with_offsets(vec!["ab".to_string(), "cdé".to_string()]);
        let spans: Vec<(usize, usize)> = offsets.iter().map(|(s, e, _)| (*s, *e)).collect();
        assert_eq!(spans, [(0, 2), (4, 7)]);
    }

    #[test]
    fn junk_titles_are_rejected() {
        for title in [
            "Microsoft Word - draft3.docx",
            "untitled",
            "Slide 1",
            "report.pdf",
            "1234",
            "my_book",
        ] {
            assert!(is_junk_title(title, "my_book"), "{title}");
        }
        // A real "1984" is rejected too, but then gets its title from
        // the file name, which isn't checked.
        for title in ["Buddhist Life/Buddhist Path", "Nineteen Eighty-Four"] {
            assert!(!is_junk_title(title, "my_book"), "{title}");
        }
    }

    #[test]
    fn file_stems_are_tidied() {
        assert_eq!(
            tidy_file_stem("BuddhistLifeBuddhistPath"),
            "Buddhist Life Buddhist Path"
        );
        assert_eq!(tidy_file_stem("the_heart-sutra"), "the heart sutra");
        assert_eq!(
            tidy_file_stem("understandingourmind"),
            "understandingourmind"
        );
    }

    #[test]
    fn title_run_is_found_in_the_page_text() {
        let page = "Buddhist Life/Buddhist Path\n\nthe foundations of practice";
        assert_eq!(
            match_in_page("Buddhi s t L i f e / Buddhi s t P a t h", page).as_deref(),
            Some("Buddhist Life/Buddhist Path")
        );
        assert_eq!(match_in_page("Something Else", page), None);
    }

    fn sized(size: f64, text: &str) -> Vec<(f64, char)> {
        text.chars().map(|c| (size, c)).collect()
    }

    #[test]
    fn title_run_is_the_largest_text_well_above_the_body() {
        let mut page = sized(24.0, "Inter");
        page.extend(sized(24.2, "view\nCommercial"));
        page.extend(sized(10.0, "body text that is long enough to be the body"));
        page.extend(sized(30.0, "I"));
        assert_eq!(
            title_run(&[page]),
            Some((0, "Interview\nCommercial".to_string()))
        );
        let flat = sized(10.0, "body text ");
        let mut page = flat.repeat(5);
        page.extend(sized(13.0, "Not big enough"));
        assert_eq!(title_run(&[page]), None);
    }

    #[test]
    fn header_title_needs_a_quarter_of_the_pages() {
        let counts: HashMap<String, usize> = [
            ("Book Title".to_string(), 4),
            ("Chapter One".to_string(), 5),
            ("Rare".to_string(), 2),
        ]
        .into();
        assert_eq!(
            header_title(&counts, 10, &["chapter one"]).as_deref(),
            Some("Book Title")
        );
        assert_eq!(header_title(&counts, 20, &["chapter one"]), None);
        let rare: HashMap<String, usize> = [("Rare".to_string(), 2)].into();
        assert_eq!(header_title(&rare, 4, &[]), None);
    }

    #[test]
    fn xmp_fields_read_the_first_list_item() {
        let xml = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF>
            <rdf:Description><dc:title><rdf:Alt>
              <rdf:li xml:lang="x-default">Fish &amp; Chips</rdf:li>
              <rdf:li xml:lang="fr">Poisson</rdf:li>
            </rdf:Alt></dc:title>
            <dc:creator><rdf:Seq><rdf:li>Ann Author</rdf:li></rdf:Seq></dc:creator>
            </rdf:Description></rdf:RDF></x:xmpmeta>"#;
        assert_eq!(xmp_field(xml, "dc:title").as_deref(), Some("Fish & Chips"));
        assert_eq!(xmp_field(xml, "dc:creator").as_deref(), Some("Ann Author"));
        assert_eq!(xmp_field(xml, "dc:subject"), None);
        assert_eq!(xmp_field("<a><dc:title><rdf:li>x</b>", "dc:title"), None);
    }

    const FIXTURES: &str = "tests/fixtures/pdf";

    fn fixture(name: &str) -> String {
        format!("{FIXTURES}/{name}")
    }

    fn all_paragraphs(book: &ParsedBook) -> Vec<&str> {
        book.chapters
            .iter()
            .flat_map(|c| c.paragraphs.iter().map(|(_, _, t)| t.as_str()))
            .collect()
    }

    #[test]
    fn parses_the_test_pdf() {
        let book = parse_pdf(&fixture("test.pdf")).unwrap();
        assert_eq!(book.title.as_deref(), Some("A Test Book"));
        assert_eq!(book.format, "pdf");
        let titles: Vec<&str> = book.chapters.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, [FRONT_MATTER, "Introduction", "Methods"]);

        let paragraphs = all_paragraphs(&book);
        assert!(
            paragraphs.iter().all(|p| !p.contains("Running Head")),
            "{paragraphs:#?}"
        );
        assert!(paragraphs.iter().any(|p| p.contains("colour gradient of")));
        assert!(paragraphs.iter().any(|p| p.contains("saṃsāra")));
        assert!(
            paragraphs
                .iter()
                .any(|p| p.contains("run down in crooked lines towards the river")),
            "{paragraphs:#?}"
        );
    }

    #[test]
    fn without_an_outline_chapters_are_page_blocks() {
        let book = parse_pdf(&fixture("no-outline.pdf")).unwrap();
        assert_eq!(book.title.as_deref(), Some("Metadata Title"));
        let titles: Vec<&str> = book.chapters.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, ["Pages 1–4"]);
    }

    #[test]
    fn opens_a_pdf_with_only_an_owner_password() {
        let book = parse_pdf(&fixture("owner-password.pdf")).unwrap();
        assert!(all_paragraphs(&book).iter().any(|p| p.contains("saṃsāra")));
    }

    #[test]
    fn refuses_a_pdf_that_needs_a_password() {
        let err = parse_pdf(&fixture("password.pdf"))
            .err()
            .expect("expected an error")
            .to_string();
        assert!(err.contains("password-protected"), "{err}");
    }

    #[test]
    fn refuses_a_scanned_pdf() {
        let err = parse_pdf(&fixture("scanned.pdf"))
            .err()
            .expect("expected an error")
            .to_string();
        assert!(err.contains("has no text layer"), "{err}");
    }

    #[test]
    fn a_pdf_extract_panic_is_an_error() {
        let err = parse_pdf(&fixture("panics.pdf"))
            .err()
            .expect("expected an error")
            .to_string();
        assert!(err.contains("couldn't read the text"), "{err}");
        assert!(err.contains("unexpected encoding"), "{err}");
    }

    #[test]
    fn refuses_a_file_that_isnt_a_pdf() {
        let path = std::env::temp_dir().join(format!("pitaka-junk-{}.pdf", std::process::id()));
        let junk: Vec<u8> = (0..4096u32)
            .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
            .collect();
        std::fs::write(&path, junk).unwrap();
        let result = parse_pdf(path.to_str().unwrap());
        std::fs::remove_file(&path).unwrap();
        let err = result
            .err()
            .expect("random bytes shouldn't parse")
            .to_string();
        assert!(err.contains("couldn't read"), "{err}");
    }
}
