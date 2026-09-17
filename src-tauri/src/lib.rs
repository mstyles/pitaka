mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            commands::register(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_book,
            commands::search_library,
            commands::delete_book,
            commands::list_books,
            commands::get_book_chapters,
            commands::get_chapter_content,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
