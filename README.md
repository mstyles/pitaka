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
  `blockquote`) with char offsets.
- `ebook_research_core/src/db.rs` — loads `schema.sql` into SQLite via
  `rusqlite`, inserts parsed books, and runs FTS5 full-text search with
  ranked, highlighted snippets.
- `ebook_research_core/tests/integration.rs` — parses a real (synthetic,
  2-chapter) EPUB, loads it into a fresh DB, and asserts search returns
  correct, ranked hits. `cargo test -p ebook_research_core` passes.
- The frontend (`src/App.tsx`) typechecks (`npx tsc --noEmit`) and wires
  up both commands: a native file-picker → `invoke('import_book', {path})`,
  and a search box → `invoke('search_library', {query})`, rendering
  highlighted snippets.

`src-tauri` has **not** been build/run-verified end to end yet — that
needs the Linux system webview libs (webkit2gtk, dbus, appindicator,
etc.), which aren't installed as of this commit. Run:

```
sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev \
  libjavascriptcoregtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev pkg-config
```

then `npm run tauri dev` to confirm the shell actually launches.

## Project structure

```
pitaka/
├── Cargo.toml                  <- workspace root
├── ebook_research_core/        <- core crate, no UI/Tauri dependency
│   ├── Cargo.toml
│   ├── src/{lib,epub,db}.rs
│   └── tests/integration.rs
├── src-tauri/
│   ├── Cargo.toml               <- ebook_research_core = { path = "../ebook_research_core" }
│   └── src/
│       ├── main.rs
│       ├── lib.rs                <- registers commands + plugins
│       └── commands.rs           <- import_book / search_library
├── src/                         <- React + TS frontend
├── schema.sql
└── package.json
```

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
3. Chapter "titles" are just the internal file path — pull the real
   heading text from the first `<h1>`/`<h2>` for display purposes.
4. Images, tables, and other non-text content are silently dropped.
5. No de-dup/re-index logic: importing the same file twice creates a
   second `books` row. Check `file_hash` against existing rows first.
6. `extract_paragraphs` tolerates malformed XHTML by bailing out on the
   first parse error rather than trying to recover — real-world EPUBs
   occasionally have genuinely broken markup, so you may want a
   best-effort recovery path (e.g. retry with an HTML-mode parser)
   before shipping.
