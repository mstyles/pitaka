# Windows support: build and test

## Context
Pitaka has only been built and run on Linux. The README's Install section says Tauri targets Windows too but that build is untested, and CI runs only on `ubuntu-24.04`. So nobody knows whether the app builds on Windows, and nothing would catch a change that breaks it.

This is step one of Windows support. When it's done, the workspace builds and the core tests pass on Windows in CI. The README will also say how to build from source on Windows, and the app will have been checked by hand on a real Windows machine. Out of scope for now, as later steps: prebuilt installers, a release workflow and code signing (the "Release builds for Linux, macOS and Windows" roadmap item). `npm run tauri build` will still produce MSI/NSIS bundles locally; we just don't publish them.

Most of the code is already portable:
- Paths inside an EPUB are zip entry names, and zip entry names always use `/`. `resolve_href` in `epub.rs` joins and splits them as strings, which is correct on every OS.
- `library_path` in `commands.rs` uses Tauri's `app_data_dir()`, which on Windows is `%APPDATA%\com.pitaka.app\`.
- `hf-hub` caches the model under the home directory's `.cache\huggingface`, i.e. `%USERPROFILE%\.cache\huggingface` on Windows.
- Windows 10 and 11 ship with WebView2, so unlike Linux there are no system webview libraries to install.
- The CSP's `connect-src ipc: http://ipc.localhost` already covers Windows, where Tauri's IPC falls back to `http://ipc.localhost`. The page itself is served from `http://tauri.localhost`, and `'self'` covers that.
- The frontend already renders in Chromium, which is what WebView2 is: the UI is checked in Chrome through `dev:mock`.

Rejected alternatives:
- Running the whole CI matrix on Windows. `cargo fmt`, the frontend job (tsc, Vitest, Vite build) and `build:site` give the same answer on every OS, and Windows runners are slower.
- Making `build:site` cross-platform with a Node script or a new dependency (`rimraf`/`shx`). The site is built by the Pages workflow on Linux, so the README just says it needs a Unix shell (Git Bash or WSL on Windows).

## 1. Line endings: `.gitattributes` (new)
- Git for Windows defaults to `core.autocrlf=true`, which checks text files out with CRLF line endings. `check_fixture` in `db/ui_fixtures.rs` compares the committed JSON byte for byte with LF output from `serde_json`, so `ui_fixtures_are_current` and `ui_fixtures_for_demo_are_current` would fail on a Windows checkout.
- Add `.gitattributes` with `* text=auto eol=lf`. That checks text out with LF everywhere. It also covers the `include_str!` files (migrations, `data/term_variants.txt`, `tests/semantic_eval/demo.json`), so none of them depend on how a checkout was configured.
- List binaries explicitly so `auto` never mistakes one for text: `*.epub`, `*.woff2`, `*.png`, `*.jpg`, `*.ico`, `*.icns` as `binary`.
- Checked that the repo has no CRLF files today (`git ls-files | xargs file | grep CRLF` is empty), so adding the attributes shouldn't make any existing file show as changed. `git add --renormalize .` after adding it should show no changes.
- I'm keeping `check_fixture` a byte comparison, not one that ignores line endings. The attributes fix the cause, and a fixture regenerated on Windows (`UPDATE_UI_FIXTURES=1`) writes LF anyway.

## 2. Tests: `tests/integration.rs`
- Eight hardcoded `/tmp/...` paths: `test_library.db`, `test_dedup_library.db`, `test_dedup_copy.epub`, `test_dedup_changed.epub`, `test_delete_library.db`, `test_unversioned_library.db`, `test_bookmarks_library.db` and `test_library_variants.db`. `/tmp` doesn't exist on Windows.
- Add a helper `fn temp_path(name: &str) -> String` that returns `std::env::temp_dir().join(name)` as a `String`. The existing `open_db(&str)` and `import_book(&mut Connection, &str)` signatures stay as they are. Each test calls it once per path, so the file names don't change.
- The `epub.rs` unit tests already use `std::env::temp_dir()` in `write_epub`, so this follows the crate's own pattern.
- Windows can't delete a file that's still open. The tests only `remove_file` before `open_db`, and ignore any error, so no test deletes an open database. Nothing to change there, but CI is what confirms it.

## 3. Core: `epub.rs`
- In `parse_epub`, `opf_dir` comes from `std::path::Path::new(&opf_path).parent()`. That's an OS path API applied to a zip entry name. It works on Windows only because `Path` there accepts `/` as a separator too.
- Replace it with `opf_path.rsplit_once('/').map_or("", |(dir, _)| dir)`, the same expression `toc_titles` uses for `toc_dir`. `opf_dir` becomes a `&str` borrowed from `opf_path`; `resolve_href` already takes `&str`.
- No behaviour change on Linux. The `test.epub` integration test and the `write_epub`-based unit tests cover it, since both have the OPF inside a folder (`OEBPS/`).

## 4. CI: `.github/workflows/ci.yml`
- A new job, `rust-windows`, on `windows-2025`: a pinned image rather than `windows-latest`, matching `ubuntu-24.04`. It uses the same pinned `actions/checkout`, `dtolnay/rust-toolchain` (stable, with clippy) and `Swatinem/rust-cache` SHAs as the `rust` job.
- Steps:
  1. `cargo clippy --workspace --all-targets -- -D warnings`
  2. `cargo test -p ebook_research_core`
  3. `cargo build --workspace --features pitaka/semantic`: a debug build that links the app with candle and `tokenizers`' `onig` (a C library built with MSVC). This is the main unknown. Clippy type-checks but doesn't link, so only a build finds link errors.
- No system library step: the runner image has the MSVC build tools and the WebView2 SDK is fetched by the `webview2-com` crate.
- A debug `cargo build` doesn't need `dist/`, which is the same reason clippy on Linux works without `npm run build`. A release `tauri build` with the workspace's LTO settings would take far longer; it's run by hand in section 6 instead.
- If step 3 fails on onig or candle, fixing it is part of this work, and the plan gets a note on what was changed. If there's no reasonable fix, the fallback is to leave the feature off on Windows and document that in the README, and I'll check with you before doing that.

## 5. README
- **Install**: replace "has only been run on Linux so far; Tauri also targets macOS and Windows, but those builds are untested" with Linux and Windows as tested (macOS untested). Under step 1, add Windows prerequisites: Rust's default MSVC toolchain, Visual Studio Build Tools with "Desktop development with C++", and Node.js; WebView2 comes with Windows 10 and 11. Keep the link to Tauri's prerequisites for other systems.
- The semantic paragraph and the library-location sentence add the Windows paths: `%USERPROFILE%\.cache\huggingface` and `%APPDATA%\com.pitaka.app\`.
- **Setup steps**: step 1 becomes "Install the Tauri prerequisites for your OS (see Install)". Note that `npm run build:site` needs a Unix shell (Git Bash or WSL on Windows).
- **What's actually verified**: say that CI builds the workspace (including the semantic feature) and runs clippy and the core tests on Windows, and record the manual Windows walk from section 6: what was checked and what wasn't.
- **Roadmap**: add under Done "Build and test on Windows: CI runs clippy, the core tests and a semantic build on Windows". Leave "Release builds for Linux, macOS and Windows" in Later.
- **CONTRIBUTING.md**: check it for Linux-only setup instructions and point them at the README's Install section.

## 6. Tests and verification
- No new test cases. The existing core suite running on Windows is the test: the integration tests from section 2, the fixture tests from section 1 and the `epub.rs` parsing tests from section 3.
- On Linux: `cargo test -p ebook_research_core`, `cargo clippy --workspace --all-targets`, `npx tsc --noEmit`, `npm test`. `git add --renormalize .` shows no changes after adding `.gitattributes`.
- CI: both the `rust` and `rust-windows` jobs pass on the PR.
- By hand on your Windows machine, from a fresh clone (so `.gitattributes` applies):
  1. `npm install`, then `cargo test -p ebook_research_core`.
  2. `npm run tauri dev -- --features semantic`. The window opens (not blank) and the bundled fonts render.
  3. Import an EPUB through the native file picker, from a path with a space in it. The import status shows the `C:\...` path, and the book appears under Books.
  4. Import the same file again: it shows "Already in library".
  5. Search, stemmed and with *Exact words*. Open a result and check the reader jumps to the paragraph.
  6. Bookmark a passage into a new folder, and open it from Bookmarks.
  7. Chapter search: the model downloads into `%USERPROFILE%\.cache\huggingface`, the book is indexed and a query returns chapters.
  8. Remove the book, and confirm that `library.db` is in `%APPDATA%\com.pitaka.app\`.
  9. `npm run tauri build`: it finishes, and the MSI or NSIS installer installs and launches. It is not published.
