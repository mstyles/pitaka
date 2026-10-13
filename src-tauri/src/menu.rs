//! The app menu. Each item's id is an action name from `src/shortcuts.ts`,
//! sent to the frontend as a `menu` event so it runs the same code as the
//! buttons and keys; only Quit and the links are handled here. Items
//! have no accelerators: on GTK the menu would take the key before the
//! webview saw it, and the frontend handles the keys itself.

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_opener::OpenerExt;

const WEBSITE: &str = "https://mstyles.github.io/pitaka/";
// The same URLs as `FEEDBACK_LINKS` in `src/feedback.tsx`.
const BUG: &str = "https://github.com/mstyles/pitaka/issues/new?template=bug_report.md";
const IDEA: &str = "https://github.com/mstyles/pitaka/issues/new?template=feedback.md";
const EMAIL: &str = "mailto:mstyleshk@gmail.com?subject=Pitaka%20feedback";

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, label: &str| MenuItemBuilder::with_id(id, label).build(app);

    let about = AboutMetadata {
        name: Some("Pitaka".into()),
        version: Some(app.package_info().version.to_string()),
        comments: app.config().bundle.short_description.clone(),
        license: Some("MIT OR Apache-2.0".into()),
        website: Some(WEBSITE.into()),
        copyright: Some("© Matt Styles".into()),
        icon: app.default_window_icon().cloned(),
        ..Default::default()
    };

    // Not the predefined Quit, which GTK doesn't support and which would
    // skip close-requested handlers; see `handle`.
    #[cfg(target_os = "macos")]
    let quit = MenuItemBuilder::with_id("quit", "Quit Pitaka")
        .accelerator("Cmd+Q")
        .build(app)?;
    #[cfg(not(target_os = "macos"))]
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item("import-book", "Import book…")?)
        .item(&item("import-folder", "Import folder…")?)
        .separator()
        .item(&item("back-up", "Back up library…")?)
        .item(&item("restore", "Restore library…")?);
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().item(&quit);
    let file = file.build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item("go-home", "Home")?)
        .item(&item("go-books", "Books")?)
        .item(&item("go-bookmarks", "Bookmarks & notes")?)
        .item(&item("go-search", "Search")?)
        .build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .item(&item("shortcuts", "Keyboard shortcuts")?)
        .separator()
        .item(&item("website", "Pitaka website")?)
        .item(&item("report", "Report a bug")?)
        .item(&item("suggest", "Suggest an idea")?)
        .item(&item("email", "Email feedback")?);
    // On macOS, About lives in the app menu.
    #[cfg(not(target_os = "macos"))]
    let help = help
        .separator()
        .about_with_text("About Pitaka", Some(about.clone()));
    let help = help.build()?;

    let menu = MenuBuilder::new(app);
    // Untested, like the rest of the macOS build. Without the Edit menu,
    // ⌘C and ⌘V stop working in the webview.
    #[cfg(target_os = "macos")]
    let menu = {
        let app_menu = SubmenuBuilder::new(app, "Pitaka")
            .about_with_text("About Pitaka", Some(about))
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .item(&quit)
            .build()?;
        let edit = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;
        let window = SubmenuBuilder::new(app, "Window").minimize().build()?;
        menu.item(&app_menu)
            .item(&file)
            .item(&edit)
            .item(&view)
            .item(&window)
            .item(&help)
    };
    #[cfg(not(target_os = "macos"))]
    let menu = menu.item(&file).item(&view).item(&help);
    menu.build()
}

pub fn handle(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        // Closing the window rather than exiting lets close-requested
        // handlers run; the app exits when its last window closes.
        "quit" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            } else {
                app.exit(0);
            }
        }
        "website" => {
            let _ = app.opener().open_url(WEBSITE, None::<&str>);
        }
        "report" => {
            let _ = app.opener().open_url(BUG, None::<&str>);
        }
        "suggest" => {
            let _ = app.opener().open_url(IDEA, None::<&str>);
        }
        "email" => {
            let _ = app.opener().open_url(EMAIL, None::<&str>);
        }
        id => {
            let _ = app.emit("menu", id);
        }
    }
}
