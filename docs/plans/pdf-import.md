# Import PDFs

## Context
Pitaka only imports EPUBs, but much of a research library comes as PDFs: dharma books published as free PDFs, papers, and books exported from Word or LibreOffice. Most of these have a text layer, so their text can be read directly with no OCR. This plan adds import of text-layer PDFs. After that, search (stemmed, exact and semantic), the reader, bookmarks, highlights and notes all work on them unchanged, because the reader shows the stored `content_blocks` text rather than the original file.

Out of scope:
- **OCR.** A scanned or image-only PDF is refused with a clear message instead of being imported as an empty book. OCR stays the roadmap item "OCR support, so scanned or image-only books can be searched".
- **Page numbers.** Showing "p. 143" in results and the reader needs a `content_blocks.page` column and changes across search hits, the reader and the fixtures. It's a separate feature, added to the roadmap.
- **Editing a book's title or author.** No title rule is right for every PDF, and EPUBs with bad OPF metadata have the same problem. An "Edit title/author" action is a separate roadmap item, added to README with this plan.
- **Layout recovery** beyond what's described in section 2: multiple columns, tables, footnotes kept apart from the body text, and superscript note markers ("say.1").

Alternatives ruled out:
- **`pdfium-render`.** It extracts hard layouts better, but needs a PDFium shared library bundled for each platform in `release.yml`.
- **MuPDF bindings.** Its AGPL licence conflicts with Pitaka's MIT/Apache licence.
- **Shelling out to poppler's `pdftotext`.** It isn't installed on Windows or macOS by default.

## What was checked
All checks used a scratch crate (not in the repo) running `pdf-extract` 0.12.1 against `~/Downloads/BuddhistLifeBuddhistPath.pdf`. This is a 242-page LibreOffice export with Pali diacritics, an 88-entry outline, and no Title/Author metadata.
- **Speed.** `pdf_extract::extract_text_from_mem_by_pages` returned 242 pages in 0.57s (release build).
- **Diacritics.** ā, ṅ, ṭ, ñ, ṇ, ṁ, ṃ and ī come through, as they do in poppler's output.
- **Garbling.** Compared word by word with `pdftotext` (86,916 vs 87,276 words), 459 tokens differ. Nearly all are line-end hyphenation ("gen-" / "erosity"), which poppler joins and pdf-extract keeps. Section 2 handles that. One line is garbled: text drawn twice gives "◖illnessillness◗◗ and and".
- **Paragraphs.** pdf-extract puts a blank line between paragraphs (vertical gaps). After pages 1–16, splitting on blank lines gives 1,766 paragraphs. 144 of them start lowercase, mostly paragraphs continuing from the previous page; the page-join rule in section 2 handles those. A block quote followed by body text with no vertical gap stays as one paragraph.
- **Running headers.** Each page starts with a running header plus page number ("6   Buddhist Life/Buddhist Path", "1. Buddha   5"). The header rule in section 2 drops 230 of the 242 page tops. It keeps "Contents", "PART ONE: BUDDHIST LIFE" and "References", which repeat on fewer than three pages.
- **Title page.** A prototype `OutputDev` over pages 1 to 5 found the largest text: "Buddhist Life/Buddhist Path" at 24pt on page 3 (then the subtitle at 18pt, "Contents" at 16pt and the author at 14pt, against 10pt headers). On two one-page worksheets in `~/Documents/Jobs` it gave "Employer Research Worksheet" (26pt vs 12pt body) and "Interview" + "Commercial" (two 21pt runs, hence joining runs across lines). The callback's text comes out mis-spaced, hence the match against the extracted page text. The book's most frequent running header is "Buddhist Life/Buddhist Path" (121 of 242 page tops). `pdfinfo` reports no `/Info` title and no XMP stream for it, so the book needs a fallback beyond metadata.
- **Outline.** `lopdf::Document::get_toc` reads the outline: level 1 holds "Contents" (p5), "Preface" (p9), "PART ONE…" (p17), "1. Buddha" (p19) and so on, and level 2 holds sections like "1.1. The noble search". `pdf_extract` re-exports `lopdf::*` (0.42), so reading the outline adds no second crate.
- **No outline.** `get_toc` returns `Err(DictKey("Outlines"))` for a PDF without one.
- **Scans.** An image-only PDF made with `soffice --convert-to pdf scan.png` extracts 0 characters.
- **Fixtures.** A flat ODT with two `text:outline-level="1"` headings converted by `soffice --headless --convert-to pdf` gives a 2-page PDF with a 2-entry outline. That's how the test fixtures are made (section 6).
- **Panics.** `pdf-extract` has `panic!` calls on fonts it doesn't understand (e.g. "unexpected encoding"). The workspace `[profile.release]` sets `panic = "abort"`, so today such a PDF would kill the app.

## 1. Dependencies and panics: `ebook_research_core/Cargo.toml`, `Cargo.toml`
- Add `pdf-extract = "0.12"` to `ebook_research_core`. It's MIT-licensed, and its `lopdf` re-export is what reads the outline and metadata.
- Remove `panic = "abort"` from `[profile.release]` in the root `Cargo.toml`, with a comment saying the PDF importer relies on `catch_unwind` (section 2), so a malformed PDF becomes an import error instead of a crash. This costs some binary size, to be measured with `npm run tauri build` and noted in the commit message.

## 2. Core parser: new `ebook_research_core/src/pdf.rs`
- `pub fn parse_pdf(path: &str) -> Result<ParsedBook>`, declared as `pub mod pdf;` in `lib.rs`. It produces the same `ParsedBook`/`ParsedChapter` as `parse_epub`, so `load_book` and everything downstream is shared.
- **Load.** Read the bytes and `Document::load_mem` them.
  - If `doc.is_encrypted()` and `doc.decrypt("")` fails, bail with `"{path} is password-protected"`. PDFs with only an owner password open with the empty user password. Whether lopdf 0.42 already decrypts on load gets checked with a fixture made using `qpdf --encrypt` (or `soffice`'s export password) during implementation.
- **Extract.** Call `pdf_extract::extract_text_from_mem_by_pages(&bytes)` inside `std::panic::catch_unwind`.
  - An `Err` or a panic bails with `"couldn't read the text in {path}: {reason}"`. For a panic, the reason is the payload's `&str`/`String`, else "the PDF uses a feature Pitaka can't read".
- **Scan check.** If the non-whitespace character count is under `MIN_CHARS_PER_PAGE` (50) × the page count, bail with `"{path} has no text layer (it's probably scanned), and Pitaka can't search scanned PDFs yet"`.
  - The book above averages ~2,200 characters per page and a scan has 0, so 50 leaves room for a scan carrying stamped page numbers or a short text cover.
- **`fn strip_running_lines(pages: &mut [Vec<String>])`** removes headers and footers. It works on each page's lines with blank lines kept.
  - For each page's first and last non-blank line, make a key: trim it, strip a leading or trailing arabic or roman page number, and collapse whitespace.
  - Count the keys separately for first and last positions. A line whose key appears at that position on 3 or more pages is dropped.
  - A line that is only a page number is dropped wherever it is first or last.
- **`fn page_paragraphs(lines: &[String]) -> Vec<String>`** splits a page into paragraphs on blank lines.
  - Lines are joined with a space, except a line ending in a letter then `-` followed by a line starting with a lowercase letter: those are joined with the hyphen removed. "gen-" + "erosity" gives "generosity", and "Attribution-" + "NonCommercial" keeps its hyphen.
  - Whitespace is collapsed with the same rule as `epub::normalize_whitespace`, made `pub(crate)`.
- **Joining across pages.** When a page's last paragraph doesn't end in `.` `?` `!` `:` `"` `”` `’` or `)` and the next page's first paragraph starts lowercase, the two are joined with a space. The result belongs to the page where it starts.
- **Chapters from the outline.** Take `get_toc()` entries at the shallowest level present, drop those whose page is outside the document, and sort by page.
  - Each chapter holds the paragraphs from its page up to the next entry's page.
  - If several entries start on the same page, the last one keeps the page and the others are dropped, as there's no text between them.
  - Paragraphs before the first entry form a chapter titled "Front matter".
  - Chapters are cut at page boundaries, so a chapter starting mid-page also takes the end of the previous chapter (a new limitation, section 7).
- **Chapters without an outline** (`get_toc` errors or yields nothing): fixed blocks of `PAGES_PER_CHAPTER` (20) pages, titled "Pages 1–20", "Pages 21–40" and so on, with the last ending at the page count.
- **Empty chapters are skipped**, as `parse_epub` skips files with no blocks.
- `ParsedChapter.file_name` is set to `"pages {first}-{last}"`. It's only used inside the parser.
- **Offsets.** `char_start`/`char_end` count `chars()` with a 2-character gap between paragraphs, matching `parse_epub`'s `"\n\n"` joiner.
- **Title.** `fn book_title(…) -> String` tries five sources in order. Each candidate is trimmed and whitespace-collapsed, and one that `is_junk_title` rejects is skipped. The library never shows "Untitled" for a PDF.
  1. The trailer's `/Info` `Title`, decoded with `lopdf::decode_text_string`.
  2. XMP `dc:title`, from the catalog's `/Metadata` stream: the first `rdf:li` under `dc:title`, read with quick-xml (already a dependency). The stream is decompressed with lopdf's `Stream::decompressed_content`. If the stream is missing or the XML is unreadable, this source is skipped.
  3. The largest text on the title page, from `fn title_page_text(doc, pages) -> Option<String>`:
     - A small `OutputDev` (pdf-extract's per-character callback) runs over pages 1 to 5 with `output_doc_page`. It records each character's effective size, `font_size` scaled by `trm` the way pdf-extract's `HTMLOutput` does it.
     - Consecutive characters within 0.5pt of each other's size form a run, and runs keep going across line ends, so a two-line title ("Interview" / "Commercial") is one run.
     - The body size is the size covering the most characters on those pages. The candidate is the run with the largest size, the earliest one on a tie. It must be at least 1.5× the body size, and 3–200 characters with at least one letter.
     - The callback's spacing is unreliable ("Buddhi s t L i f e"), so the run is only used to find the title. Its non-whitespace characters are searched for in the page's extracted text with whitespace removed, and the matching span of that text (with its real spaces) is the title. If there's no match, there's no candidate.
  4. The most frequent running header: a first-line key from `strip_running_lines` (that function returns its key counts for this) that heads at least 25% of pages and 3 or more. A key equal to a chapter title is skipped, since books often head odd pages with the chapter.
  5. The file stem, tidied by `fn tidy_file_stem`: `_` and `-` become spaces, a space goes before an uppercase letter that follows a lowercase one, and whitespace is collapsed. "BuddhistLifeBuddhistPath" becomes "Buddhist Life Buddhist Path". This source isn't junk-checked, so it always gives a title.
- **`fn is_junk_title(title: &str, file_stem: &str) -> bool`.** True, ignoring case, for any of these:
  - text with no letter;
  - "untitled", "untitled document" or "slide N";
  - text starting "Microsoft Word - ", "Microsoft PowerPoint - " or "Microsoft Excel - ";
  - text ending in a file extension (`.doc`, `.docx`, `.odt`, `.rtf`, `.txt`, `.pdf`, `.indd`, `.qxd`, `.tex`, `.dvi`);
  - text equal to the file stem, so the later sources get a chance.
- **Author.** `/Info` `Author`, else XMP `dc:creator` (the first `rdf:li`), else none, with the same junk check minus the file-stem rule. The title page isn't used for the author: the next-largest line there is as often a subtitle or publisher.

## 3. Core import: `db/import.rs`, `epub.rs`, `db/mod.rs`, `lib.rs`, `db/test_util.rs`
- **Format field.** `ParsedBook` gains `pub format: &'static str`. `parse_epub` sets it to `"epub"` and `parse_pdf` to `"pdf"`, and `one_chapter_book` sets it to `"epub"`.
  - `load_book` binds `parsed.format` in place of the literal `'epub'`. The `books.format` column already exists (migration 001 documents `'epub' | 'pdf' | 'mobi'`), so there's no migration.
- **Dispatch.** `import_book(conn, path)`: the parameter is renamed from `epub_path` to `path`, and it now calls `fn parse_book(path: &str) -> Result<ParsedBook>`.
  - `parse_book` matches the extension ignoring case: `epub` → `parse_epub`, `pdf` → `parse_pdf`, anything else → `bail!("{path} isn't an EPUB or PDF")`.
  - The hash and duplicate checks still run before parsing, as now.
- **Folder scan.** `find_epubs` → `find_books`, and `EpubScan` → `BookScan`, renamed in `db/mod.rs`'s `pub use import::{…}` and in `lib.rs`.
  - It accepts `.epub` and `.pdf` in any case. Its doc comment and walk logic are otherwise unchanged.
- **Module doc.** `import.rs`'s module doc becomes "Importing books from EPUB and PDF files…".

## 4. Tauri command: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- `find_epubs` → `find_books(dir: String) -> Result<BookScan, String>`, with its doc comment updated to `invoke("find_books", { dir })`, and renamed in `generate_handler!`.
- `import_book` is unchanged: it already passes the path straight through.

## 5. Frontend: `src/types.ts`, `src/BooksView.tsx`, `src/HomeView.tsx`, `src/test/mockBackend.ts`
- **Types.** `types.ts`: `EpubScan` → `BookScan`, with the doc comment naming `find_books`.
- **Import button.** `BooksView.tsx`: the "Import EPUB…" button becomes "Import book…", and the picker filter becomes `[{ name: "EPUB or PDF", extensions: ["epub", "pdf"] }]`.
- **Folder import.** `importFolder` calls `invoke<BookScan>("find_books", { dir })`. The empty-scan line becomes `No EPUB or PDF files in ${dir}`, and the "EPUBs found" doc comment becomes "books found".
- **Remove dialog.** "The EPUB file won't be deleted." → "The book's file won't be deleted."
- **Empty-library copy.** `No books yet. Import an EPUB to start.` → `No books yet. Import an EPUB or PDF to start.`, and `HomeView.tsx`'s `Import your first EPUB` → `Import your first book`.
- **Mock backend.** `mockBackend.ts`: the `find_epubs` route, fixture key and the `scan` option's type are renamed to `find_books`/`BookScan`, and the picker comment names "Import book…".
  - The demo (`src/demo/installDemo.ts`) keeps refusing imports. `DEMO_IMPORT_ERROR` becomes "Importing your own books needs the desktop app…".
- No CSS changes.

## 6. Tests
- **Fixtures.** Check in `ebook_research_core/tests/fixtures/pdf/` with:
  - `test.fodt` (the source, kept so the PDFs can be rebuilt);
  - `test.pdf`, converted from `test.fodt` with no document title set: four pages; a title page with "A Test Book" in the Title style (p1); outline "Introduction" (p2) and "Methods" (p3); a running header "Running Head" with a page number on pages 2–4; a hyphenated line break "gradi-" / "ent"; a paragraph that runs from page 3 onto page 4; and "saṃsāra" in the text;
  - `no-outline.pdf`, the same text exported without bookmarks, from a copy of `test.fodt` with the document title "Metadata Title" in `office:meta`;
  - `scanned.pdf`, one image-only page from a generated PNG.

  `tests/fixtures/pdf/README.md` gives the exact `soffice` commands to rebuild them.
- **Unit tests in `pdf.rs`** (on plain strings, no PDF needed):
  - `strip_running_lines` drops a header repeated on 3 pages (with changing page numbers, arabic and roman), keeps one that appears twice, and drops bare page-number footers.
  - `page_paragraphs` joins "gen-"/"erosity" into "generosity", keeps "Attribution-"/"NonCommercial" hyphenated, and splits on blank lines.
  - The page join merges a paragraph ending "came from" with a next page starting "sandalwood…", and doesn't merge across "…ascetic." / "Here, …".
  - Outline chapters: entries on pages 1, 1, 3 for 4 pages give chapters titled by the second and third entries, covering pages 1–2 and 3–4. Entries starting on page 3 give a "Front matter" chapter for pages 1–2.
  - The no-outline fallback for 45 pages gives "Pages 1–20", "Pages 21–40", "Pages 41–45".
  - Offsets for two paragraphs "ab" and "cdé" are (0,2) and (4,7).
  - `is_junk_title` rejects "Microsoft Word - draft3.docx", "untitled", "Slide 1", "report.pdf", "1234" and the file stem itself, and accepts "Buddhist Life/Buddhist Path" and "1984".
  - `tidy_file_stem`: "BuddhistLifeBuddhistPath" gives "Buddhist Life Buddhist Path", "the_heart-sutra" gives "the heart sutra", and "understandingourmind" stays as it is.
  - Matching the title-page run: the run text "Buddhi s t L i f e / Buddhi s t P a t h" against the page text "Buddhist Life/Buddhist Path\n\nthe foundations…" gives "Buddhist Life/Buddhist Path", and a run that isn't in the page text gives `None`.
  - The header title: a key on 4 of 10 page tops wins; a key that is also a chapter title doesn't; a key on 2 pages doesn't.
- **`pdf.rs` tests against the fixtures:**
  - `parse_pdf("tests/fixtures/pdf/test.pdf")` gives the title "A Test Book" (from the title page, as the fixture has no `/Info` title), a "Front matter" chapter, then chapters `"Introduction"` and `"Methods"`.
  - No paragraph contains "Running Head".
  - Some paragraph contains "gradient" and "saṃsāra".
  - The page-3-to-4 paragraph is one paragraph.
  - `no-outline.pdf` gives the title "Metadata Title" and one chapter titled "Pages 1–4".
  - `scanned.pdf` errors with "has no text layer".
  - A file of random bytes renamed `.pdf` errors with "couldn't read" or a lopdf load error, and doesn't panic.
- **Unit test in `import.rs`:** `import_book` on a `.txt` path errors with "isn't an EPUB or PDF". `find_books_walks_subfolders` expects `[Nested/b.EPUB, a.epub, c.PDF]` after a zero-byte `tests/fixtures/epub-dir/c.PDF` is added. The other `find_epubs_*` tests are renamed `find_books_*`.
- **Integration (`tests/integration.rs`):**
  - `import_book` on `test.pdf` gives a book with `format = 'pdf'` and 2 chapters.
  - Searching "gradient" finds it in both `SearchMode`s.
  - Importing it again returns `already_imported: true`.
  - Importing `scanned.pdf` fails, and `list_books` still has one book.
- **UI fixtures.** `ui_fixtures.rs` writes the scan under `find_books`, regenerated with `UPDATE_UI_FIXTURES=1 cargo test -p ebook_research_core ui_fixtures`.
- **Frontend.** `Books.test.tsx`, `Demo.test.tsx` and `Home.test.tsx` use the new button name and copy, and `callsTo("find_books")`. One new test checks that the import picker is opened with the `["epub", "pdf"]` filter.
- **Manual.** Import `~/Downloads/BuddhistLifeBuddhistPath.pdf` in `npm run tauri dev`:
  - Its title is "Buddhist Life/Buddhist Path", from the title page.
  - It shows chapters "Front matter", "Contents", "Preface", "PART ONE: BUDDHIST LIFE", "1. Buddha" and so on.
  - Searching `saṅgha` and `generosity` finds it.
  - A release build (`npm run tauri build`) importing a broken PDF shows an import error rather than closing.

## 7. README
- **Intro and "How it's built".** Say EPUB and PDF where they say EPUB.
- **"What's actually verified"**: a new `ebook_research_core/src/pdf.rs` entry covering:
  - what's extracted and how headers, hyphens, page joins and chapters are handled;
  - the checks above against *Buddhist Life/Buddhist Path*;
  - which tests cover it;
  - whether it was clicked through in the Tauri window.

  Update the `find_epubs` sentence to `find_books`.
- **Known limitations**, new 9:
  - PDFs are read as plain text: scanned PDFs are refused, and there are no page numbers.
  - Chapters come from the outline's top level at page granularity, so a chapter that starts mid-page also holds the previous chapter's last lines. Without an outline, chapters are 20-page blocks.
  - Footnotes, note markers and running headers that repeat on fewer than three pages stay in the text.
  - Multi-column layouts may interleave.
  - A block quote with no gap before the next paragraph is joined to it.
  - A real hyphen at a line end followed by a lowercase word is removed.
  - Text a PDF draws twice comes out doubled.
  - A PDF without a usable `/Info` or XMP title gets its title from the largest text on pages 1–5, its most frequent running header, or its filename. A decorative cover word or a series name can win.
- **Roadmap.**
  - Done: "Import text-layer PDFs, with chapters from the outline".
  - New open item: "PDF page numbers in search results and the reader".
  - The OCR item is unchanged.
