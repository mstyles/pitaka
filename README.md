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
  XHTML, and splits it into paragraphs (`p`, `h1`-`h6`, `li`,
  `blockquote`) with char offsets. Each chapter's title is its first
  `<h1>`/`<h2>`, falling back to the internal file path.
- `ebook_research_core/src/db.rs` — opens the SQLite DB via `rusqlite`
  and brings its schema up to date (see [Schema migrations](#schema-migrations)),
  inserts parsed books, runs FTS5 full-text search with ranked,
  highlighted snippets, and serves the reader's read queries
  (`list_books`, `get_book_chapters`, `get_chapter_content`).
  Search has two modes: `stemmed` (porter stemmer, so "learn" also
  matches "learning") and `exact` (whole words as typed). Both ignore
  case and diacritics ("samsara" matches "saṃsāra").
- `ebook_research_core/tests/integration.rs` — parses a real (synthetic,
  2-chapter) EPUB, loads it into a fresh DB, and asserts search returns
  correct, ranked hits in both modes, chapter titles round-trip, and
  search hits point at the right chapter content. It also upgrades a
  library created before migrations existed and checks both indexes
  were rebuilt from its text. `cargo test -p ebook_research_core` passes.
- The frontend typechecks (`npx tsc --noEmit`):
  - `src/LibraryView.tsx` — native file-picker → `import_book`, a book
    list from `list_books`, and a search box with an "Exact words"
    toggle → `search_library` rendering highlighted snippets.
  - `src/ReaderView.tsx` — continuous-scroll reader with a chapter
    sidebar. Clicking a book opens it at the first chapter; clicking a
    search hit opens its chapter, centres the matching paragraph and
    briefly flashes it.

`src-tauri` builds, `npm run tauri dev` launches the app, and the UI has
been clicked through end to end in the Tauri window (before the "Exact
words" toggle was added). The build needs the Linux system webview libs
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
│                                    get_book_chapters / get_chapter_content
├── src/                         <- React + TS frontend
│   ├── App.tsx                  <- switches between library and reader
│   ├── LibraryView.tsx          <- import, book list, search
│   ├── ReaderView.tsx           <- chapter sidebar + scrolling text
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

## Known limitations (same order of priority as the Python version)

1. Nested block tags (e.g. `<li><p>...</p></li>`) will currently produce
   one paragraph per tag, so nested cases get duplicated text — walk
   top-level children instead of tracking a flat depth stack once you
   hit this.
2. No distinct handling of footnotes/endnotes.
3. Chapter titles come from the first `<h1>`/`<h2>`, but there's no
   migration: books imported before that change keep file-path titles
   until re-imported. Spine items like `nav.xhtml` also show up as
   chapters in the reader.
4. Images, tables, and other non-text content are silently dropped, and
   formatting is lost — the reader renders every block as a plain `<p>`.
5. No de-dup/re-index logic: importing the same file twice creates a
   second `books` row. Check `file_hash` against existing rows first.
6. Search queries go straight into FTS5's query syntax, so punctuation in
   an unquoted query fails with an FTS5 error instead of searching:
   `don't` → `syntax error near "'"`, `self-aware` → `no such column:
   aware`, `a.b` → `syntax error near "."`. Wrapping the query (or each
   term) in double quotes works around it. Affects both search modes.
7. `extract_paragraphs` tolerates malformed XHTML by bailing out on the
   first parse error rather than trying to recover — real-world EPUBs
   occasionally have genuinely broken markup, so you may want a
   best-effort recovery path (e.g. retry with an HTML-mode parser)
   before shipping.
