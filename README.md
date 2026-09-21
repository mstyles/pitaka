# Pitaka

A desktop e-book research app: EPUB parsing + SQLite/FTS5 search, wrapped
in a Tauri v2 shell (React + TypeScript frontend). The Rust side is split
into two crates on purpose:

- `ebook_research_core/` — all the real logic (EPUB parsing, offsets,
  DB schema/search ranking). No Tauri or UI dependency at all, so the
  hard parts are unit/integration-testable without ever spinning up a
  webview.
- `src-tauri/` — a thin Tauri command layer on top of the core crate
  (`src-tauri/src/commands.rs`), plus the app shell (`lib.rs`/`main.rs`).

This is a Cargo workspace (root `Cargo.toml`) with both crates as
members, sharing one `Cargo.lock`/`target/`.

## What's actually verified

- `ebook_research_core/src/epub.rs` — unzips an EPUB, walks
  `META-INF/container.xml` → the OPF manifest/spine → each chapter's
  XHTML, and splits it into paragraphs (`p`, `div`, `h1`-`h6`, `li`,
  `blockquote`) with char offsets. A block that directly contains text
  is one paragraph, nested blocks included; a block that only wraps
  other blocks is split into them. Text split across inline tags is
  joined as written, so a drop cap like `<b>B</b>EFORE` reads
  "BEFORE". Each chapter's title is its first `<h1>`/`<h2>`, falling
  back to the internal file path. The EPUB 3 navigation document (the
  manifest item whose `properties` include `nav`) is skipped, so the
  table of contents isn't a chapter or a source of search hits;
  `linear="no"` items and cover pages are kept, since they can hold
  real text such as notes. Checked against *Understanding Our Mind*
  (div-based) by running the parser directly: drop-cap words are no
  longer split, and each footnote is one paragraph with its number.
- `ebook_research_core/src/db.rs` — opens the SQLite DB via `rusqlite`
  and brings its schema up to date (see [Schema migrations](#schema-migrations)),
  imports books (each in one transaction, skipping any whose file
  contents are already in the library from any path), runs FTS5
  full-text search with ranked, highlighted snippets, and serves the
  reader's read queries
  (`list_books`, `get_book_chapters`, `get_chapter_content`).
  Bookmark folders (migration 003): create, rename and delete folders
  (names trimmed and unique ignoring case), bookmark a paragraph into
  several folders at most once each, list a folder's passages in the
  order added, and mark a chapter's bookmarked paragraphs. Unit tests
  cover moving pre-003 bookmarks into a "Bookmarks" folder, and that
  deleting a folder or a book cascades to exactly its bookmarks.
  Search has two modes: `stemmed` (porter stemmer, so "learn" also
  matches "learning") and `exact` (whole words as typed). Both ignore
  case and diacritics ("samsara" matches "saṃsāra"). Each word of the
  query is quoted before it reaches FTS5, so punctuation (`don't`,
  `self-aware`) is searched as text. "Quoted phrases", `prefix*` and
  uppercase `AND`/`OR`/`NOT` still work.
- `ebook_research_core/tests/integration.rs` — parses a real (synthetic,
  2-chapter) EPUB, checks its `nav.xhtml` spine item is skipped (exactly
  2 chapters, contiguous `idx`), loads it into a fresh DB, and asserts
  search returns correct, ranked hits in both modes, chapter titles
  round-trip, and search hits point at the right chapter content, and
  that duplicate imports return the existing book. It also upgrades a
  library created before migrations existed and checks both indexes
  were rebuilt from its text, and bookmarks a real paragraph into a
  folder, reading back its book, chapter and text, then checks removing
  the book empties the folder but keeps it. `cargo test -p ebook_research_core` passes.
- The frontend typechecks (`npx tsc --noEmit`):
  - `src/LibraryView.tsx` — native file-picker → `import_book`, a book
    list from `list_books`, and a search box with an "Exact words"
    toggle → `search_library` rendering highlighted snippets, and a
    "Bookmarks" list of folders with counts. `src/FolderView.tsx` shows
    a folder's passages (click to open in the reader, Remove), with
    Rename and Delete.
  - `src/ReaderView.tsx` — continuous-scroll reader with a chapter
    sidebar. Clicking a book opens it at the first chapter; clicking a
    search hit opens its chapter, centres the matching paragraph and
    briefly flashes it. A bookmark icon in each paragraph's margin
    (filled when it's in any folder) opens `src/BookmarkPopover.tsx`
    to tick it into folders or into a new one.

- Frontend tests (`npm test`, Vitest + Testing Library in jsdom) render
  the whole app against a mocked backend (`src/test/mockBackend.ts`,
  using Tauri's `mockIPC`). They cover importing (new, duplicate,
  cancelled), searching in both modes with highlighted snippets,
  removing a book (confirmed or not), opening the reader, centring and
  flashing a search hit, switching chapters, going back with the search
  kept, error messages, and bookmark folders: creating, renaming,
  deleting (confirmed or not), removing passages, opening a passage in
  the reader and coming back to its folder, the Remove-book warning
  with its bookmark count, and bookmarking from the reader's popover
  (tick, untick, new folder, duplicate-name error, closing it). The mock replays
  `src/test/fixtures/library.json`, which the core test
  `ui_fixtures_are_current` writes from real `db.rs` output for
  `test.epub` plus a synthetic 3×40-paragraph book. That test fails when
  the committed file is out of date, so a changed Rust type can't
  silently drift from what the tests feed the UI. What they can't catch: argument names the real
  Tauri layer expects (`bookId` → `book_id`) and anything in
  `commands.rs`, since neither runs.
- `npm run dev:mock` serves the same mocked UI on :1430 for a browser
  check; `/ship` walks it in Chrome with screenshots. Real layout and
  scrolling, but still not the Tauri window or the Rust side. Walked
  once when this was added: the "quincunx" hit opened Part Two scrolled
  so the paragraph sat within 1px of the viewport's centre, flashing;
  switching chapters reset the scroll with no flash; going back kept the
  search; Exact words re-ran it; removing a book dropped its row and
  hits. No console errors. Walked again for bookmark folders: the
  folder listed with counts, the fixture paragraph's icon was filled, a
  paragraph was bookmarked into a new folder and the existing one from
  the popover, the library counts updated, and a passage opened in the
  reader flashing, with "← Library" returning to the folder. No console
  errors. Not checked in dark mode.

`src-tauri` builds, `npm run tauri dev` launches the app, and the UI has
been clicked through end to end in the Tauri window (before the "Exact
words" toggle was added, and not since `nav.xhtml` started being
skipped or the paragraph-extraction rewrite: re-imported books haven't
been checked in the reader). Bookmark folders haven't been clicked
through in the Tauri window, and migration 003 hasn't been run against
a real library yet. The build needs the Linux system webview libs
(webkit2gtk, dbus, appindicator, etc.):

```
sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev \
  libjavascriptcoregtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev pkg-config
```

then `npm run tauri dev` to launch the app.

## Project structure

```
pitaka/
├── Cargo.toml                  <- workspace root
├── ebook_research_core/        <- core crate, no UI/Tauri dependency
│   ├── Cargo.toml
│   ├── migrations/             <- numbered schema migrations (001 = base schema)
│   ├── src/{lib,epub,db}.rs
│   └── tests/integration.rs
├── src-tauri/
│   ├── Cargo.toml               <- ebook_research_core = { path = "../ebook_research_core" }
│   └── src/
│       ├── main.rs
│       ├── lib.rs                <- registers commands + plugins
│       └── commands.rs           <- import_book / search_library / list_books /
│                                    get_book_chapters / get_chapter_content /
│                                    bookmark folder + bookmark commands
├── src/                         <- React + TS frontend
│   ├── App.tsx                  <- switches between library and reader
│   ├── LibraryView.tsx          <- import, book list, bookmark folders, search
│   ├── FolderView.tsx           <- one folder's passages
│   ├── ReaderView.tsx           <- chapter sidebar + scrolling text
│   ├── BookmarkPopover.tsx      <- tick a paragraph into folders
│   ├── *.test.tsx               <- component tests (npm test)
│   ├── test/                    <- mocked backend, fixtures, test setup
│   └── types.ts                 <- TS mirrors of the Rust command types
└── package.json
```

## Schema migrations

The schema lives in `ebook_research_core/migrations/`, applied in order by
[`rusqlite_migration`](https://docs.rs/rusqlite_migration) when `open_db`
runs. The DB's `PRAGMA user_version` records how many have been applied.

- To change the schema, add the next numbered `.sql` file and list it in
  `migrations()` in `db.rs`. Don't edit a migration that has already run
  against a real library.
- `db::tests::migrations_are_valid` applies every migration to an empty
  in-memory DB, so a broken migration fails `cargo test`.
- Libraries created before migrations were tracked have the 001 schema
  but `user_version = 0`; `open_db` marks them as version 1 first.
- `rusqlite` is a dependency of both `ebook_research_core` and `src-tauri`
  (which holds the core crate's `Connection`), so bump them together, and
  keep `rusqlite_migration` on the release built for that `rusqlite`.

## Setup steps

1. Install the Tauri Linux prerequisites (see command above).
2. `npm install` at the repo root.
3. `npm run tauri dev` — opens the app with hot-reload.
4. `npm run tauri build` — produces a release bundle.
5. `npm test` — frontend tests; `npm run dev:mock` — the UI in a
   browser on :1430 against the mocked backend.

## Known limitations (same order of priority as the Python version)

1. No distinct handling of footnotes/endnotes.
2. Chapter titles come from the first `<h1>`/`<h2>`, but there's no
   migration: books imported before that change keep file-path titles
   until re-imported. Books that style headings as `<div>`s (e.g.
   `<div class="ct">`) instead of `<h1>`/`<h2>` also get file-path
   titles. Books imported before the EPUB 3 nav document was skipped
   keep it as a chapter until they're removed and re-imported.
3. Images, tables, and other non-text content are silently dropped, and
   formatting is lost — the reader renders every block as a plain `<p>`.
   A paragraph that contains a nested block (e.g. a lead-in sentence
   wrapping a numbered list of `<div>`s) is kept as one paragraph, and
   a heading nested inside a paragraph isn't treated as a heading.
4. No re-index logic: if a book's file changes after it was imported,
   importing it again from the same path fails with an error (remove the
   book first, then import it), and a changed copy at a new path is added
   as a separate book. Parser changes likewise only apply on import:
   books imported before the paragraph-extraction rewrite keep their old
   paragraph splits (and drop-cap spaces) until removed and re-imported.
5. `extract_paragraphs` tolerates malformed XHTML by bailing out on the
   first parse error (keeping the text read so far) rather than trying
   to recover — real-world EPUBs
   occasionally have genuinely broken markup, so you may want a
   best-effort recovery path (e.g. retry with an HTML-mode parser)
   before shipping.
6. Bookmarks point at paragraphs, so removing a book (including to
   re-import it after a parser fix) deletes its bookmarks from every
   folder; the Remove dialog only warns with a count. Bookmarks cover
   whole paragraphs, and passages can't be reordered within a folder.

## Roadmap

Done:

- [x] EPUB import with FTS5 full-text search and highlighted snippets
- [x] Library list and continuous-scroll reader with jump-to-search-hit
- [x] Chapter titles from the first `<h1>`/`<h2>`
- [x] Exact-word search mode alongside stemmed search
- [x] Versioned schema migrations
- [x] Quote search terms before passing them to FTS5 so punctuation
      doesn't break the query
- [x] De-dup imports by `file_hash` instead of adding a second `books`
      row
- [x] Import paragraphs from books that use `<div>` instead of `<p>`
- [x] Remove a book from the library, so it can be re-imported
- [x] Emit one paragraph per content block, so nested tags neither
      duplicate nor chop up text
- [x] Join text split across inline tags without adding spaces, so
      drop caps like "B EFORE" are searchable
- [x] Skip the EPUB 3 navigation document (e.g. `nav.xhtml`) in the
      spine (limitation 2)
- [x] Bookmark paragraphs into named folders

Next up (fixes for the known limitations above):

- [ ] Recover from malformed XHTML instead of bailing on the first
      parse error (limitation 5)

Later:

- [ ] Highlights and notes UI (the `highlights` and `notes` tables
      already exist in the schema)
- [ ] Reorder passages within a bookmark folder
- [ ] Keep bookmarks when a book is removed and re-imported
      (limitation 6)
- [ ] Export bookmarks, notes and highlights
- [ ] Footnote/endnote handling (limitation 1)
- [ ] Keep formatting, images and tables in the reader instead of
      rendering every block as a plain `<p>` (limitation 3)

## Workflow roadmap

Work goes `/plan` → branch → `/ship` → `/pr` → review → `/merge` (see
CLAUDE.md). Gaps in that workflow, most important first:

- [ ] Run a feature through the whole flow, including `/pr` and the
      review step (neither has been used yet; bookmark folders is next)
- [x] Verify the UI automatically: frontend tests against a mocked
      backend in CI, and a browser check in `/ship`
- [ ] End-to-end tests of the real Tauri window (`tauri-driver` +
      WebKitWebDriver), which would also cover `commands.rs` and
      argument names — worth it once the command layer grows
- [ ] Run `/code-review` in `/pr` before opening the PR, so the diff
      gets a first review pass
- [ ] Decide whether plans should go through a PR too, instead of
      `/plan` committing them straight to `main`
- [ ] Enforce the review step: `main` isn't protected (branch
      protection needs GitHub Pro on a private repo), so PRs are a
      convention kept by the skills and CLAUDE.md
- [ ] Pre-approve the routine commands `/pr` and `/merge` still prompt
      for (`git push`, `gh`), e.g. with `/fewer-permission-prompts`
      after a PR cycle or two
