//! Thin Tauri layer on top of `ebook_research_core` — all real logic
//! (parsing, offsets, search ranking) lives in the core crate and is
//! unit/integration tested there. This file just adapts it to Tauri's
//! command/state conventions.

use ebook_research_core::{
    db, open_db, AnnotatedBook, BackupManifest, BlockBookmark, BookAnnotation, BookScan,
    BookSummary, BookmarkFolder, ChapterAnnotations, ChapterContent, ChapterMatch, ChapterSummary,
    FolderBookmark, Highlight, ImportOutcome, LibraryCounts, Note, ReadingPosition, SearchMode,
    SearchResult, SemanticStatus,
};
use rusqlite::Connection;
use std::sync::Mutex;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, State, UriSchemeContext, UriSchemeResponder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[cfg(feature = "semantic")]
use ebook_research_core::{semantic::Embedder, IndexQueue};
#[cfg(feature = "semantic")]
use serde::Serialize;
#[cfg(feature = "semantic")]
use std::ops::ControlFlow;
#[cfg(feature = "semantic")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(feature = "semantic")]
use std::sync::Arc;

/// Holds the open DB connection for the app's lifetime.
/// Tauri gives you `app.manage(...)` for exactly this kind of shared state.
pub struct AppState {
    pub conn: Mutex<Connection>,
    /// Indexing opens its own connection here, so a run that takes minutes
    /// doesn't hold `conn` and stall every other command.
    #[cfg(feature = "semantic")]
    db_path: String,
    /// Loaded on first use, so launching the app doesn't pay for the model.
    /// Shared behind an `Arc` so a search doesn't wait for an indexing run
    /// to finish with it.
    #[cfg(feature = "semantic")]
    embedder: Mutex<Option<Arc<Embedder>>>,
    /// Books waiting to be indexed, which one worker thread takes one at
    /// a time in the order they were queued; see `start_indexer`.
    #[cfg(feature = "semantic")]
    index_queue: Arc<IndexQueue>,
}

fn db_path(app: &AppHandle) -> Result<String, String> {
    // Store the library DB in the OS-appropriate app data directory rather
    // than next to the executable — this is the standard Tauri pattern.
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("couldn't find the app data folder: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    Ok(dir.join("library.db").to_string_lossy().to_string())
}

/// Called once on app startup (see `register` below) to open/create the DB.
pub fn init_state(app: &AppHandle) -> Result<AppState, String> {
    let path = db_path(app)?;
    let conn = open_db(&path).map_err(|e| format!("couldn't open {path}: {e:#}"))?;
    Ok(AppState {
        conn: Mutex::new(conn),
        #[cfg(feature = "semantic")]
        db_path: path,
        #[cfg(feature = "semantic")]
        embedder: Mutex::new(None),
        #[cfg(feature = "semantic")]
        index_queue: Arc::new(IndexQueue::new()),
    })
}

/// Frontend calls: `invoke("import_book", { path: "/path/to/book.epub" })`
/// (returns the existing book, with `already_imported: true`, for a duplicate).
/// With semantic search built in, a new book is then queued for indexing,
/// unless Stop indexing paused that; see `index_in_background`. Async, and run on a blocking
/// thread, so the window keeps repainting while a book parses — a folder
/// import calls this once per book.
#[tauri::command]
pub async fn import_book(path: String, app: AppHandle) -> Result<ImportOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<AppState>()
            .ok_or("the library isn't open")?;
        let outcome = {
            let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
            db::import_book(&mut conn, &path).map_err(|e| e.to_string())?
        };
        if !outcome.already_imported {
            index_in_background(app.clone(), outcome.book_id);
        }
        Ok(outcome)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Frontend calls: `invoke("find_books", { dir: "/path/to/folder" })`. Lists
/// the EPUBs and PDFs under a folder; the frontend then imports them one at
/// a time.
#[tauri::command]
pub fn find_books(dir: String) -> Result<BookScan, String> {
    db::find_books(&dir).map_err(|e| e.to_string())
}

/// Emitted as `semantic_index_progress` once before a book's first chapter
/// and after each one; `done == total` means the book is indexed.
#[cfg(feature = "semantic")]
#[derive(Clone, Serialize)]
struct IndexProgress {
    book_id: i64,
    done: usize,
    total: usize,
    /// Books queued behind this one.
    queued: usize,
}

/// Emitted as `semantic_index_failed` when indexing stops early, e.g. the
/// model couldn't be downloaded. Chapters finished before it stay indexed.
#[cfg(feature = "semantic")]
#[derive(Clone, Serialize)]
struct IndexFailed {
    book_id: i64,
    error: String,
}

/// Emitted as `semantic_index_stopped` when Stop indexing ends a run
/// partway. Chapters finished before it stay indexed, and the next run
/// carries on from them.
#[cfg(feature = "semantic")]
#[derive(Clone, Serialize)]
struct IndexStopped {
    book_id: i64,
    done: usize,
    total: usize,
}

/// Queues a newly imported book for indexing, so the import returns as
/// soon as the book is in the library.
#[cfg(feature = "semantic")]
fn index_in_background(app: AppHandle, book_id: i64) {
    if let Some(state) = app.try_state::<AppState>() {
        state.index_queue.push_import(book_id);
    }
}

#[cfg(not(feature = "semantic"))]
fn index_in_background(_app: AppHandle, _book_id: i64) {}

/// Starts the one thread that indexes queued books, for the app's
/// lifetime. One at a time, so books don't compete for the CPU, and in
/// the order they were queued.
#[cfg(feature = "semantic")]
fn start_indexer(app: AppHandle, queue: Arc<IndexQueue>) {
    std::thread::spawn(move || loop {
        let (book_id, cancel) = queue.next();
        let result = index(&app, &queue, book_id, &cancel);
        let cancelled = queue.finish(book_id);
        match result {
            // A run cancelled because its book was removed can fail on the
            // missing book, which nobody needs to hear about.
            Err(_) if cancelled => {}
            Err(error) => {
                eprintln!("couldn't index book {book_id} for chapter search: {error}");
                let _ = app.emit("semantic_index_failed", IndexFailed { book_id, error });
            }
            Ok(Some(stopped)) => {
                let _ = app.emit("semantic_index_stopped", stopped);
            }
            Ok(None) => {}
        }
    });
}

/// Indexes one book, returning where it stopped if `cancel` ended it early.
#[cfg(feature = "semantic")]
fn index(
    app: &AppHandle,
    queue: &IndexQueue,
    book_id: i64,
    cancel: &AtomicBool,
) -> Result<Option<IndexStopped>, String> {
    let state = app
        .try_state::<AppState>()
        .ok_or("the library isn't open")?;
    let embedder = embedder(&state)?;
    let mut conn = open_db(&state.db_path).map_err(|e| format!("{e:#}"))?;
    let mut at = (0, 0);
    let report = db::index_book(&mut conn, book_id, &embedder, &mut |done, total| {
        at = (done, total);
        let _ = app.emit(
            "semantic_index_progress",
            IndexProgress {
                book_id,
                done,
                total,
                queued: queue.waiting_count(),
            },
        );
        if cancel.load(Ordering::SeqCst) {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })
    .map_err(|e| format!("{e:#}"))?;
    if report.truncated > 0 {
        eprintln!(
            "book {book_id}: {} of {} chunks ran past the model's 512 tokens and were cut short",
            report.truncated, report.chunks
        );
    }
    let (done, total) = at;
    Ok(report.stopped.then_some(IndexStopped {
        book_id,
        done,
        total,
    }))
}

/// Frontend calls: `invoke("queue_index", { bookId: 1 })`. Queues a book
/// for indexing, and ends a pause from Stop indexing. Returns how many
/// books were queued: 0 if it already was.
#[tauri::command]
pub fn queue_index(book_id: i64, state: State<AppState>) -> Result<usize, String> {
    queue_books(&state, |_| Ok(vec![book_id]))
}

/// Frontend calls: `invoke("queue_index_all")`. Queues every book no
/// indexing run has finished, newest first, and ends a pause from Stop
/// indexing. Returns how many books were queued.
#[tauri::command]
pub fn queue_index_all(state: State<AppState>) -> Result<usize, String> {
    queue_books(&state, |conn| {
        db::books_to_index(conn).map_err(|e| e.to_string())
    })
}

#[cfg(feature = "semantic")]
fn queue_books(
    state: &AppState,
    ids: impl FnOnce(&Connection) -> Result<Vec<i64>, String>,
) -> Result<usize, String> {
    let ids = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        ids(&conn)?
    };
    Ok(state.index_queue.push(&ids))
}

#[cfg(not(feature = "semantic"))]
fn queue_books(
    _state: &AppState,
    _ids: impl FnOnce(&Connection) -> Result<Vec<i64>, String>,
) -> Result<usize, String> {
    Err("semantic search isn't available in this build".into())
}

/// Frontend calls: `invoke("stop_indexing")`. Empties the queue, ends the
/// current run after the chapter in flight, and pauses the indexing of new
/// imports until `queue_index` or `queue_index_all` is called.
#[tauri::command]
pub fn stop_indexing(app: AppHandle) -> Result<(), String> {
    stop_index_queue(&app)
}

#[cfg(feature = "semantic")]
fn stop_index_queue(app: &AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<AppState>()
        .ok_or("the library isn't open")?;
    state.index_queue.stop();
    let _ = app.emit("semantic_index_paused", ());
    Ok(())
}

#[cfg(not(feature = "semantic"))]
fn stop_index_queue(_app: &AppHandle) -> Result<(), String> {
    Err("semantic search isn't available in this build".into())
}

/// The embedding model, loading it (and downloading it, the first time)
/// if nothing has used it yet.
#[cfg(feature = "semantic")]
fn embedder(state: &AppState) -> Result<Arc<Embedder>, String> {
    let mut slot = state.embedder.lock().map_err(|e| e.to_string())?;
    if slot.is_none() {
        let loaded =
            Embedder::load().map_err(|e| format!("couldn't load the search model: {e:#}"))?;
        *slot = Some(Arc::new(loaded));
    }
    Ok(Arc::clone(slot.as_ref().expect("loaded above")))
}

/// Frontend calls: `invoke("semantic_status")`, to decide whether to offer
/// chapter search and how many books it covers.
#[tauri::command]
pub fn semantic_status(state: State<AppState>) -> Result<SemanticStatus, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::semantic_status(&conn).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("search_chapters", { query: "dealing with grief" })`.
/// Async, and run on a blocking thread, because the first search may have to
/// download the model and must not freeze the window meanwhile.
#[tauri::command]
pub async fn search_chapters(query: String, app: AppHandle) -> Result<Vec<ChapterMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || find_chapters(&app, &query))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(feature = "semantic")]
fn find_chapters(app: &AppHandle, query: &str) -> Result<Vec<ChapterMatch>, String> {
    let state = app
        .try_state::<AppState>()
        .ok_or("the library isn't open")?;
    let embedder = embedder(&state)?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::search_chapters(&conn, query, &embedder, 20).map_err(|e| e.to_string())
}

/// The frontend only calls `search_chapters` when `semantic_status` says it's
/// available, so this is a guard, not a message anyone should see.
#[cfg(not(feature = "semantic"))]
fn find_chapters(_app: &AppHandle, _query: &str) -> Result<Vec<ChapterMatch>, String> {
    Err("semantic search isn't available in this build".into())
}

/// Frontend calls: `invoke("search_library", { query: "neural networks", mode: "exact", bookId: 1 })`
/// (`mode` is `"stemmed"` or `"exact"`; `bookId` null or omitted searches
/// the whole library).
#[tauri::command]
pub fn search_library(
    query: String,
    mode: SearchMode,
    book_id: Option<i64>,
    state: State<AppState>,
) -> Result<Vec<SearchResult>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::search(&conn, &query, mode, book_id, 50).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("delete_book", { bookId: 1 })`. Removes the book
/// from the library; the book's file itself isn't touched.
#[tauri::command]
pub fn delete_book(book_id: i64, state: State<AppState>) -> Result<(), String> {
    #[cfg(feature = "semantic")]
    state.index_queue.forget(book_id);
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::delete_book(&conn, book_id).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("update_book_details", { bookId: 1, title: "…", author: "…" })`.
/// An empty field clears it. The book's file isn't changed.
#[tauri::command]
pub fn update_book_details(
    book_id: i64,
    title: String,
    author: String,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::update_book_details(&conn, book_id, &title, &author).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_books(state: State<AppState>) -> Result<Vec<BookSummary>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::list_books(&conn).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("get_book_chapters", { bookId: 1 })`
#[tauri::command]
pub fn get_book_chapters(
    book_id: i64,
    state: State<AppState>,
) -> Result<Vec<ChapterSummary>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_book_chapters(&conn, book_id).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("get_chapter_content", { chapterId: 1 })`
#[tauri::command]
pub fn get_chapter_content(
    chapter_id: i64,
    state: State<AppState>,
) -> Result<ChapterContent, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_chapter_content(&conn, chapter_id).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("get_reading_position", { bookId: 1 })`. Null for a book never opened.
#[tauri::command]
pub fn get_reading_position(
    book_id: i64,
    state: State<AppState>,
) -> Result<Option<ReadingPosition>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_reading_position(&conn, book_id).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("set_reading_position", { contentBlockId: 42, finished: false })`. The reader calls it a second after you stop scrolling, on leaving, and on closing the window.
#[tauri::command]
pub fn set_reading_position(
    content_block_id: i64,
    finished: bool,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::set_reading_position(&conn, content_block_id, finished).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("list_reading_positions", { limit: 3 })`. Unfinished books, most recently read first.
#[tauri::command]
pub fn list_reading_positions(
    limit: i64,
    state: State<AppState>,
) -> Result<Vec<ReadingPosition>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::list_reading_positions(&conn, limit).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("create_bookmark_folder", { name: "Know your limit" })`
/// (the name is trimmed, and must be unique ignoring case).
#[tauri::command]
pub fn create_bookmark_folder(
    name: String,
    state: State<AppState>,
) -> Result<BookmarkFolder, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::create_bookmark_folder(&conn, &name).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("rename_bookmark_folder", { folderId: 1, name: "Talk" })`
#[tauri::command]
pub fn rename_bookmark_folder(
    folder_id: i64,
    name: String,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::rename_bookmark_folder(&conn, folder_id, &name).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("delete_bookmark_folder", { folderId: 1 })`. Deletes
/// the folder's bookmarks too; the passages stay in their books.
#[tauri::command]
pub fn delete_bookmark_folder(folder_id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::delete_bookmark_folder(&conn, folder_id).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("list_bookmark_folders")` (newest first)
#[tauri::command]
pub fn list_bookmark_folders(state: State<AppState>) -> Result<Vec<BookmarkFolder>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::list_bookmark_folders(&conn).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("add_bookmark", { folderId: 1, contentBlockId: 42 })`
/// (returns the bookmark's id; adding a passage twice is a no-op).
#[tauri::command]
pub fn add_bookmark(
    folder_id: i64,
    content_block_id: i64,
    state: State<AppState>,
) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::add_bookmark(&conn, folder_id, content_block_id).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("remove_bookmark", { folderId: 1, contentBlockId: 42 })`
#[tauri::command]
pub fn remove_bookmark(
    folder_id: i64,
    content_block_id: i64,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::remove_bookmark(&conn, folder_id, content_block_id).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("list_folder_bookmarks", { folderId: 1 })` (in the
/// order they were added)
#[tauri::command]
pub fn list_folder_bookmarks(
    folder_id: i64,
    state: State<AppState>,
) -> Result<Vec<FolderBookmark>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::list_folder_bookmarks(&conn, folder_id).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("get_chapter_bookmarks", { chapterId: 1 })`
#[tauri::command]
pub fn get_chapter_bookmarks(
    chapter_id: i64,
    state: State<AppState>,
) -> Result<Vec<BlockBookmark>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_chapter_bookmarks(&conn, chapter_id).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("add_highlight", { contentBlockId: 42, start: 0, end: 8, color: "yellow" })`
/// (offsets count characters, not UTF-16 units; the range can't overlap
/// another highlight).
#[tauri::command]
pub fn add_highlight(
    content_block_id: i64,
    start: i64,
    end: i64,
    color: String,
    state: State<AppState>,
) -> Result<Highlight, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::add_highlight(&conn, content_block_id, start, end, &color).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("set_highlight_color", { highlightId: 1, color: "green" })`
#[tauri::command]
pub fn set_highlight_color(
    highlight_id: i64,
    color: String,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::set_highlight_color(&conn, highlight_id, &color).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("delete_highlight", { highlightId: 1 })`. Deletes
/// the highlight's note too.
#[tauri::command]
pub fn delete_highlight(highlight_id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::delete_highlight(&conn, highlight_id).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("add_highlight_note", { highlightId: 1, body: "…" })`
#[tauri::command]
pub fn add_highlight_note(
    highlight_id: i64,
    body: String,
    state: State<AppState>,
) -> Result<Note, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::add_highlight_note(&conn, highlight_id, &body).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("add_paragraph_note", { contentBlockId: 42, body: "…" })`
#[tauri::command]
pub fn add_paragraph_note(
    content_block_id: i64,
    body: String,
    state: State<AppState>,
) -> Result<Note, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::add_paragraph_note(&conn, content_block_id, &body).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("update_note", { noteId: 1, body: "…" })`
#[tauri::command]
pub fn update_note(note_id: i64, body: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::update_note(&conn, note_id, &body).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("delete_note", { noteId: 1 })`
#[tauri::command]
pub fn delete_note(note_id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::delete_note(&conn, note_id).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("get_chapter_annotations", { chapterId: 1 })`
#[tauri::command]
pub fn get_chapter_annotations(
    chapter_id: i64,
    state: State<AppState>,
) -> Result<ChapterAnnotations, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_chapter_annotations(&conn, chapter_id).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("list_annotated_books")` (by title)
#[tauri::command]
pub fn list_annotated_books(state: State<AppState>) -> Result<Vec<AnnotatedBook>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::list_annotated_books(&conn).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("list_book_annotations", { bookId: 1 })` (in
/// reading order)
#[tauri::command]
pub fn list_book_annotations(
    book_id: i64,
    state: State<AppState>,
) -> Result<Vec<BookAnnotation>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::list_book_annotations(&conn, book_id).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("backup_library", { path })`. Writes the whole
/// library to one compressed file.
#[tauri::command]
pub fn backup_library(
    path: String,
    app: AppHandle,
    state: State<AppState>,
) -> Result<BackupManifest, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::backup_library(&conn, &path, &app_version(&app)).map_err(|e| format!("{e:#}"))
}

/// Frontend calls: `invoke("read_backup_manifest", { path })`, to say what
/// a backup holds before asking to restore it. Fails for a file that isn't
/// a backup, or one from a newer Pitaka.
#[tauri::command]
pub fn read_backup_manifest(path: String) -> Result<BackupManifest, String> {
    db::read_backup_manifest(&path).map_err(|e| format!("{e:#}"))
}

/// Frontend calls: `invoke("restore_library", { path })`. Replaces the
/// whole library with the backup's, after saving the current one as
/// `library-before-restore.pitaka` in the app data folder.
#[tauri::command]
pub fn restore_library(
    path: String,
    app: AppHandle,
    state: State<AppState>,
) -> Result<LibraryCounts, String> {
    // A chapter in flight would write its vectors into the restored
    // library, where its id may belong to another book.
    #[cfg(feature = "semantic")]
    if state.index_queue.is_busy() {
        return Err("Stop indexing before restoring a backup".into());
    }
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::restore_library(&mut conn, &path, &app_version(&app)).map_err(|e| format!("{e:#}"))
}

/// Frontend calls: `invoke("backfill_covers")` once per launch; listen for `covers_found` ({ checked, found }).
/// Looks for the covers of books imported before Pitaka read them, on a
/// blocking thread, and returns at once.
#[tauri::command]
pub fn backfill_covers(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        match db::backfill_covers(&state.conn) {
            Ok(found) => {
                let _ = app.emit("covers_found", found);
            }
            Err(e) => eprintln!("couldn't add book covers: {e:#}"),
        }
    });
    Ok(())
}

/// Serves `cover://localhost/{book_id}-{key}` (`http://cover.localhost/…`
/// on Windows): the book's cover thumbnail, a JPEG. The key changes with
/// the image, so the response can be cached for good. A bad path, a book
/// without a cover or a db error is a 404.
pub fn cover_protocol(
    ctx: UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let thumb = cover_book_id(request.uri().path()).and_then(|book_id| {
            let state = app.try_state::<AppState>()?;
            let conn = state.conn.lock().ok()?;
            db::book_cover(&conn, book_id).ok().flatten()
        });
        let response = match thumb {
            Some(thumb) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "image/jpeg")
                .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
                .body(thumb),
            None => Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Vec::new()),
        };
        // Building fails only on an invalid header, and these are fixed.
        if let Ok(response) = response {
            responder.respond(response);
        }
    });
}

/// The book id in a cover URL's path, `/{id}-{key}`: the digits before
/// the `-`.
fn cover_book_id(path: &str) -> Option<i64> {
    let (id, _key) = path.trim_start_matches('/').split_once('-')?;
    id.parse().ok()
}

/// The version in `src-tauri/Cargo.toml`, which a release bumps.
fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Opens the library and stashes the connection in managed state. If that
/// fails, shows the error and quits when it's dismissed, rather than
/// panicking with nothing on screen; commands called meanwhile return
/// "state not managed" errors instead of running.
pub fn register(app: &mut tauri::App) {
    match init_state(app.handle()) {
        Ok(state) => {
            #[cfg(feature = "semantic")]
            let queue = Arc::clone(&state.index_queue);
            app.manage(state);
            #[cfg(feature = "semantic")]
            start_indexer(app.handle().clone(), queue);
        }
        Err(err) => {
            let handle = app.handle().clone();
            app.dialog()
                .message(format!("Pitaka couldn't open its library.\n\n{err}"))
                .title("Pitaka")
                .kind(MessageDialogKind::Error)
                .show(move |_| handle.exit(1));
        }
    }
}
