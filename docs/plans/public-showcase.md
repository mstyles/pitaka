# Public showcase

## Context
Pitaka lives in a private repo with a developer-facing README, so there's nothing to show anyone. It's meant as a portfolio piece and as an app other readers might actually use, so the showcase needs three things: an open licence and a public repo, a README that says what the app is before it says how it's built, and a page where someone can try it in the browser without installing Rust or webkit2gtk.

The browser demo is the existing mock mode (`npm run dev:mock`), built as static files with one real book in place of the test fixtures, and hosted on GitHub Pages next to a one-page landing site. It is the real React UI; only the backend is simulated.

Out of scope: release builds and installers (`tauri-action`, code signing). The README and landing page say "build from source" until those exist, and they're added to the roadmap. No custom domain; the site is `https://mstyles.github.io/pitaka/`.

Ruled out:
- Real SQLite/FTS5 in the browser (sql.js or the Rust core compiled to WASM): a new dependency and about 1 MB of WASM, and whether its build has FTS5 with `porter` and `remove_diacritics` is unverified. A small TypeScript search, checked against the core's own results (section 5), is enough for one book.
- Canned search results for suggested queries only: anyone typing their own word gets nothing, which makes the demo look broken.
- The *Dhammapada* (`Sayings-of-the-Dhamma`) as the demo book: all 423 verses sit in one file, `dhp1-20.xhtml`, so it parses as one 451-paragraph chapter titled "Dhp 1–20 1. Pairs Yamakavagga".

Checked by parsing SuttaCentral's CC0 EPUBs (`github.com/suttacentral/editions`, `LICENSE` is CC0 1.0) with `parse_epub` + `import_book` in a scratch binary:
- *Verses of the Senior Nuns* (Therīgāthā, Bhikkhu Sujato, `en/sujato/thig/epub/Verses-of-the-Senior-Nuns-sujato-2026-08-26.epub`, 856 KB): 24 chapters, 794 paragraphs, 141 KB of text. The nav document is skipped. The chapters are the front matter, "The Book of the Ones" … "The Great Book", and the colophon.
- Its text has plenty of diacritics to show off diacritic-insensitive search: Therīgāthā (47), Isidāsī (20), Sumedhā (19), Paṭācārā (11), Māra (13). In the core, exact `nibbana` finds "Nibbāna", stemmed `craving` gets 11 hits, and `mind` gets 49.
- Two front-matter files have no `<h1>`/`<h2>`, so their chapter titles are file paths: `EPUB/halftitlepage.xhtml` and `EPUB/epigraph.xhtml`. Their XHTML `<title>` is "Verses of the Senior Nuns". Section 2 fixes this.
- `git log --all` has never held an EPUB other than the synthetic `ebook_research_core/test.epub`, and no DB or key files. Every commit is authored as `Matt Styles <mstyleshk@gmail.com>`, and that email becomes public with the repo.

## 1. Licence: `LICENSE-MIT`, `LICENSE-APACHE`, `Cargo.toml`s, `package.json`
- Add `LICENSE-MIT` (MIT, "Copyright (c) 2026 Matt Styles") and `LICENSE-APACHE` (Apache 2.0 full text) at the repo root.
- Add `license = "MIT OR Apache-2.0"` and `repository = "https://github.com/mstyles/pitaka"` to `ebook_research_core/Cargo.toml` and `src-tauri/Cargo.toml`. Add `"license": "MIT OR Apache-2.0"` to `package.json`, which stays `"private": true` so it's never published to npm.
- The fonts in `src/assets/fonts/` stay under their `OFL-*.txt` licences. The demo book is CC0. The README's new Licence section (section 7) says both.

## 2. Core: fall back to the XHTML `<title>` for chapter titles: `epub.rs`
- In `parse_epub`, a chapter with no `<h1>`/`<h2>` takes its document's `<title>` text (trimmed, whitespace collapsed) before falling back to the file path. This helps any book whose front matter has no headings, not only the demo. For the Therīgāthā the half-title and epigraph become "Verses of the Senior Nuns" instead of `EPUB/…xhtml`.
- `<title>` is read in the same pass as the paragraphs, inside `<head>` only, so a `<title>` inside an SVG in the body doesn't count.
- This partly addresses limitation 2 (the `<div class="ct">` books still have file-path titles if their `<title>` is empty). Books already imported keep their titles until re-imported, as with every parser change.

## 3. Demo data: `demo/`, `db.rs` test
- Commit the EPUB as `demo/verses-of-the-senior-nuns.epub`, with `demo/README.md` giving its source URL, translator, CC0 licence and download date. Keeping the file lets the data be regenerated after a parser change.
- New core test `demo_fixtures_are_current` in `db.rs`, next to `ui_fixtures_are_current` and built the same way (including the `UPDATE_UI_FIXTURES=1` switch): import the demo EPUB into `:memory:`, create one folder "Paṭācārā's verses" with two bookmarked passages, and write `src/demo/library.json` in the same `Fixtures` shape `mockBackend.ts` uses.
- It also writes `src/test/fixtures/demo-search.json`: the core's real `search()` output for a fixed list of queries, which section 5 compares the TypeScript search against. The queries are `patacara`, `mara`, `nibbana`, `craving`, `minds`, `"the deathless"`, `free*`, `mind NOT body` and `zzzz`, each in `stemmed` and `exact`. `search` is left out of `src/demo/library.json`.
- The ids in `src/demo/library.json` are the real SQLite ids, so bookmarks and chapter links behave as they do in the app.

## 4. Mock backend takes its data as options: `src/test/mockBackend.ts`
- `installMockBackend` gains a `data?: Fixtures` option (default: the current `fixtures`), used everywhere it reads `fixtures.*` now. It also gains `search?: (query: string, mode: SearchMode) => SearchResult[]` (default: the current fixture lookup). The existing tests don't change.
- A `importError?: string` option makes `import_book` reject with that message. The demo passes: "Importing your own EPUBs needs the desktop app. This demo has one book built in."
- `BooksView` already reports a rejected import as `Import failed: <err>`, so the demo needs no view change. `plugin:dialog|open` returns a fake path in the demo so the error is reached instead of a silent cancel.

## 5. Demo search: `src/demo/search.ts`
- `searchBlocks(chapters: ChapterContent[], books: BookSummary[], query: string, mode: SearchMode, limit = 50): SearchResult[]` mirrors `db::search` closely enough for one book:
  - Tokenise the way `unicode61 remove_diacritics 2` does: NFD, drop combining marks, lowercase, split on anything that isn't a letter or number.
  - Stemmed mode runs each token through a Porter stemmer: a compact port of the original algorithm (the one FTS5's `porter` implements) in `src/demo/porter.ts`, since no npm dependency is added.
  - Query syntax matches what `db::search` passes to FTS5: bare words are ANDed, `"quoted phrases"` match adjacent tokens, `prefix*` matches a token prefix, and uppercase `AND`/`OR`/`NOT` combine terms.
  - Ranking is BM25 (k1 = 1.2, b = 0.75, as FTS5 uses) over the block's tokens, lowest score first, like `bm25()`.
  - Snippets mimic `snippet(…, '[', ']', '...', 12)`: a window of 12 tokens around the best match, `[…]` around matched tokens, and `...` where text was cut.
- The index (token lists per block) is built once, the first time someone searches. 794 paragraphs need no worker.

## 6. Demo build: `src/main.tsx`, `src/DemoBanner.tsx`, `package.json`, `vite.config.ts`, `App.css`
- New scripts: `"dev:demo": "vite --mode demo --port 1431"` and `"build:demo": "tsc && vite build --mode demo --base /pitaka/demo/ --outDir dist-demo"`. Add `dist-demo/` to `.gitignore`.
- `main.tsx`: when `MODE === "demo"`, dynamically import `src/demo/library.json` and `src/demo/search.ts`, then call `installMockBackend({ data, search, importError })`. Title: "Pitaka — try it in your browser". Like the mock branch, this is dropped from `tauri build`.
- `DemoBanner.tsx`, rendered by `App` only in demo mode, is a slim bar above every screen: "You're trying Pitaka in your browser with one built-in book, the Therīgāthā. Bookmarks last until you reload. **Get the desktop app →**". The link goes to the repo README's install section. It uses the existing colour tokens, so dark mode works.
- The home screen needs nothing new: the library starts with the one book and the seeded folder.

## 7. README: `README.md`, `docs/screenshots/`
- A new top section for visitors, above the current architecture text (which moves under "## How it's built"):
  - A one-line pitch ("A desktop app for reading and researching your EPUB library: full-text search across every book, and bookmark folders for the passages you want to keep.").
  - A hero screenshot and **Try it in your browser** / **Website** links.
  - Features in plain words.
  - "Install": build from source, with the existing setup steps, until releases exist.
- Screenshots, taken from `npm run dev:demo` in Chrome at 1280×800 and saved to `docs/screenshots/`: `home.png`, `search.png` (a `patacara` search), `reader.png` and `bookmarks.png`, plus `search-dark.png`.
- A `## Licence` section: MIT OR Apache-2.0 at your option, the fonts under the SIL OFL, and the demo book CC0 from SuttaCentral with a credit to Bhikkhu Sujato.
- "What's actually verified" gains the `<title>` fallback, the demo data test and the demo search parity test. Limitation 2 mentions the `<title>` fallback. The roadmap ticks "Public repo, landing page and browser demo" and adds "Release builds for Linux, macOS and Windows" under Later.

## 8. Landing page and deploy: `site/`, `.github/workflows/pages.yml`
- `site/index.html` + `site/style.css` form one static page that reuses the Paper colour tokens and the bundled woff2 fonts (copied at build time, not duplicated in git). It has:
  - A hero with the wordmark, the pitch and a **Try it in your browser** button linking to `demo/`.
  - Three feature blocks with screenshots: search across the library, the reader with jump-to-hit, and bookmark folders.
  - "Get it": build from source, linking to the README.
  - A footer with the licence and the CC0 book credit.
  - No JavaScript. It works at phone width.
- `pages.yml` runs on pushes to `main` and on `workflow_dispatch`: `npm ci`, `npm run build:demo`, assemble `site/` + fonts + `docs/screenshots/` + `dist-demo/` as `demo/` into one directory, `actions/upload-pages-artifact`, then `actions/deploy-pages`. It has `pages: write` and `id-token: write` permissions.
- The deploy job has `if: ${{ !github.event.repository.private }}`, because Pages needs a public repo on the free plan. Until then it's skipped instead of failing.
- `ci.yml` also runs `npm run build:demo`, so a broken demo fails PRs.

## 9. Going public (last step, confirm first)
- Before flipping, I'll show you the exact commands and wait for a yes, since this can't meaningfully be undone once it's been cloned. Your commit email becomes public; if you'd rather it didn't, the choice is between rewriting history to your GitHub noreply address before going public, or accepting it.
- The commands:
  - `gh repo edit mstyles/pitaka --visibility public --accept-visibility-change-consequences`
  - `--description "Desktop EPUB research app: full-text search and bookmark folders across your library"`
  - `--homepage https://mstyles.github.io/pitaka/`
  - `--add-topic epub,tauri,rust,sqlite,full-text-search`
- Then enable Pages with the source set to GitHub Actions, re-run `pages.yml`, and check the live landing page and demo.

## 10. Tests
- `epub.rs` unit tests:
  - A chapter with no heading but `<title>Front Matter</title>` gets "Front Matter".
  - An empty or missing `<title>` still gives the file path.
  - An `<h2>` still wins over `<title>`.
  - A `<title>` inside `<body>` (an SVG title) is ignored.
- `integration.rs`: nothing changes. `test.epub`'s chapters have headings, which is worth checking once implemented.
- `demo_fixtures_are_current` checks both committed JSON files against fresh core output, and fails with the regenerate command. It also asserts:
  - The book has 24 chapters.
  - No chapter title ends in `.xhtml`.
  - Exact `nibbana` returns at least one hit whose snippet contains `[Nibbāna]`.
- `src/demo/search.test.ts` (Vitest):
  - For every query in `demo-search.json`, `searchBlocks` returns the same set of `content_block_id`s as the core.
  - The top 3 hits are in the same order.
  - Snippets are equal for at least the top hit.
  - Porter stemmer unit cases from the algorithm's reference vocabulary: `caresses`→`caress`, `ponies`→`poni`, `relational`→`relat`, `generalization`→`gener`.
- `src/Demo.test.tsx` renders `<App />` with the demo data via `renderApp` and checks:
  - The banner shows.
  - A `patacara` search shows "Paṭācārā" highlighted, and clicking the hit opens the reader at that paragraph.
  - Importing shows `Import failed: Importing your own EPUBs needs the desktop app…`.
- Browser check: `npm run build:demo && npx vite preview --outDir dist-demo --base /pitaka/demo/`, then click through Home, Search, Reader and Bookmarks in light and dark, at desktop and 390 px width. Open `site/index.html` from the assembled Pages directory the same way.

## Verification
1. `cargo test -p ebook_research_core`, `cargo clippy --workspace --all-targets`
2. `npx tsc --noEmit`, `npm test`, `npm run build:demo`
3. The browser check above, against mocks and the demo build. The Tauri window isn't affected apart from the chapter-title fallback, which the unit tests cover.
4. After going public: `pages.yml` succeeds, and `https://mstyles.github.io/pitaka/` and `/pitaka/demo/` load. A search and a bookmark work on the live demo.
