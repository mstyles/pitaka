# Changelog

Notable changes to Pitaka, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There are no
release builds yet, so a version here is a tagged commit on `main` to
build from.

## [Unreleased]

### Added

- Find chapters by meaning, in a build with `--features semantic`:
  Search gains a Passages / Chapters switch, and a chapter result opens
  the reader at the paragraph that matched. A small embedding model
  runs locally, downloaded once on first use. Books are indexed in the
  background when imported, with progress on the Books screen; books
  already in the library need re-importing to be included.

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

[Unreleased]: https://github.com/mstyles/pitaka/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mstyles/pitaka/releases/tag/v0.1.0
