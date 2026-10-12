mod commands;
mod menu;

use tauri::{LogicalSize, Manager, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// The window's size on first launch, as in `tauri.conf.json`: 1280 is the
/// width at which the reader shows its margin column for notes.
const DEFAULT_SIZE: LogicalSize<f64> = LogicalSize::new(1280.0, 800.0);

/// Whether the window-state plugin has a saved size for `label`, so it will
/// restore one. Read before the window exists, because the plugin saves the
/// new window's state as soon as it's created.
fn has_saved_state(app: &tauri::App, label: &str) -> bool {
    let Ok(dir) = app.path().app_config_dir() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(dir.join(app.handle().filename())) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|states| states[label]["width"].as_u64())
        .is_some_and(|width| width > 0)
}

/// Shrinks the first-launch window to fit a small screen, such as a
/// 1366×768 laptop's 728px of work area, and re-centres it. The window
/// starts hidden, so it never visibly jumps.
fn fit_to_screen(window: &WebviewWindow) -> tauri::Result<()> {
    // Some Wayland compositors don't say which monitor a window is on.
    let Some(monitor) = window.current_monitor()? else {
        return Ok(());
    };
    let area = monitor
        .work_area()
        .size
        .to_logical::<f64>(monitor.scale_factor());
    let (max_w, max_h) = (area.width * 0.9, area.height * 0.9);
    if DEFAULT_SIZE.width <= max_w && DEFAULT_SIZE.height <= max_h {
        return Ok(());
    }
    window.set_size(LogicalSize::new(
        DEFAULT_SIZE.width.min(max_w),
        DEFAULT_SIZE.height.min(max_h),
    ))?;
    window.center()
}

/// Creates the main window hidden, fits it to the screen unless the
/// window-state plugin restored a size, and shows it. The config's window
/// has `"create": false` so the saved state can be checked first. A sizing
/// error is logged and the window shown anyway, so it can't stay hidden.
fn open_main_window(app: &tauri::App) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .unwrap_or_default();
    let restored = has_saved_state(app, &config.label);
    let window = WebviewWindowBuilder::from_config(app.handle(), &config)?.build()?;
    if !restored {
        if let Err(err) = fit_to_screen(&window) {
            eprintln!("Couldn't fit the window to the screen: {err}");
        }
    }
    window.show()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Size, position and maximised state; never visibility, so the
        // window's hidden start is left to `open_main_window`.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() - StateFlags::VISIBLE)
                .build(),
        )
        .menu(menu::build)
        .on_menu_event(menu::handle)
        .register_asynchronous_uri_scheme_protocol("cover", commands::cover_protocol)
        .setup(|app| {
            open_main_window(app)?;
            commands::register(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_book,
            commands::find_books,
            commands::search_library,
            commands::delete_book,
            commands::update_book_details,
            commands::backup_library,
            commands::read_backup_manifest,
            commands::restore_library,
            commands::backfill_covers,
            commands::list_books,
            commands::get_book_chapters,
            commands::get_chapter_content,
            commands::get_reading_position,
            commands::set_reading_position,
            commands::list_reading_positions,
            commands::create_bookmark_folder,
            commands::rename_bookmark_folder,
            commands::delete_bookmark_folder,
            commands::list_bookmark_folders,
            commands::add_bookmark,
            commands::remove_bookmark,
            commands::list_folder_bookmarks,
            commands::get_chapter_bookmarks,
            commands::add_highlight,
            commands::set_highlight_color,
            commands::delete_highlight,
            commands::add_highlight_note,
            commands::add_paragraph_note,
            commands::update_note,
            commands::delete_note,
            commands::get_chapter_annotations,
            commands::list_annotated_books,
            commands::list_book_annotations,
            commands::semantic_status,
            commands::search_chapters,
            commands::queue_index,
            commands::queue_index_all,
            commands::stop_indexing,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
