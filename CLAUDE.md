# Pitaka

Tauri v2 desktop app for researching EPUBs: Rust core (parsing, SQLite/FTS5
search) + React/TypeScript frontend. README.md has the architecture, known
limitations and roadmap — read it before planning a feature.

## Commands

- `cargo test -p ebook_research_core` — core unit + integration tests
- `cargo clippy --workspace --all-targets` — must be warning-free
- `cargo fmt --all` — runs automatically after Rust edits (hook)
- `npx tsc --noEmit` — frontend typecheck
- `npm test` — frontend component tests (Vitest, mocked backend)
- `npm run dev:mock` — the UI in a browser on :1430 against the mocked
  backend, no Rust needed
- `npm run dev:demo` — the public browser demo on :1431 (one real book,
  `src/demo/`); `npm run build:site` builds the GitHub Pages site into
  `site-build/`
- `npm run tauri dev` — launch the app (needs the webkit2gtk libs in README)

Before calling work done, run tests, clippy, tsc and `npm test`. Say what
was verified and what wasn't (e.g. "checked in the browser against mocks,
not clicked through in the Tauri window").

## Architecture rules

- All logic lives in `ebook_research_core`, which has no Tauri/UI
  dependency. `src-tauri/src/commands.rs` stays a thin wrapper: lock
  `state.conn`, call the core function, map `anyhow` errors to `String`.
- New commands: core fn in `db.rs`, re-export from `lib.rs`, wrapper in
  `commands.rs`, register in `generate_handler!` in `src-tauri/src/lib.rs`,
  mirror the types in `src/types.ts`.
- Schema changes are a new numbered file in
  `ebook_research_core/migrations/` listed in `migrations()` in `db.rs`.
  Never edit a migration that has already shipped.
- `rusqlite` is a dependency of both crates — bump them together, and keep
  `rusqlite_migration` on the matching release.
- Frontend: plain `useState`, no router or state library. Don't add npm or
  crate dependencies without asking.
- Tests go in the core crate (`#[cfg(test)]` in the module, or
  `tests/integration.rs` against `test.epub`). Note `test.epub`'s spine
  starts with `nav.xhtml`, so find chapters by title, not index.
- Frontend tests go in `src/*.test.tsx`, rendering `<App />` via
  `renderApp` against `src/test/mockBackend.ts`. Its data,
  `src/test/fixtures/library.json`, is written by the core test
  `ui_fixtures_are_current` from real `db.rs` output; after changing a
  returned type, regenerate it with
  `UPDATE_UI_FIXTURES=1 cargo test -p ebook_research_core ui_fixtures`.
  A new command needs a fixture entry there and a route in the mock,
  which throws on unknown commands.

## Workflow

Skills cover each step: `/plan <feature>`, `/ship`, `/pr`, `/merge`. CI
(`.github/workflows/ci.yml`) runs fmt, clippy `-D warnings`, core tests,
tsc and the Vite build on pushes to `main` and on PRs.

1. **Plan**: for anything non-trivial, write `docs/plans/<kebab-name>.md`
   first — a `## Context` section (the problem and what's out of scope),
   then numbered sections per area naming the exact files and functions,
   ending with a tests section. Commit it to `main` as
   "Add <feature> plan" and get approval before implementing.
2. **Build** on a branch: `feat/<name>` or `fix/<name>`.
3. **Commit** messages: imperative, user-facing title ("Skip importing books
   that are already in the library"); body explains why and what changed in
   prose, wrapped at 72 columns.
4. **Docs**: update README in the same commit — the "What's actually
   verified" section, known limitations, and tick the roadmap item.
5. **PR**: push the branch and open a pull request against `main` for
   the user to review. Don't merge until they've reviewed it.
6. **Merge** after review with `git merge --no-ff` into `main` and push;
   the merge body lists each merged commit's title only, as
   `* <title>` lines. Pushing the merge marks the PR as merged.
