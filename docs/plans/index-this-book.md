# Index this book

## Context
Semantic chapter search only covers books imported while the `semantic` feature was built in (README limitation 8). Books already in the library can only be indexed by removing and re-importing them, which deletes their bookmarks, highlights and notes (limitation 5). That's a steep price for a search feature. This is the roadmap item "An 'Index this book' action".

This change adds:
- an **Index** button on each book row that isn't fully indexed;
- **Index all books**, which queues every book that isn't fully indexed;
- **Stop indexing**, which ends a run and stops new imports from being queued until you ask for indexing again.

Two problems in the current indexing get in the way, so this change fixes them as well:
- **Partial runs count as finished.** `semantic_status` counts a book as indexed once it has any `chunk_embeddings` row, so a run cut short by quitting the app looks finished, and "Index all" would skip that book. A book whose chapters are all front matter never gets a row, so it never counts as indexed at all. A per-book marker, written when a run completes, fixes both.
- **One thread per book.** Each import spawns a thread that waits on `AppState::indexing`, so books are indexed in no particular order and nothing can stop them. "Index all" on a 40-book library would park 40 threads. One worker reading a first-in, first-out queue fixes the order and makes Stop possible.

Out of scope:
- re-indexing a fully indexed book (the button only appears while there's work left);
- paragraph-level search;
- indexing in the browser demo, which has no model.

Alternatives ruled out:
- **Counting a book as indexed when every chapter has rows.** Chapters that `is_indexable` turns away never get rows, so they'd be counted as "not done" forever. Telling them apart would mean re-running the filter on every status call.
- **Re-embedding every chapter on each run.** Resuming a 200-chapter book would start it again from the beginning. Chapters that already have rows from a compatible model are skipped instead.

## 1. Schema: `migrations/006_book_embeddings.sql`, `db/mod.rs`
```sql
CREATE TABLE book_embeddings (
    book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    model       TEXT    NOT NULL,
    indexed_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (book_id, model)
);
INSERT INTO book_embeddings (book_id, model)
SELECT DISTINCT book_id, model FROM chunk_embeddings;
```
- A row means "an indexing run with `model` finished this book". The header comment says so, and says the backfill can't tell a partial run from a finished one. Books indexed before 006 count as done, which matches how they count today.
- Add `M::up(include_str!("../../migrations/006_book_embeddings.sql"))` to `migrations()`.
- Checked in `sqlite3` against migrations 001–005, with two books with rows from models `m1` and `old`:
  - the backfill gave `(1, m1)` and `(2, old)`;
  - `DELETE FROM books WHERE id = 1` cascaded to its marker and its chunks;
  - inserting a chunk for the removed book then failed with `FOREIGN KEY constraint failed`. That's the error a run hits if its book is removed partway through (section 3).

## 2. Core indexing: `db/semantic_index.rs`
- `pub enum IndexState { None, Partial, Indexed }`, serialised in lowercase (`"none"`, `"partial"`, `"indexed"`). Only rows and markers whose `model` is in `COMPATIBLE_MODELS` count:
  - **Indexed**: the book has a marker.
  - **Partial**: no marker, but some chunk rows.
  - **None**: neither. A book whose rows are all from another model is `None`, so it gets offered for indexing. That covers part of limitation 8's "re-imported" bullet.
- `fn models_json` becomes `pub(super)` so `library.rs` can use it.
- `index_book` gets a new signature:
  `pub fn index_book(conn, book_id, embedder, progress: &mut dyn FnMut(usize, usize) -> ControlFlow<()>) -> Result<IndexReport>`.
  It changes as follows:
  - **Missing book.** Before anything else it runs `SELECT 1 FROM books WHERE id = ?1`. If the book isn't there it bails with "no book with id {book_id}".
  - **Skipping finished chapters.** It reads `SELECT DISTINCT chapter_id FROM chunk_embeddings WHERE book_id = ?1 AND model IN (SELECT value FROM json_each(?2))` once. Those chapters are skipped without embedding and counted in a new `IndexReport::already: usize`. Their progress still ticks.
  - **Stopping.** When `progress` returns `Break`, the loop ends after the chapter that just committed. It sets a new `IndexReport::stopped: bool` and writes no marker.
  - **Marker.** After the loop ends normally it calls `pub(crate) fn mark_indexed(conn, book_id, model)`, which runs `INSERT OR REPLACE INTO book_embeddings (book_id, model) VALUES (?1, ?2)` with `MODEL_ID`. `mark_indexed` isn't feature-gated, so unit tests can use it.
- `pub fn books_to_index(conn: &Connection) -> Result<Vec<i64>>` returns the ids of books that aren't `Indexed`, in `list_books` order (newest first), so progress moves down the list on screen. It isn't feature-gated, since it only reads.
- `semantic_status` counts `indexed_books` from `book_embeddings` (compatible models) instead of `COUNT(DISTINCT book_id) FROM chunk_embeddings`. `SemanticStatus` itself doesn't change.
- Re-export `books_to_index` and `IndexState` from `db/mod.rs` and `lib.rs`.

## 3. Core queue: `src/index_queue.rs` (new), `lib.rs`
This module is plain `std` with no SQL or Tauri, so the queue's rules can be unit-tested in CI. It isn't feature-gated.
- `pub struct IndexQueue { state: Mutex<QueueState>, wake: Condvar }`.
  - `QueueState` holds:
    - `waiting: VecDeque<i64>`;
    - `current: Option<i64>`;
    - `cancel: Arc<AtomicBool>`, which belongs to the current run;
    - `paused: bool`, set by Stop.
- Methods:
  - `push(&self, ids: &[i64]) -> usize`: adds the ids that aren't already waiting or current, then notifies the worker. Returns how many it added. It also clears `paused`, since it's only called when you ask for indexing.
  - `push_import(&self, book_id) -> bool`: what a new import calls. It does nothing while `paused`, and otherwise works like `push(&[book_id])`. Returns whether the book was queued.
  - `next(&self) -> (i64, Arc<AtomicBool>)`: blocks until a book is waiting, makes it current and returns a fresh cancel flag.
  - `finish(&self, book_id) -> bool`: clears `current` and returns whether the run was cancelled.
  - `stop(&self)`: empties `waiting`, sets the current run's cancel flag and sets `paused`. Without the pause, a folder import still running after Stop would queue each book it imports next, and indexing would start again with the next book. The pause is only kept in memory, so restarting the app ends it.
  - `forget(&self, book_id)`: removes the book from `waiting`, and cancels it if it's current. It's used when a book is removed.
  - `waiting_count(&self) -> usize`.
- `pub mod index_queue;` and `pub use index_queue::IndexQueue;` in `lib.rs`.

## 4. Tauri: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- `AppState` replaces `indexing: Mutex<()>` with `index_queue: Arc<IndexQueue>` (only with `semantic`).
- `register` starts one worker thread after `app.manage(state)`. It runs this loop forever:
  1. `queue.next()` hands it a book.
  2. It runs `index(&app, book_id, &cancel)`. The progress closure emits progress and returns `Break` once `cancel` is set.
  3. It calls `queue.finish(book_id)`.
  4. On `Err`, it emits `semantic_index_failed`, unless the run was cancelled. A run cancelled because its book was removed can fail with the foreign-key error from section 1, and nobody should see that.
  5. If the report says `stopped`, it emits `semantic_index_stopped`.
- `index_in_background(app, book_id)` becomes `state.index_queue.push_import(book_id)`, so imports and the new actions share one order. A folder import queues each new book as soon as it's imported, unless indexing is paused.
- **Events:**
  - `IndexProgress` gains `queued: usize`, read from `waiting_count()` when the event is sent.
  - New `semantic_index_stopped`, with payload `{ book_id, done, total }`.
  - New `semantic_index_paused`, with no payload.
- **New commands.** Each locks `conn` only to read ids, and each returns how many books it queued:
  - `queue_index(book_id: i64) -> Result<usize, String>`: pushes `[book_id]`.
  - `queue_index_all() -> Result<usize, String>`: pushes `db::books_to_index(&conn)`.
  - `stop_indexing() -> Result<(), String>`: calls `queue.stop()`. It also emits `semantic_index_paused`, so the screen can explain the pause when nothing was running.
  - `queue_index` and `queue_index_all` end the pause, through `push`.
  - Without `semantic`, all three return `Err("semantic search isn't available in this build")`, like `find_chapters`.
- `delete_book` also calls `state.index_queue.forget(book_id)` (`semantic` only), before the delete.
- Register the three commands in `generate_handler!`.

## 5. Library: `db/library.rs`
- `BookSummary` gains `index_state: IndexState`. In `list_books` it's worked out per row:
  ```sql
  CASE WHEN EXISTS (SELECT 1 FROM book_embeddings e WHERE e.book_id = b.id AND e.model IN (SELECT value FROM json_each(?1))) THEN 'indexed'
       WHEN EXISTS (SELECT 1 FROM chunk_embeddings c WHERE c.book_id = b.id AND c.model IN (SELECT value FROM json_each(?1))) THEN 'partial'
       ELSE 'none' END
  ```
  `?1` is `models_json(COMPATIBLE_MODELS)`. The column is mapped to `IndexState` in Rust.

## 6. Frontend: `types.ts`, `BooksView.tsx`, `App.tsx`, `App.css`
- **`types.ts`:**
  - add `IndexState = "none" | "partial" | "indexed"`;
  - add `BookSummary.index_state`;
  - add `SemanticIndexProgress.queued`;
  - add a new `SemanticIndexStopped`.
- **`useIndexing`:**
  - It also listens for `semantic_index_stopped`, and `Indexing` gains a `{ kind: "stopped" }` case.
  - It keeps `paused: boolean`. It's set by Stop and cleared when a `queue_index` / `queue_index_all` call resolves.
  - It keeps `queued: Set<number>`. Ids are added when a `queue_index` / `queue_index_all` call resolves, and dropped when their book reaches `done === total`, fails, or when Stop is clicked.
  - It exposes `queueIndex(bookId)`, `queueIndexAll(ids)` and `stopIndexing()`, which call the commands.
  - It lives in `App` as now, so the run carries on and stays visible across screens.
- **`BooksView`** calls `semantic_status` on mount. Nothing below shows unless `available` is true, so builds without the feature and the demo are unchanged.
  - **Book rows.** The meta line gets " · not in chapter search" (`none`) or " · partly indexed" (`partial`).
  - **Row button.** An **Index** button sits before **Remove** (with `stopPropagation`, like Remove). It reads **Queued** and is disabled while its id is queued, and **Indexing…** while it's the current book.
  - **Stop import / Stop indexing.** The folder import's existing **Stop** becomes **Stop import**, and the new one reads **Stop indexing**, because both can be on screen together and they act independently. Stopping the import doesn't stop indexing, and stopping indexing doesn't stop the import.
  - **Index all books.** This button goes in the top row after "Import folder…", shown when any book isn't `indexed` and nothing is queued. It isn't confirmed first, since Stop is always there.
  - **Status line**, replacing `indexingLine`:
    - `Indexing {title} for chapter search… 3/24 chapters`, plus ` · 4 more books queued` when `queued > 0`, and a **Stop indexing** button;
    - `Indexed {title} for chapter search` (as now);
    - `Indexing {title} for chapter search failed: {error}` (as now);
    - `Stopped indexing {title} at 3/24 chapters. New imports won't be indexed until you click Index or Index all books.`
    - `Stopped indexing. New imports won't be indexed until you click Index or Index all books.` This is shown when Stop was clicked with nothing running, or after the stopped line is dismissed while the pause is still on.
  - **Refreshing the list.** The book list refreshes when a book reaches `done === total` or stops, so its row's state changes. `SearchView` already re-reads `semantic_status` when a search re-runs.
- **`App.css`:** `.book-index` shares `.book-remove`'s styling, with a small gap between the two.

## 7. Mock backend and fixtures: `src/test/mockBackend.ts`, `fixtures/library.json`
- Regenerate the fixtures with `UPDATE_UI_FIXTURES=1 cargo test -p ebook_research_core ui_fixtures`, so every book carries `index_state: "none"`.
- New mock option `indexStates?: Record<number, IndexState>` overrides the fixture value per book.
- New mock routes:
  - `queue_index` returns 1;
  - `queue_index_all` returns the number of books that aren't `indexed`;
  - `stop_indexing` returns nothing.
  - All three are recorded in `calls`.
- `indexingEvents.stopped(payload)` sends `semantic_index_stopped`, and `indexingEvents.paused()` sends `semantic_index_paused`.

## 8. Tests
- **Unit, `index_queue.rs`:**
  - `push` skips ids that are already waiting or current, and returns the number added;
  - `next` hands books out in push order;
  - `stop` empties the queue and sets the current book's cancel flag, so `finish` returns `true`;
  - `forget` drops a waiting id, and cancels the current one;
  - after `stop`, `push_import` returns `false` and queues nothing, and a later `push` queues its ids and ends the pause, so `push_import` queues again;
  - `next` blocks until a `push` from another thread (a 2-thread test with a timeout).
- **Unit, `semantic_index.rs`:**
  - `semantic_status_counts_indexed_books` now counts markers: a book with chunk rows but no marker isn't counted, and one with a marker and no chunks (all front matter) is.
  - `books_to_index` lists `none` and `partial` books and leaves out `indexed` ones. A book whose only marker is from model `"other"` is listed.
  - `list_books` reports `none` / `partial` / `indexed` for three books set up with `insert_chunks` and `mark_indexed`.
  - Deleting a book removes its `book_embeddings` row. This extends `deleting_a_book_removes_its_embeddings`.
- **Ignored tests, which need the model (`--features semantic`):**
  - indexing `test.epub` writes a marker;
  - a second run reports `already == chapters` and `chunks == 0`;
  - a run whose `progress` returns `Break` after the first chapter reports `stopped` with no marker, and a rerun finishes it.
- **Integration (`tests/integration.rs`):** a library built at migration 005 with chunk rows for one book gets that book's marker after `open_db`, and its status count stays at 1.
- **`src/Books.test.tsx`:**
  - with `semantic: { available: true }`, a `none` book shows "not in chapter search" and **Index**, and clicking it calls `queue_index` with its id and shows **Queued**;
  - **Index all books** calls `queue_index_all` and is hidden once every book is `indexed`;
  - a progress event with `queued: 2` shows " · 2 more books queued" and **Stop**, and Stop calls `stop_indexing`;
  - a stopped event shows the "Stopped indexing… New imports won't be indexed" line;
  - during a folder import, **Stop import** and **Stop indexing** both show, and each calls only its own action (the import loop stops / `stop_indexing`);
  - after Stop, clicking **Index all books** clears the pause line;
  - with semantic unavailable, neither button nor the meta suffix appears (the existing tests cover this).

## 9. README
- Tick the "Index this book" roadmap item, reworded to "An 'Index this book' action, and 'Index all books', so books already in the library join chapter search in place".
- Limitation 8:
  - drop "There's no backfill… re-importing" and "A run stopped by closing the app… counts as indexed";
  - say instead that books imported without the feature, or indexed with another model, can be indexed from the Books screen, and that a stopped or interrupted run carries on from the last finished chapter;
  - keep the note that books indexed before migration 006 count as done even if their run was cut short;
  - replace "indexed one at a time in no particular order" with "one at a time, in the order they were queued";
  - say that Stop indexing also pauses indexing of new imports until Index or Index all books is clicked, or the app restarts.
- "What's actually verified":
  - add the marker, queue and resume tests;
  - describe the Books screen's Index / Index all / Stop as checked against the mocked backend;
  - say what was and wasn't clicked through in the Tauri window.
- Schema list: add "006 adds `book_embeddings`, one row per book an indexing run finished."
