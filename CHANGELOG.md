# Changelog

Notable changes to Pitaka, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Each version
is a GitHub release with installers for Linux and Windows.

## [Unreleased]

## [0.3.0] - 2026-10-04

### Added

- Installers for Windows (`-setup.exe` and `.msi`) and Linux
  (`.AppImage`, `.deb` and `.rpm`) on each GitHub release, with chapter
  search by meaning built in. The Windows installers aren't code-signed
  yet, so SmartScreen warns before running them.
- Highlight and write notes while reading: select text in a paragraph
  to highlight it in one of four colours, and add a note to a highlight
  or a whole paragraph. Notes open in the margin beside the text. The
  Bookmarks screen becomes "Bookmarks & notes" and lists each book's
  highlights and notes in reading order.
- Import a whole folder: "Import folder…" on the Books screen imports
  every EPUB under it, Calibre's `Author/Title/` layout included, with
  progress, a Stop button and a summary of what was imported, skipped
  or failed.
- Windows support: Pitaka builds and runs on Windows, and CI checks it
  there.

### Changed

- The app is named "Pitaka" (capitalised) in its window title, the
  Start Menu and the installed apps list. The library stays where it
  was.
- Chapter search loads its embedding model at a pinned version, so a
  change to the published model can't silently mix with chunks indexed
  by the old one.

### Fixed

- Malformed XHTML no longer loses the rest of a chapter: broken markup
  is skipped and parsing carries on after it. Text using HTML entities
  such as `&nbsp;` or `&mdash;`, or a bare `&` ("Faith & Reason"), is
  kept instead of dropped, and a bare `&` in a book's title no longer
  fails the import. Books already in the library need re-importing to
  pick this up.

## [0.2.0] - 2026-09-24

### Added

- Find chapters by meaning, in a build with `--features semantic`:
  Search gains a Passages / Chapters switch, and a chapter result opens
  the reader at the paragraph that matched. A small embedding model
  runs locally, downloaded once on first use. Books are indexed in the
  background when imported, with progress on the Books screen; books
  already in the library need re-importing to be included.

### Changed

- A chapter with no `<h1>`/`<h2>` takes its name from the book's table
  of contents before falling back to the page's `<title>`, so books
  that style headings as `<div>`s no longer show the book's name for
  every chapter. Books already in the library need re-importing to
  pick this up.
- The project page shows chapter search, says the browser demo doesn't
  have it, and puts the app icon beside the name.

## [0.1.0] - 2026-09-23

The first tagged version, covering everything built so far.

### Added

- Import EPUBs into a local SQLite library, skipping a book whose file
  is already in it from any path.
- Full-text search across every book, ranked, with the matched words
  highlighted. "learn" also finds "learning" unless *Exact words* is
  ticked; case and diacritics are ignored; quoted phrases, `prefix*`
  and `AND`/`OR`/`NOT` work.
- Search terms expand to their curated transliteration variants, so
  `dharma` also finds "dhamma".
- A continuous-scroll reader with a chapter sidebar. Opening a search
  result centres and flashes the matching paragraph.
- Bookmark paragraphs into named folders.
- Remove a book from the library, so it can be re-imported.
- A launch screen with separate Books, Bookmarks and Search screens.
- The Paper visual style: bundled serif fonts that cover Pali
  diacritics, and a dark mode that follows the system theme.
- A project page on GitHub Pages with a browser demo of the real
  interface, using one CC0 book.
- Contributing guide, security policy, code of conduct, and issue and
  pull request templates.

### Changed

- Chapter titles come from the first `<h1>`/`<h2>`, falling back to the
  page's `<title>`.
- Books that use `<div>` rather than `<p>` for paragraphs are imported,
  each content block becomes one paragraph, and text split across
  inline tags (such as drop caps) is joined without adding spaces.
- The EPUB 3 navigation document is no longer imported as a chapter.
- The app shows an error and quits if it can't open its library,
  instead of crashing with nothing on screen.

### Fixed

- Punctuation in a search no longer breaks the query.

### Security

- Search snippets are rendered as text rather than HTML, and the app
  sets a Content Security Policy, so a book's text can't inject markup
  or script into the app.

[Unreleased]: https://github.com/mstyles/pitaka/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mstyles/pitaka/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mstyles/pitaka/releases/tag/v0.1.0
