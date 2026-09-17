//! Thin Tauri layer on top of `ebook_research_core` — all real logic
//! (parsing, offsets, search ranking) lives in the core crate and is
//! unit/integration tested there. This file just adapts it to Tauri's
//! command/state conventions.

use ebook_research_core::{
    db, open_db, parse_epub, BookSummary, ChapterContent, ChapterSummary, SearchMode, SearchResult,
};
use rusqlite::Connection;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// Holds the open DB connection for the app's lifetime.
/// Tauri gives you `app.manage(...)` for exactly this kind of shared state.
pub struct AppState {
    pub conn: Mutex<Connection>,
}

fn db_path(app: &AppHandle) -> String {
    // Store the library DB in the OS-appropriate app data directory rather
    // than next to the executable — this is the standard Tauri pattern.
    let dir = app
        .path()
        .app_data_dir()
        .expect("app data dir should be resolvable");
    std::fs::create_dir_all(&dir).ok();
    dir.join("library.db").to_string_lossy().to_string()
}

/// Called once on app startup (see `main.rs` below) to open/create the DB
/// and stash the connection in managed state.
pub fn init_state(app: &AppHandle) -> AppState {
    let path = db_path(app);
    let conn = open_db(&path).expect("failed to open library database");
    AppState {
        conn: Mutex::new(conn),
    }
}

/// Frontend calls: `invoke("import_book", { path: "/Users/matt/Books/foo.epub" })`
#[tauri::command]
pub fn import_book(path: String, state: State<AppState>) -> Result<i64, String> {
    let parsed = parse_epub(&path).map_err(|e| e.to_string())?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::load_book(&conn, &path, &parsed).map_err(|e| e.to_string())
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

#[tauri::command]
pub fn list_books(state: State<AppState>) -> Result<Vec<BookSummary>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::list_books(&conn).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("get_book_chapters", { bookId: 1 })`
#[tauri::command]
pub fn get_book_chapters(book_id: i64, state: State<AppState>) -> Result<Vec<ChapterSummary>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_book_chapters(&conn, book_id).map_err(|e| e.to_string())
}

/// Frontend calls: `invoke("get_chapter_content", { chapterId: 1 })`
#[tauri::command]
pub fn get_chapter_content(chapter_id: i64, state: State<AppState>) -> Result<ChapterContent, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_chapter_content(&conn, chapter_id).map_err(|e| e.to_string())
}

pub fn register(app: &mut tauri::App) {
    let state = init_state(app.handle());
    app.manage(state);
}
