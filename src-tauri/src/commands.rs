//! Thin Tauri layer on top of `ebook_research_core` — all real logic
//! (parsing, offsets, search ranking) lives in the core crate and is
//! unit/integration tested there. This file just adapts it to Tauri's
//! command/state conventions.

use ebook_research_core::{
    db, open_db, BlockBookmark, BookSummary, BookmarkFolder, ChapterContent, ChapterMatch,
    ChapterSummary, FolderBookmark, ImportOutcome, SearchMode, SearchResult, SemanticStatus,
};
use rusqlite::Connection;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[cfg(feature = "semantic")]
use ebook_research_core::semantic::Embedder;
#[cfg(feature = "semantic")]
use serde::Serialize;
#[cfg(feature = "semantic")]
use std::sync::Arc;
#[cfg(feature = "semantic")]
use tauri::Emitter;

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
    /// Held while a book is indexed, so books imported together are indexed
    /// one after another rather than competing for the CPU.
    #[cfg(feature = "semantic")]
    indexing: Mutex<()>,
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
        indexing: Mutex::new(()),
    })
}

/// Frontend calls: `invoke("import_book", { path: "/path/to/book.epub" })`
/// (returns the existing book, with `already_imported: true`, for a duplicate).
/// With semantic search built in, a new book is then indexed in the
/// background; see `index_in_background`.
#[tauri::command]
pub fn import_book(
    path: String,
    app: AppHandle,
    state: State<AppState>,
) -> Result<ImportOutcome, String> {
    let outcome = {
        let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
        db::import_book(&mut conn, &path).map_err(|e| e.to_string())?
    };
    if !outcome.already_imported {
        index_in_background(app, outcome.book_id);
    }
    Ok(outcome)
}

/// Emitted as `semantic_index_progress` once before a book's first chapter
/// and after each one; `done == total` means the book is indexed.
#[cfg(feature = "semantic")]
#[derive(Clone, Serialize)]
struct IndexProgress {
    book_id: i64,
    done: usize,
    total: usize,
}

/// Emitted as `semantic_index_failed` when indexing stops early, e.g. the
/// model couldn't be downloaded. Chapters finished before it stay indexed.
#[cfg(feature = "semantic")]
#[derive(Clone, Serialize)]
struct IndexFailed {
    book_id: i64,
    error: String,
}

/// Embeds a newly imported book's chapters on a thread of its own, so the
/// import returns as soon as the book is in the library.
#[cfg(feature = "semantic")]
fn index_in_background(app: AppHandle, book_id: i64) {
    std::thread::spawn(move || {
        if let Err(error) = index(&app, book_id) {
            eprintln!("couldn't index book {book_id} for chapter search: {error}");
            let _ = app.emit("semantic_index_failed", IndexFailed { book_id, error });
        }
    });
}

#[cfg(not(feature = "semantic"))]
fn index_in_background(_app: AppHandle, _book_id: i64) {}

#[cfg(feature = "semantic")]
fn index(app: &AppHandle, book_id: i64) -> Result<(), String> {
    let state = app
        .try_state::<AppState>()
        .ok_or("the library isn't open")?;
    // The guard protects no data, so a run that panicked doesn't matter.
    let _one_at_a_time = state.indexing.lock().unwrap_or_else(|e| e.into_inner());
    let embedder = embedder(&state)?;
    let mut conn = open_db(&state.db_path).map_err(|e| format!("{e:#}"))?;
    let report = db::index_book(&mut conn, book_id, &embedder, &mut |done, total| {
        let _ = app.emit(
            "semantic_index_progress",
            IndexProgress {
                book_id,
                done,
                total,
            },
        );
    })
    .map_err(|e| format!("{e:#}"))?;
    if report.truncated > 0 {
        eprintln!(
            "book {book_id}: {} of {} chunks ran past the model's 512 tokens and were cut short",
            report.truncated, report.chunks
        );
    }
    Ok(())
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

/// Frontend calls: `invoke("search_library", { query: "neural networks", mode: "exact" })`
/// (`mode` is `"stemmed"` or `"exact"`).
#[tauri::command]
pub fn search_library(
    query: String,
    mode: SearchMode,
    state: State<AppState>,
) -> Result<Vec<SearchResult>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::search(&conn, &query, mode, 50).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("delete_book", { bookId: 1 })`. Removes the book
/// from the library; the EPUB file itself isn't touched.
#[tauri::command]
pub fn delete_book(book_id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::delete_book(&conn, book_id).map_err(|e| e.to_string())
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

/// Opens the library and stashes the connection in managed state. If that
/// fails, shows the error and quits when it's dismissed, rather than
/// panicking with nothing on screen; commands called meanwhile return
/// "state not managed" errors instead of running.
pub fn register(app: &mut tauri::App) {
    match init_state(app.handle()) {
        Ok(state) => {
            app.manage(state);
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
