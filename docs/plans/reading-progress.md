# Remember where you were, show reading progress, continue from Home

## Context
Every book opens at its first chapter (README: "Clicking a book opens it at the first chapter"). So a reader halfway through a 93-chapter book has to find their place in the sidebar each time, and nothing shows how far through a book they are. Home's "Your library" lists the three most recently *imported* books, which isn't what you want to get back to. This adds three linked things:
- **Saved position.** Each book remembers the paragraph at the top of the reader, and opening the book from the Books screen, Home or Continue reading returns there.
- **Progress in the reader.** A thin bar along the top of the text, and "Chapter 2 of 3 · 52%" under the book's author in the sidebar. Once the end of the book is on screen, it reads "Finished" and the bar is full.
- **Continue reading on Home.** Up to three unfinished books, most recently read first, each with its chapter and percent, above "Your library".

It isn't a README roadmap item yet. §8 adds and ticks one.

The percent is the share of the book's text that comes before the paragraph at the top of the screen: characters, summed over every paragraph in earlier chapters and earlier in this chapter, divided by the book's total. Counting chapters is misleading: the real library's books run from 26 to 123 chapters of very different lengths. Paragraph counts are skewed by headings and verse lines. Characters are the closest measure to reading time. On the real library, the middle paragraph by count of the three largest books came out at 57%, 52% and 44% by characters. Because only the text *before* the top paragraph counts, the last screen of a book would show a little under 100%. So reaching the end is detected separately (§4): when the last paragraph of the book's last non-empty chapter is on screen, the reader shows "Finished", and the position is saved with `finished` set, which takes the book out of Continue reading.

Out of scope:
- Marking a book finished by hand, resetting a book's progress, or a reading history. Only the latest position is kept, and `finished` only says whether that position was at the end.
- A position inside a paragraph. The reader returns to the top of the saved paragraph. A long paragraph can scroll back by up to one screen.
- Progress on the Books screen's rows. `list_reading_positions` could feed it later.
- Reader settings such as text size and column width, which another plan covers. A position is a paragraph, not a pixel offset, so it survives any change of text size or window width.
- Writing `books.last_opened_at`. It has been in 001 since the start and nothing reads or writes it. It stays unused, since dropping it would mean rebuilding `books`.

Ruled out:
- Columns on `books` (`last_block_id` plus `last_opened_at`). `books` and `content_blocks` would then reference each other, `list_books` would carry reader state, and the upsert would be an `UPDATE` that has to check that the block belongs to the book. A table keyed by `book_id` keeps this separate and cascades on its own.
- A scroll offset in pixels. It changes with window width and text size. The schema's own rule (001's header) is that locations are paragraphs.
- `localStorage`. It's kept outside `library.db`, so a backup wouldn't include it, a restore would leave it pointing at paragraph ids that now belong to other books, and the Rust side couldn't list it for Home.
- Saving on every scroll event. That would be a write per frame. Saving happens 1 s after scrolling stops, when the chapter changes and when you leave the reader, and only when the top paragraph has changed.

Checked with Python's SQLite 3.46.1 (the bundled `libsqlite3-sys` 0.38 ships a newer one) against migrations 001–006 plus the table in §1:
- The upsert in §1 is `INSERT … SELECT … WHERE id = ?1 ON CONFLICT (book_id) DO UPDATE`. SQLite parses the `SELECT … ON CONFLICT` form only when the `SELECT` has a `WHERE`, and this one does.
  - It inserts one row, and a second call for another paragraph of the same book updates that row (still 1 row).
  - An unknown paragraph id affects 0 rows, which is how the core detects it.
  - With the `finished` column: saving the last paragraph with `finished` 1 leaves `WHERE NOT finished` empty, and saving an earlier paragraph with 0 lists the book again, still as one row.
- With `foreign_keys = ON`, as `open_db` sets it, `DELETE FROM books WHERE id = ?` (that is, `delete_book`) removes the book's position row. Other books' rows stay, and `PRAGMA foreign_key_check` is empty.
- The progress query in §1 gives the expected numbers. In a test book with chapters of 4+4, 8+2 and 0 characters, the second chapter's second paragraph has 16 characters before it out of 18. `LENGTH()` counts `ā` as one character, the same as a JavaScript code-point count.
- On a read-only copy of the real library (54 books, 53,675 paragraphs, `user_version` 6), `EXPLAIN QUERY PLAN` shows every subquery going through `sqlite_autoindex_chapters_1` and `idx_content_blocks_chapter`, with no table scans. Listing three positions took 5.3 ms. `get_book_chapters` with the per-chapter character count from §1 took 1.8 ms on a 93-chapter book. The real file wasn't written to.

## 1. Core: new `ebook_research_core/migrations/007_reading_positions.sql`, new `db/reading.rs`, `db/library.rs`, `db/mod.rs`, `lib.rs`
- Migration 007, listed last in `MIGRATIONS` in `db/mod.rs`:
  ```sql
  -- One row per book that has been opened: the paragraph at the top of the
  -- reader when it was last left, so the book reopens there.
  CREATE TABLE reading_positions (
      book_id          INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
      content_block_id INTEGER NOT NULL REFERENCES content_blocks(id) ON DELETE CASCADE,
      finished         INTEGER NOT NULL DEFAULT 0,
      read_at          TEXT NOT NULL
  );
  ```
  If the book-covers plan's migration has landed first, this is 008 instead, and the file name and version assertions move with it. There's nothing to backfill, because no position was recorded before this. `schema_version()` becomes 7 automatically, since it counts `MIGRATIONS`.
- `read_at` is `strftime('%Y-%m-%d %H:%M:%f', 'now')`, which has milliseconds, so two books opened within the same second still sort. Ties are broken by `book_id DESC`.
- New `db/reading.rs` ("Where each book was left, and how far through it that is"):
  - `#[derive(Serialize, Debug, PartialEq)] pub struct ReadingPosition { book_id: i64, chapter_id: i64, content_block_id: i64, chapter_title: Option<String>, chapter_number: i64, chapter_count: i64, percent: i64, finished: bool, read_at: String }`. `chapter_number` is 1-based, by order in `chapters` (`COUNT(*) … idx <= ch.idx`), matching the sidebar's order.
  - `pub fn set_reading_position(conn: &Connection, content_block_id: i64, finished: bool) -> Result<()>` runs the upsert. Saving anywhere other than the end clears `finished`, so rereading a finished book puts it back in Continue reading:
    ```sql
    INSERT INTO reading_positions (book_id, content_block_id, finished, read_at)
    SELECT book_id, id, ?2, strftime('%Y-%m-%d %H:%M:%f', 'now') FROM content_blocks WHERE id = ?1
    ON CONFLICT (book_id) DO UPDATE
      SET content_block_id = excluded.content_block_id, finished = excluded.finished,
          read_at = excluded.read_at
    ```
    If 0 rows change, it does `bail!("no paragraph with id {content_block_id}")`, the wording the mock already uses.
  - `pub fn get_reading_position(conn, book_id: i64) -> Result<Option<ReadingPosition>>` and `pub fn list_reading_positions(conn, limit: i64) -> Result<Vec<ReadingPosition>>` share one `const POSITION_SQL`. The first adds `WHERE rp.book_id = ?`; the second, which feeds Continue reading, adds `WHERE NOT rp.finished ORDER BY rp.read_at DESC, rp.book_id DESC LIMIT ?`:
    ```sql
    SELECT rp.book_id, ch.id, rp.content_block_id, ch.title,
      (SELECT COUNT(*) FROM chapters c2 WHERE c2.book_id = rp.book_id AND c2.idx <= ch.idx),
      (SELECT COUNT(*) FROM chapters c2 WHERE c2.book_id = rp.book_id),
      (SELECT COALESCE(SUM(LENGTH(o.text)), 0) FROM chapters oc
         JOIN content_blocks o ON o.chapter_id = oc.id
         WHERE oc.book_id = rp.book_id
           AND (oc.idx < ch.idx OR (oc.idx = ch.idx AND o.block_idx < cb.block_idx))),
      (SELECT COALESCE(SUM(LENGTH(t.text)), 0) FROM chapters tc
         JOIN content_blocks t ON t.chapter_id = tc.id WHERE tc.book_id = rp.book_id),
      rp.finished, rp.read_at
    FROM reading_positions rp
    JOIN content_blocks cb ON cb.id = rp.content_block_id
    JOIN chapters ch ON ch.id = cb.chapter_id
    ```
  - A finished position reports `percent` 100. Otherwise percent is `fn percent(before: i64, total: i64) -> i64`: 0 when `total` is 0, otherwise `(before * 200 + total) / (2 * total)`. That is round-half-up, the same as `Math.round` in §4.
- `db/library.rs`:
  - `ChapterSummary` gains `pub char_count: i64`, the characters in the chapter's paragraphs. The reader needs it to work the percent out live without a round trip.
  - `get_book_chapters` becomes `SELECT ch.id, ch.idx, ch.title, COALESCE(SUM(LENGTH(cb.text)), 0) FROM chapters ch LEFT JOIN content_blocks cb ON cb.chapter_id = ch.id WHERE ch.book_id = ?1 GROUP BY ch.id ORDER BY ch.idx`.
- Re-export `get_reading_position`, `set_reading_position`, `list_reading_positions` and `ReadingPosition` from `db/mod.rs` (`mod reading;` plus `pub use reading::{…}`) and from `lib.rs`.
- `delete_book` needs no change, because the row cascades. Neither does `import_book`: re-importing the same file returns the existing book, so its paragraphs and position stay.
- Backup and restore copy the whole database, so positions go with a backup and come back on restore. Restoring a schema-6 backup migrates it to 7 with no positions. A schema-7 backup is refused by a schema-6 Pitaka with the existing "newer version" message.
  - `backup.rs`'s tests assert `schema_version` 6 and `user_version` 6. Those become `schema_version()`, so they won't need editing at the next migration.

## 2. Tauri commands: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- `get_reading_position(book_id: i64, state) -> Result<Option<ReadingPosition>, String>`. Doc: ``/// Frontend calls: `invoke("get_reading_position", { bookId: 1 })`. Null for a book never opened.``
- `set_reading_position(content_block_id: i64, finished: bool, state) -> Result<(), String>`. Doc: ``/// Frontend calls: `invoke("set_reading_position", { contentBlockId: 42, finished: false })`. The reader calls it a second after you stop scrolling, on leaving, and on closing the window.``
- `list_reading_positions(limit: i64, state) -> Result<Vec<ReadingPosition>, String>`. Doc: ``/// Frontend calls: `invoke("list_reading_positions", { limit: 3 })`. Unfinished books, most recently read first.``
- Capability: `src-tauri/capabilities/default.json` gains `core:window:allow-destroy`. The reader's close handler (§4) uses `getCurrentWindow().onCloseRequested`, and once a close handler is registered, the window is closed by the frontend calling `destroy()`, which `core:default` doesn't allow.
- Each is the usual wrapper: lock `state.conn`, call the core function, `map_err(|e| e.to_string())`. Register them in `generate_handler!` after `get_chapter_content`.

## 3. Types, fixtures, mock: `src/types.ts`, `db/ui_fixtures.rs`, `src/test/mockBackend.ts`
- `types.ts`:
  - `ChapterSummary` gains `char_count: number`;
  - `export type ReadingPosition = { book_id: number; chapter_id: number; content_block_id: number; chapter_title: string | null; chapter_number: number; chapter_count: number; percent: number; finished: boolean; read_at: string }`.
- `ui_fixtures.rs`: `ui_fixtures_are_current` sets a position on the long book's "Part Two", paragraph 10 (`blocks[9]`). It records `get_reading_position(long_id)` as `reading_position_sample`, with `read_at` pinned to `"2026-09-03 12:00:00.000"`. Then it deletes the row, so the fixture library starts with nothing read and the existing Home and reader tests are unchanged.
- Regenerate with `UPDATE_UI_FIXTURES=1 cargo test -p ebook_research_core ui_fixtures`. This rewrites both `src/test/fixtures/library.json` and `src/demo/library.json`, because `char_count` appears in every chapter list.
- `mockBackend.ts`:
  - `Fixtures` gains `reading_position_sample?: ReadingPosition`.
  - State: `let positions = new Map<number, { blockId: number; seq: number }>()`, with a counter `seq` in place of a clock, so the order is deterministic.
  - `positionOf(bookId)` works out the `ReadingPosition` from `data.chapters` and `data.chapter_content` with the §1 formula, using `blockPlace`. `read_at` is `sqliteNow()`.
  - `case "set_reading_position"`: `blockPlace(contentBlockId)` (which throws "no paragraph with id …"), then `bookOf`, then store the position and `finished` with the next `seq`.
  - `case "get_reading_position"`: `positionOf(bookId)`, or `null`.
  - `case "list_reading_positions"`: unfinished positions ordered by `seq` descending, sliced to `limit`.
  - `delete_book` drops the book's position, and `restore_library` clears all of them, as the SQL does.
- The browser demo goes through the same mock. Positions and Continue reading work in the demo until the page is closed, like its highlights. `installDemo.ts` needs no change.

## 4. Reader: `src/ReaderView.tsx`, new `src/readingPosition.ts`, `src/App.css`
- New `src/readingPosition.ts`:
  - `export const SAVE_DELAY_MS = 1000`.
  - `export function topVisibleBlockId(container: HTMLElement): number | null`:
    - returns `null` when `container.clientHeight === 0` (jsdom, or not laid out yet);
    - otherwise binary-searches `container.querySelectorAll<HTMLElement>(".reader-paragraph")`, which are in reading order, for the first one whose `getBoundingClientRect().bottom` is more than 1px below the container's top, and returns its `data-block-id`.
  - `export function atEnd(container: HTMLElement): boolean`: `container.scrollTop + container.clientHeight >= container.scrollHeight - 2`, false when `clientHeight` is 0.
  - `export function percentRead(chapters: ChapterSummary[], chapterId: number, blocks: ContentBlockRow[], blockId: number): number`: the characters in chapters before `chapterId` (`char_count`), plus `[...text].length` for the blocks before `blockId`, over the sum of all `char_count`s, through `Math.round`. 0 for an empty book.
- `ReaderView.tsx`:
  - **Resume.**
    - When `initialChapterId` is undefined (opened from the Books screen, Home or Continue reading), the chapters effect fetches `get_book_chapters` and `get_reading_position` together with `Promise.all`. A position whose `chapter_id` is in the list sets `activeChapterId` to that chapter and a new `resumeBlockId` state to its paragraph. Otherwise the reader opens at the first chapter, as now.
    - A failed `get_reading_position` also falls back to the first chapter, with no message.
    - When `initialChapterId` is given (a search hit, bookmark or note), the saved position isn't fetched, and the hit wins.
  - **Scroll on load.** The `[content]` effect keeps its current branches and adds one in the middle: if `resumeBlockId` is in this chapter, it calls `scrollIntoView({ block: "start" })` on that paragraph without flashing it, then clears `resumeBlockId`.
  - **Saving.**
    - **Only reading counts.** Opening a book, from anywhere, saves nothing by itself, so a quick look at a search hit or a note doesn't move the book to the front of Continue reading. Saving is armed by the first sign of reading in this visit: a `wheel`, `touchmove`, `pointerdown` or `keydown` on `.reader-content`, or a chapter change from the sidebar or the desktop shell's arrow keys. A `readingRef` holds it. The reader's own `scrollIntoView` calls (resume, hits) fire `scroll` events too, which is why scrolling alone doesn't arm it.
    - Once armed, `onScroll` on `.reader-content` (re)starts a `SAVE_DELAY_MS` timer, and a chapter change starts it as well.
    - When the timer fires, `topVisibleBlockId(contentRef.current)` and `finished` are compared with what was last saved. `finished` is `atEnd(contentRef.current)` while the active chapter is the last chapter whose `char_count` is above 0. If either changed and the block isn't null, the reader calls `invoke("set_reading_position", { contentBlockId, finished })` and records both.
    - Unmounting, which is how back works, clears the timer and saves at once if a save is pending.
    - **Closing the window.** A `useEffect` registers `getCurrentWindow().onCloseRequested(async () => …)`, and unregisters it on unmount. If a save is pending, the handler awaits it, raced against a 500 ms timeout so a stuck database can never stop the window closing; then the window closes as usual. It's registered only when `isTauri()` (from `@tauri-apps/api/core`) is true, so the browser demo and `dev:mock` skip it.
    - Errors are swallowed (`.catch(() => {})`). A lost position isn't worth interrupting reading, and the next save tries again.
  - **Progress.**
    - A `topBlockId` state is updated from `onScroll` through `requestAnimationFrame`, at most once a frame, and set when content loads.
    - `percentRead(...)` is worked out from it. Before layout it uses the first block, so it's 0% at the start of the first chapter.
    - The sidebar, under `.reader-book-author`, shows `<div className="reader-progress-label">Chapter {n} of {chapters.length} · {pct}%</div>`, where `n` is the active chapter's 1-based position in `chapters`. At the end of the book (the `finished` rule above, worked out on the same frame as `topBlockId`), it reads `Chapter {n} of {chapters.length} · Finished` and `pct` is 100.
    - At the top of `.reader-content` is `<div className="reader-progress" role="progressbar" aria-label="Reading progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><div className="reader-progress-fill" style={{ width: `${pct}%` }} /></div>`.
- `App.css`, using the tokens from `docs/plans/type-spacing-and-buttons.md`:
  - `.reader-progress { position: sticky; top: 0; height: 3px; margin: calc(-1 * var(--space-12)) calc(-1 * var(--space-8)) var(--space-12) calc(-1 * var(--space-12)); background: var(--border); z-index: 5 }`. The negative margins run it edge to edge over `.reader-content`'s padding.
  - `.reader-progress-fill { height: 100%; background: var(--accent); transition: width 0.2s }`.
  - `.reader-progress-label { margin-top: var(--space-1); font-size: var(--text-sm); color: var(--muted) }`.
  - No new colour tokens.
  - If the type and spacing plan hasn't landed, use today's literal values (48px, 32px, 0.9em) instead.

## 5. Home: `src/HomeView.tsx`, `src/App.css`
- Loads `invoke<ReadingPosition[]>("list_reading_positions", { limit: CONTINUE_COUNT })` (`const CONTINUE_COUNT = 3`) alongside `list_books`. A failure adds `Loading reading positions failed: ${err}` to `errors`, like the other two.
- When `books` and the positions have loaded and there's at least one position whose book is in `books`, a section comes before "Your library". `list_reading_positions` leaves finished books out, so a finished book shows in "Your library" again:
  - `<section className="home-recent" aria-labelledby="home-continue-label">`, with the `section-label` heading "Continue reading" and a `.home-recent-list`.
  - Each row is a `.home-recent-row` button. It shows the book's title as `.book-title` (from `books`) and `.book-meta` reading `{chapter_title ?? `Chapter ${chapter_number}`} · {percent}%`, plus a `.home-progress` bar (`role="progressbar"`, `aria-label={`${title} progress`}`, `aria-valuenow={percent}`).
  - Clicking calls `onOpenBook(book_id)`, which opens the reader with `backLabel: "← Home"` and no chapter, so it resumes.
- "Your library" now lists the newest `RECENT_COUNT` books *not* already under Continue reading. Its "All N books →" link still counts the whole library. With nothing read, Home is exactly as it is now.
- CSS: `.home-recent + .home-recent { margin-top: var(--space-6) }`. `.home-progress` is a 3px bar like `.reader-progress`, at the bottom of the row: `position: absolute; left: 0; right: 0; bottom: 0`, with the row given `position: relative`.

## 6. App: `src/App.tsx`
- No change. Books and Home already open the reader with only `bookId`, which is the resume case, and the others pass `chapterId`. Home remounts on every visit, so its list is always current.

## 7. Tests
- Core, `db/reading.rs` `#[cfg(test)]`, with a new `test_util::book_with_chapters(title, &[&[&str]])` that builds a `ParsedBook` with one `ParsedChapter` per slice, titled "Chapter 1", "Chapter 2" and so on, as `one_chapter_book` titles its one:
  - `set_then_get_reading_position`:
    - Use a book with chapters `["aaaa", "bbbb"]`, `["cccccccc", "dd"]` and `[]`, and set the position to the second chapter's second paragraph.
    - `get_reading_position` returns that `chapter_id` and `content_block_id`, with `chapter_title` `Some("Chapter 2")`, `chapter_number` 2, `chapter_count` 3 and `percent` 89 (16 of 18). `read_at` matches `YYYY-MM-DD HH:MM:SS.sss`.
  - `setting_again_replaces_the_position`: two calls leave one row (`SELECT COUNT(*) FROM reading_positions` is 1), and the second paragraph is the one returned.
  - `finished_positions_leave_continue_reading`: setting the last paragraph with `finished: true` gives `finished` true and `percent` 100 from `get_reading_position`, and `list_reading_positions` leaves the book out. Setting an earlier paragraph with `finished: false` lists it again.
  - `start_of_book_is_zero_percent_and_unread_is_none`: the first paragraph gives `percent` 0, and another book that was never opened gives `None`.
  - `list_reading_positions_is_most_recent_first`:
    - Set positions on three books, then pin `read_at` to `'2026-01-01 00:00:01'`, `…03` and `…02` with `UPDATE`.
    - `list_reading_positions(&conn, 2)` returns the second, then the third book.
  - `unknown_paragraph_is_an_error`: `set_reading_position(&conn, 9999)` fails with "no paragraph with id 9999", and no row is written.
  - `removing_a_book_removes_its_position`: after `delete_book`, `get_reading_position` is `None` and the other book's position is listed.
  - `percent_rounds_half_up`: `percent(1, 2)` is 50, `percent(1, 3)` is 33, `percent(2, 3)` is 67, `percent(0, 0)` is 0.
- Core, `db/library.rs`: `chapter_char_count_sums_paragraphs`. A book with chapters `["ab", "cde"]` and `[]` gives `char_count` 5 and 0, and `["ā"]` gives 1, not its 2 UTF-8 bytes.
- Core, `db/backup.rs`:
  - `backup_then_restore_round_trips` also sets a position before the backup, and asserts that `get_reading_position` after the restore equals the one before.
  - The two version assertions use `schema_version()`.
- Core, `tests/integration.rs`:
  - `upgrades_unversioned_library`'s `assert_eq!(version, 6)` becomes 7. Integration tests can't call the crate-private `schema_version()`.
  - New `reading_position_follows_the_book`:
    - Import `test.epub` and find "Chapter Two: Deeper Waters" by title. Set the position to its first paragraph.
    - `get_reading_position` has that `chapter_title`, and its `chapter_number` is the chapter's position in `get_book_chapters` plus 1.
    - Importing `test.epub` again returns `already_imported`, and the position is unchanged.
    - After `delete_book`, `list_reading_positions(&conn, 10)` is empty.
- `ui_fixtures_are_current` passes after regenerating.
- `src/readingPosition.test.ts`:
  - `topVisibleBlockId` returns `null` for a container with `clientHeight` 0. With stubbed `getBoundingClientRect`s on five paragraphs and the container's top at 100, it returns the first paragraph whose bottom is past 101, including when that's the last one.
  - `percentRead` on the fixture's long book, at `reading_position_sample`'s block, equals `reading_position_sample.percent`. This pins the frontend formula to the core's.
- `src/ReaderView.test.tsx`, with `renderApp({ fakeTimers: true })` and a helper `scrollTo(blockId)` that stubs `.reader-content`'s `clientHeight` and the paragraphs' rects so that `blockId` is at the top, then fires `wheel` and `scroll`:
  - `remembers where you were and reopens there`:
    - Open "A Long Book for Scrolling", choose Part Two, `scrollTo` paragraph 10's id, and advance `SAVE_DELAY_MS`. `callsTo("set_reading_position")` ends with `{ contentBlockId }`.
    - Go back to Books and open the book again. The Part Two button has class `active`, and `scrollIntoView` was last called on `#block-<id>` with `{ block: "start" }`.
    - Nothing has class `flash`.
  - `opening without reading saves nothing`: open the long book from Books, then from a "quincunx" hit, and go back each time without a `wheel` or key. `set_reading_position` is never called, even though the hit's `scrollIntoView` fired `scroll`.
  - `saves once per paragraph`: two `scroll`s on the same top paragraph, each followed by the delay, make one `set_reading_position` call.
  - `saves straight away when leaving`: `scrollTo`, then click back before the delay, makes exactly one call with that block.
  - `saves when the window closes`: with `@tauri-apps/api/core`'s `isTauri` mocked true and `@tauri-apps/api/window` mocked so `onCloseRequested` hands its handler to the test, `scrollTo` and then call the handler before the delay. It resolves after one `set_reading_position` call with that block. With `gates: { set_reading_position: never }`, it still resolves after 500 ms.
  - `the end of the book reads Finished`: in the long book's last chapter, stub `scrollTop + clientHeight` to reach `scrollHeight` and fire `wheel` and `scroll`. The label reads "Chapter 3 of 3 · Finished", the bar's `aria-valuenow` is "100", and after the delay the call has `finished: true`.
  - `a search hit wins over the saved position`: with a position saved in Part Two, opening a "quincunx" hit makes no `get_reading_position` call and shows the hit's chapter.
  - `shows progress`:
    - On opening the long book, the sidebar reads "Chapter 1 of 3 · 0%" and the progress bar has `aria-valuenow` "0".
    - After `scrollTo(reading_position_sample.content_block_id)` in Part Two, it reads `Chapter 2 of 3 · ${sample.percent}%`.
  - `a failed save doesn't interrupt reading`: with `fail: { set_reading_position: "database is locked" }`, `scrollTo` and advance. No `.reader-error` appears, and the chapter text is still shown.
- `src/Home.test.tsx`:
  - `continues reading where you left off`:
    - Open the long book from Home, choose Part Two, `scrollTo` the sample block, advance, and go back.
    - A "Continue reading" section lists "A Long Book for Scrolling" with "Part Two · {sample.percent}%" and a progress bar named "A Long Book for Scrolling progress".
    - "Your library" no longer lists that book.
    - Clicking the row opens the reader at Part Two.
  - The existing "lists the most recent books" test also asserts there's no "Continue reading" heading.
  - `a finished book isn't in Continue reading`: read the long book to its end (as above), go back: no "Continue reading" section, and "Your library" lists the book.
  - `removing a book drops it from Continue reading`: after reading it, remove it on the Books screen, and Home shows no "Continue reading" section.
- `src/Backup.test.tsx`: after a restore, Home shows no "Continue reading" section, because the restored fixture library has no positions.
- `src/Demo.test.tsx`: unchanged; run it to confirm `char_count` in the regenerated demo data.

## 8. README
- Feature list: a clause on the reader bullet: "reopens each book where you left it, with how far through it you are".
- "How it's built": a `db/reading.rs` entry. It covers the position as a paragraph, the upsert, the percent being characters before the top paragraph, and saving a second after scrolling stops.
- "What's actually verified":
  - The `ReaderView.tsx` entry changes. "Clicking a book opens it at the first chapter" becomes "opens it at the paragraph that was at the top when it was last left (the first chapter for a book never opened); search hits, bookmarks and notes still open at their paragraph". Add the progress bar and label, covered by the tests above.
  - Home's entry gains Continue reading.
  - Add the Python checks and the 5.3 ms figure from Context.
- Schema migrations: "007 adds `reading_positions`, one row per opened book, cascading with the book and its paragraph; nothing to backfill."
- Known limitations:
  - Limitation 5 (removing a book loses its bookmarks, highlights and notes) also loses "where you were reading".
  - A new one: the position is a paragraph, so the reader reopens at the top of a long paragraph rather than mid-way. A book only counts as being read once you scroll or change chapter in it.
- Roadmap: add and tick "Reopen each book where you left it, with reading progress and Continue reading on Home".
- No change to `site/` until the release that ships it, per the site-copy rule.

## Verification
1. `cargo test -p ebook_research_core`, `cargo clippy --workspace --all-targets`, `npx tsc --noEmit`, `npm test`, `npm run format:check`.
2. `npm run dev:mock`:
   - Read into Part Two, go back, and reopen from Books and from Home's Continue reading.
   - Check that the bar and label move smoothly while scrolling.
   - Resize the window and reopen; it should still be the same paragraph.
   - Check the long book's last screen.
3. `npm run dev:demo`: read into the Therīgāthā, and check Home's Continue reading and the percent on the Pali text.
4. `npm run tauri dev` on the real library:
   - Migration 007 applies (`user_version` 7).
   - Reopen the 93-chapter book mid-way, and check that scrolling stays smooth with the per-frame progress update.
   - Close the window with a save pending (within a second of scrolling), reopen: the book opens at the last paragraph. Also with File → Quit, which the desktop shell routes through the same close.
   - Read a book to its end: "Finished", and it leaves Continue reading.
   - Back up and restore, and the positions come back.
