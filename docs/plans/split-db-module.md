# Split the db module

## Context
`ebook_research_core/src/db.rs` is 1,502 lines: 781 of code covering five separate jobs (schema and connection, import and delete, search, the reader's read queries, bookmarks) and 720 of tests for all of them in one `mod tests`. The /debut public-readiness audit flagged it (CQ-2, low). This matters now because the semantic chapter search plan (`docs/plans/semantic-chapter-search.md` §4) is about to add `index_book`, `search_chapters`, `semantic_status` and their types to the same file behind a cargo feature. Splitting first gives that work a file of its own instead of feature-gated blocks threaded through the existing code.

**No behaviour change.** No SQL, signature, error message or type changes, and no new dependencies. Every public path stays exactly where it is: `db::search`, `ebook_research_core::SearchResult` and so on, so `src-tauri/src/commands.rs`, `tests/integration.rs` and `lib.rs`'s re-export list compile unmodified. That is the main check the refactor is right.

Out of scope: splitting `epub.rs` (643 lines, one job), renaming anything, changing what `lib.rs` re-exports, tidying code while moving it, and the semantic work itself.

Alternatives ruled out:
- **Public submodules** (`db::search::search`). This changes every call site in `commands.rs` and the integration tests for no user benefit, and makes the file layout part of the API. The submodules stay private and `db` re-exports their items.
- **A `db_*.rs` sibling per area at the crate root** (`db_search.rs` …). This keeps paths flat but loses the single `db` namespace and puts `migrations()` a crate away from the tables it creates.
- **Leaving the tests in one `db/tests.rs`.** That moves 720 lines into a new file without making it easier to find the tests for a given function. Each test moves next to the code it tests, as `epub.rs` already does.

## 1. The move: `git mv src/db.rs src/db/mod.rs`
Commit this first, on its own, so `git log --follow` and blame see a rename. The only content change is the four `include_str!` paths, which are relative to the source file and so gain a `../`: the three migrations (`"../../migrations/00N_….sql"`) and `term_variants.txt`. Without that the rename doesn't compile. Every later commit is then a diff inside `db/`.

## 2. `db/mod.rs`: schema, connection and re-exports
Keeps `migrations()`, `open_db` and `baseline_unversioned_db` (lines 10–41 today) plus the `migrations_are_valid` test. It declares `mod import; mod library; mod search; mod bookmarks;` (all private) and `#[cfg(test)] mod test_util; #[cfg(test)] mod ui_fixtures;`. It then re-exports every item that is `pub` today, by name:

```rust
pub use bookmarks::{add_bookmark, create_bookmark_folder, delete_bookmark_folder,
    get_chapter_bookmarks, list_bookmark_folders, list_folder_bookmarks, remove_bookmark,
    rename_bookmark_folder, BlockBookmark, BookmarkFolder, FolderBookmark};
pub use import::{delete_book, import_book, ImportOutcome};
pub use library::{get_book_chapters, get_chapter_content, list_books, BookSummary,
    ChapterContent, ChapterSummary, ContentBlockRow};
pub use search::{search, search_with_variants, SearchMode, SearchResult, VariantIndex};
```

These are named rather than globbed so a new `pub fn` in a submodule doesn't become public API by accident. `migrations()` stays private, and the submodules' tests reach it as `super::super::migrations()`, since a child module can see its parent's private items.

## 3. `db/import.rs`: import and delete
`file_hash`, `ImportOutcome`, `import_book`, `load_book` and `delete_book` (lines 43–156). `load_book` becomes `pub(super)`: tests in `bookmarks.rs`, `search.rs` and `ui_fixtures.rs` all build books through it, skipping the EPUB parser. Tests: `delete_book_leaves_other_books_alone` and `delete_unknown_book_is_an_error`.

## 4. `db/search.rs`: search
`SearchResult`, `SearchMode` and its `fts_table`, `fold_term`, `VariantIndex` (with `bundled()`'s `OnceLock` and its `include_str!`, already fixed in §1), `Part`, `to_fts_query`, `query_has_closing_quote`, `search` and `search_with_variants` (lines 157–468). At about 310 lines this is the largest submodule. It stays one file because query building and query running share `Part` and `VariantIndex`, and splitting them again would make both halves `pub(super)`. Tests: the `fts`/`fts_v` helpers and every `fts_query_*`, `fold_term_folds_iast`, `variant_index_parses_and_rejects_duplicates`, `bundled_variants_parse`, `expanded_queries_are_valid_fts5` and `search_finds_the_other_spelling`.

## 5. `db/library.rs`: the reader's read queries
`BookSummary`, `list_books`, `ChapterSummary`, `get_book_chapters`, `ContentBlockRow`, `ChapterContent` and `get_chapter_content` (lines 469–562). There are no unit tests to move; these queries are covered by `tests/integration.rs` and the UI fixture tests.

## 6. `db/bookmarks.rs`: folders and bookmarks
The three bookmark structs, `check_folder_name`, `ensure_folder_exists` and the nine folder/bookmark functions (lines 563–781). Tests: `bookmark_folder_names`, `bookmark_folders_list_newest_first`, `bookmarks_in_several_folders`, `deleting_folder_or_book_removes_bookmarks`, and both `migration_003_*` tests. Those two exercise migration 003, but what they check is that old bookmarks end up in a folder, so they live with the folder code and call `super::super::migrations()`.

## 7. Test-only modules: `db/test_util.rs`, `db/ui_fixtures.rs`
- `test_util.rs` holds the helpers several test modules share: `one_chapter_book`, `block_ids` and `err_of`, as `pub(super)`.
- `ui_fixtures.rs` holds `long_book`, `library_fixtures`, `check_fixture`, `ui_fixtures_are_current` and `ui_fixtures_for_demo_are_current` (lines 1258–1502). These call into every area, so they don't belong to any one of them. Their paths (`src/test/fixtures/library.json`, `src/demo/library.json` and the demo EPUB at line 1346) are built from `env!("CARGO_MANIFEST_DIR")` in `check_fixture`, not from the source file's location, so the move doesn't change them. A grep for `include_str!`, `include_bytes!` and `CARGO_MANIFEST_DIR` finds no other file-relative paths in `db.rs`.
- The regenerate command in CLAUDE.md, `UPDATE_UI_FIXTURES=1 cargo test -p ebook_research_core ui_fixtures`, filters by name and still matches `db::ui_fixtures::ui_fixtures_are_current`.

## 8. Where the semantic plan's code goes
Add a `db/semantic_index.rs` for `index_book`, `search_chapters`, `semantic_status`, `ChapterMatch`, `SemanticStatus` and `MIN_SCORE`, re-exported from `db/mod.rs` like the rest. It isn't named `semantic.rs` because that would clash in conversation (not in the compiler) with the crate-root `semantic.rs`, which holds the `Embedder`. Once this split merges, the semantic plan's §4 heading and its test references to `db.rs` get updated in a separate "Update semantic plan for the db split" commit. Migration 004 is still listed in `migrations()` in `db/mod.rs`.

## 9. Docs and project instructions: `CLAUDE.md`, `.claude/skills/`, `README.md`, `CONTRIBUTING.md`
- CLAUDE.md: "New commands: core fn in `db.rs`" becomes "core fn in the matching `db/` submodule, re-exported from `db/mod.rs` and `lib.rs`". "listed in `migrations()` in `db.rs`" becomes `db/mod.rs`, and "real `db.rs` output" becomes "real `db` output".
- `.claude/skills/plan/SKILL.md` line 28 and `.claude/skills/ship/SKILL.md` line 19: `db.rs` becomes `db/`.
- README "Project structure": `src/{lib,epub,db}.rs` becomes `src/{lib,epub}.rs` plus a `src/db/` line listing the submodules. The "What's actually verified" bullet for `db.rs` names `db/` and says which file covers which job. The fixture note (around line 244) and the schema-migrations note (around line 344) follow the same rename.
- CONTRIBUTING.md doesn't name `db.rs`, so it needs no change.

## 10. Tests
There are no new tests. The refactor is right if:
1. `commands.rs`, `tests/integration.rs` and `lib.rs` have zero diff, and `cargo build --workspace` succeeds.
2. The unit test names are unchanged apart from the module path. Compare `cargo test -p ebook_research_core --lib -- --list` before and after with the `db::…::` prefix stripped: the same 24 `db` tests (37 unit tests in total) and the same 6 integration tests.
3. `ui_fixtures_are_current` and `ui_fixtures_for_demo_are_current` pass without `UPDATE_UI_FIXTURES`, which proves the committed JSON is byte-identical.
4. The functions haven't changed. `git diff -M --color-moved=dimmed-zebra main` should show almost every line as moved, and the only new lines should be the `mod`/`use` declarations, the `pub(super)` changes and the four `include_str!` paths.
5. clippy `-D warnings`, fmt, tsc and `npm test` all pass. There's no frontend change, so `npm test` passing just confirms the fixtures are the same.
