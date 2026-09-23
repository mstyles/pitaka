# Contributing to Pitaka

Thanks for your interest. Pitaka is a small personal project, but bug
reports, fixes and ideas are welcome.

## Reporting a bug

Open an issue using the bug report template. For import or display
problems, say where the EPUB came from (publisher, or a link if it's
freely available) and which OS you're on: most bugs are specific to how
a particular book is put together. Please don't attach a book you don't
have the right to share.

Security problems go through [SECURITY.md](SECURITY.md) instead, not a
public issue.

## Before writing code

For anything bigger than a small fix, open an issue first to talk it
through, so you don't spend time on something that won't fit. It's
worth reading the README's [How it's built](README.md#how-its-built),
[Known limitations](README.md#known-limitations) and
[Roadmap](README.md#roadmap) sections first.

A few rules the codebase follows:

- All logic lives in the `ebook_research_core` crate, which has no
  Tauri or UI dependency. `src-tauri/src/commands.rs` stays a thin
  wrapper around it.
- Schema changes are a new numbered file in
  `ebook_research_core/migrations/`. A migration that has already
  shipped is never edited.
- The frontend uses plain React state, with no router or state library.
  Please ask in an issue before adding an npm or crate dependency.

## Setting up

See [Install](README.md#install) for the system libraries. Then:

```sh
npm install
npm run dev:mock     # the UI in a browser against a mocked backend, no Rust needed
npm run tauri dev    # the full desktop app
```

## Checks

Run all of these before opening a pull request. CI runs the same ones.

```sh
cargo fmt --all
cargo clippy --workspace --all-targets   # must be warning-free
cargo test -p ebook_research_core
npx tsc --noEmit
npm test
```

Core logic is tested in the core crate, either with `#[cfg(test)]` in
the module or in `tests/integration.rs` against `test.epub`. Frontend
tests live in `src/*.test.tsx` and render the app against
`src/test/mockBackend.ts`. If you change a type the backend returns,
regenerate the mock's fixtures with
`UPDATE_UI_FIXTURES=1 cargo test -p ebook_research_core ui_fixtures`.

## Pull requests

- Branch from `main` as `fix/<name>` or `feat/<name>`.
- Write commit titles in the imperative, describing what changes for
  the user ("Skip importing books that are already in the library"),
  with a body that explains why.
- Update the README in the same change: "What's actually verified",
  the known limitations and the roadmap, as they apply.
- In the PR, say what you checked and what you didn't (for example,
  "checked in the browser against mocks, not in the Tauri window").

By contributing, you agree that your work is licensed under the
project's MIT OR Apache-2.0 terms, and you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
