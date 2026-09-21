# Verify the UI automatically

## Context
Only the core crate has tests. CI typechecks the frontend but never runs it, and the README admits the reader hasn't been clicked through in the Tauri window since the nav-skip and paragraph-extraction changes. Every UI change so far has shipped with "UI not clicked through". Bookmark folders is next and adds real UI, so the frontend needs tests first. This is the "Verify the UI automatically" item in the README's workflow roadmap.

Two layers:
- **Component tests in CI**: Vitest + Testing Library in jsdom, with Tauri's `mockIPC` answering `invoke`. They cover frontend logic: what each view calls, with which arguments, and what it renders from the result.
- **A browser check in `/ship`**: the Vite dev server runs against the same mocked backend, and Claude drives it in Chrome and takes screenshots. This covers what jsdom can't: layout, scrolling to a search hit and the flash.

The mocks replay JSON fixtures written by a core test from real `db.rs` output. If a Rust type changes shape, the fixture test fails until the fixtures are regenerated, and then the frontend tests see the new shape. This doesn't catch wrong argument names (`bookId` vs `book_id`), because Tauri's camelCase-to-snake_case mapping only runs in the real app. The tests assert the argument names the frontend sends, but those expected names are written by hand.

Out of scope: full end-to-end tests of the real Tauri window (`tauri-driver` + WebKitWebDriver). It's the only option that checks `commands.rs` wiring, but it needs xvfb in CI, a full app build and a test hook to get past the native GTK file dialog. Revisit when the command layer grows. Also out of scope: Playwright in CI (the Chrome check covers layout for now without a browser download) and generating `types.ts` from Rust (ts-rs/specta).

Dependencies: the user approved `vitest`, `@testing-library/react`, `@testing-library/user-event` and `jsdom` as npm dev dependencies. The core crate also gains `serde_json` as a dev-dependency (already in `Cargo.lock` through `src-tauri`). `@testing-library/jest-dom` isn't added, so tests use plain `expect` on Testing Library queries.

Checked in `node_modules`:
- `@tauri-apps/api` 2.11.1 exports `mockIPC(cb, options)` and `clearMocks()` from `@tauri-apps/api/mocks`. `mockIPC` only sets `window.__TAURI_INTERNALS__`, so it works in both jsdom and a plain browser tab.
- Dialog `open` invokes `plugin:dialog|open`. `ask` invokes `plugin:dialog|message` and resolves `true` only when the result equals `okLabel` (`"Remove"` in `LibraryView`). The mock can therefore confirm or cancel without a real browser dialog.
- `test.epub` has 2 short chapters of 2–3 paragraphs each, which is too short to scroll. The fixtures therefore also include a synthetic long book.

## 1. Core fixtures: `db.rs`, `Cargo.toml`
- Add `serde_json = "1"` under `[dev-dependencies]` in `ebook_research_core/Cargo.toml`.
- New `#[cfg(test)]` test `ui_fixtures_are_current` in `db.rs`. It lives there so it can call the private `load_book`:
  - `open_db(":memory:")`, then `import_book(&mut conn, "test.epub")` (unit tests run from the crate directory). Import it a second time to capture an `already_imported: true` outcome.
  - `load_book` a synthetic "A Long Book for Scrolling" (author "Fixture Author"): 3 chapters titled "Part One"–"Part Three", 40 paragraphs each of filler text. Paragraph 30 of "Part Two" contains the unique word "quincunx", so a search hit lands far down a scrollable chapter.
  - Build one `serde_json::json!` value, with `BTreeMap`s keyed by id so the output order is stable:
    - `import_new`, `import_again`: `ImportOutcome`
    - `books`: `list_books`
    - `chapters`: book id → `get_book_chapters`
    - `chapter_content`: chapter id → `get_chapter_content`
    - `search`: `"<mode>:<query>"` → `search(.., 50)` for `neural networks` (stemmed and exact), `quincunx` (stemmed) and `zzzz` (stemmed, empty)
  - Serialise with `to_string_pretty` plus a trailing newline. Compare with `src/test/fixtures/library.json`, resolved via `env!("CARGO_MANIFEST_DIR")/../src/test/fixtures/library.json`.
  - If `UPDATE_UI_FIXTURES=1`, write the file instead. Otherwise fail with `src/test/fixtures/library.json is out of date: run UPDATE_UI_FIXTURES=1 cargo test -p ebook_research_core ui_fixtures`.
- This is a test writing a data file, not a UI dependency, so the core crate's no-UI rule holds. In-memory ids are deterministic. `rank` floats are stable because SQLite is bundled.

## 2. Mock backend: `src/test/mockBackend.ts`
- `installMockBackend(opts?: { openPath?: string | null; confirm?: boolean; fail?: Partial<Record<string, string>> })` calls `mockIPC` and returns `{ calls: { cmd: string; args: unknown }[] }`, so tests can assert what was invoked.
- It's stateful over a copy of `library.json`:
  - `list_books` returns the current books.
  - `import_book` returns `import_again` if the fixture book is still listed. Otherwise it re-adds the book and returns `import_new`.
  - `delete_book` removes the book by `bookId`, or rejects with `no book with id N`.
  - `get_book_chapters`/`get_chapter_content` look up by `bookId`/`chapterId`.
  - `search_library` looks up `` `${mode}:${query}` ``, returns `[]` if the key is missing, and filters out hits from deleted books.
  - `plugin:dialog|open` returns `openPath` (default `/books/test.epub`). `plugin:dialog|message` returns `"Remove"` if `confirm` (default true), otherwise `"Cancel"`.
- `fail[cmd]` makes that command reject with the given message.
- Any other command throws `unmocked command: <cmd>`, so a new command without a mock fails loudly.

## 3. Test setup: `package.json`, `vite.config.ts`, `src/test/setup.ts`
- Dev dependencies: `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`.
- Scripts: `"test": "vitest run"` and `"dev:mock": "vite --mode mock --port 1430"`. The different port avoids a clash with `tauri dev` on 1420.
- `vite.config.ts`: import `defineConfig` from `vitest/config` and add `test: { environment: "jsdom", setupFiles: ["src/test/setup.ts"] }`. The Tauri server options stay as they are.
- `setup.ts`:
  - `afterEach(() => { cleanup(); clearMocks(); vi.useRealTimers(); })`.
  - Stub `Element.prototype.scrollIntoView = vi.fn()`, since jsdom doesn't implement it and `ReaderView` calls it.
- Tests live beside the code as `src/*.test.tsx` and import `describe/it/expect/vi` from `vitest` (no globals), so `tsc` typechecks them with no `types` change. `vite build` only bundles from `index.html`, so tests stay out of `dist/`.

## 4. Mock mode for the browser: `src/main.tsx`
- Before rendering: `if (import.meta.env.MODE === "mock") { const { installMockBackend } = await import("./test/mockBackend"); installMockBackend(); document.title = "pitaka (mock backend)"; }`. This needs top-level await, which the ES2020+ module target and Vite support; it's checked by `npm run build`.
- Vite replaces `MODE` statically, so the branch and the fixture JSON are dropped from production builds. Implementation check: `npm run build && ! grep -r quincunx dist/`.

## 5. Component tests: `src/LibraryView.test.tsx`, `src/ReaderView.test.tsx`
Both render `<App />`, so each flow crosses the library/reader switch the way a user does.

Library:
- Lists both fixture books with "Unknown author · 2 chapters" for `test.epub` and "Fixture Author · 3 chapters" for the long book.
- Import:
  - Import of a book already in the library shows "Already in library as book #1". `import_book` receives `{ path: "/books/test.epub" }`.
  - After removing `test.epub`, importing it shows "Imported book #1" and the list shows it again.
  - A cancelled picker (`openPath: null`) makes no `import_book` call.
- Search:
  - Submitting "neural networks" calls `search_library` with `{ query: "neural networks", mode: "stemmed" }` and renders snippets with `<mark>` elements.
  - Ticking "Exact words" re-runs the search with `mode: "exact"`.
- Remove:
  - Confirming calls `delete_book` with `{ bookId }`, shows `Removed "Test Book of Research"`, removes the row and drops that book's search results.
  - With `confirm: false`, no `delete_book` call is made.
- Errors: `fail.list_books` shows "Loading library failed: …" and `fail.search_library` shows "Search failed: …".

Reader:
- Clicking the long book shows the three part titles in the sidebar with "Part One" `active`, and renders its 40 paragraphs.
- Clicking the "quincunx" hit:
  - opens "Part Two" and calls `scrollIntoView` with `{ block: "center" }` on `#block-<id>` (the hit's `content_block_id`)
  - gives that paragraph the `flash` class
  - after `vi.advanceTimersByTime(2000)` (fake timers, `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })`), removes `flash`
- Choosing "Part Three" loads its content with no `flash`.
- "← Library" returns to the library with the query and results still shown.
- `fail.get_chapter_content` shows "Loading chapter failed: …".

## 6. Browser check in `/ship`: `.claude/skills/ship/SKILL.md`
- Add `npm test` to step 2's checks.
- New step after the checks, "UI check": if the diff touches `src/` or a type in `types.ts`/`db.rs`:
  1. Run `npm run dev:mock` in the background.
  2. Use the claude-in-chrome tools to open `http://localhost:1430` in a new tab and walk this script, taking a screenshot at each step:
     - the library lists 2 books
     - search "quincunx", open the hit, and check that the paragraph is centred and flashing
     - switch to another chapter in the sidebar
     - go back, and check the results are kept
     - tick Exact words
     - remove a book
     - then exercise the change's own UI
  3. Stop the dev server afterwards.
  - If Chrome isn't connected, say so and record the UI check as not done. Don't block the commit.
- Step 4 wording: record "checked in the browser against the mocked backend" or "not checked", and separately whether the Tauri window was clicked through.
- `.claude/skills/pr/SKILL.md` and `merge/SKILL.md`: add `npm test` to their check lists.

## 7. CI and docs: `ci.yml`, `CLAUDE.md`, `README.md`
- `ci.yml`: add `- run: npm test` to the `frontend` job after `tsc`. The Rust job's `cargo test` already fails on stale fixtures.
- `CLAUDE.md` Commands: add `npm test` (frontend tests) and `npm run dev:mock` (the UI against the mocked backend on :1430). "Before calling work done" now also includes `npm test`.
- `CLAUDE.md` "Tests go in the core crate": add that frontend tests go in `src/*.test.tsx` against `installMockBackend`. A new command needs a fixture entry in `ui_fixtures_are_current` and a route in `mockBackend.ts`.
- `README.md`:
  - "What's actually verified": add a frontend-tests bullet and say the browser check runs against mocks, not the Tauri window.
  - Project structure: add `src/test/`.
  - Setup steps: add `npm test`.
  - Workflow roadmap: tick the "Verify the UI automatically" item, noting `tauri-driver` end-to-end tests as a later option.

## 8. Tests
- `cargo test -p ebook_research_core`:
  - `ui_fixtures_are_current` passes against the committed `library.json`.
  - Editing one value in the JSON makes it fail with the regenerate message.
- `npm test`: all cases in section 5 pass. As a one-off sanity check, not kept: dropping the `flash` class in `ReaderView` or deleting a route from `mockBackend.ts` makes the matching test fail.
- `npm run build` succeeds and `dist/` doesn't contain `quincunx`.
- Run the section 6 browser check once by hand on this branch as its own proof, with screenshots in the PR description.

## Implementation notes (differences from this plan)
- `test.epub` has an author ("A. Tester"), so the library test expects "A. Tester · 2 chapters", not "Unknown author".
- `main.tsx` wraps startup in an `async function start()` instead of using top-level await. It does the same job without depending on the build target.
- Shared test helpers live in `src/test/renderApp.tsx`: `renderApp(opts)` returns `user` and `callsTo(cmd)`, alongside `search()` and `resultItems()`. `setup.ts` also runs `vi.clearAllMocks()` so `scrollIntoView` calls don't leak between tests.
- Sanity checks, each reverted: without the `flash` class, or with `block: "start"`, the hit test fails. Sending `book_id` instead of `bookId` fails the two remove tests. Renaming the `get_book_chapters` route fails the four reader tests. Editing a chapter title in the fixture fails `ui_fixtures_are_current` with the regenerate message.
- The browser check ran once on this branch against `npm run dev:mock` (see README). Two screenshot captures timed out mid-run, so the "back to library" step was checked through the DOM instead.
- The Tauri window wasn't clicked through.
