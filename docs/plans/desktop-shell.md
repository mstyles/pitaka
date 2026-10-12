# Desktop shell: window size, keyboard shortcuts and an app menu

## Context
Pitaka opens in an 800×600 window (`src-tauri/tauri.conf.json`). That's below the 1280px at which the reader shows its margin column for notes (`App.css` `@media (min-width: 1280px)`), so every new user starts in the narrow layout and has to resize. Nothing stops the window shrinking until the 272px reader sidebar crowds out the text. Everything is mouse-only:
- the only keys the app handles are Escape in popovers, the selection toolbar, note cards and the Books filter and edit form;
- there's no way to search, import or change chapter from the keyboard;
- there's no menu bar, so there's nowhere to find Back up, the version or the website outside the Books screen.

These are three of the polish suggestions. They aren't README roadmap items. Build this after `docs/plans/type-spacing-and-buttons.md` and PRs #42/#43 (edit details, backup and restore), because the menu calls Back up and Restore and the shortcuts sheet uses the new tokens and button styles.

Out of scope:
- Reader text size. `docs/plans/reader-settings.md` (being planned alongside this one) owns the setting. This plan reserves Ctrl/⌘ `=`, `-` and `0` for it, lists them in the sheet and the View menu when that plan has landed, and plans nothing about how size is stored or applied.
- Toasts, empty states, motion and icons (the feedback plan), reading progress, and covers.
- Shortcuts for highlighting, bookmarking or notes. The selection toolbar is already where the keyboard user lands after selecting.
- Remapping keys, and a tray icon.
- A dialog asking before leaving the reader with an unsaved note. Today the back button discards one silently. The menu does the same, and Escape and the arrow keys are guarded instead (§3).

Ruled out:
- **Accelerators on the menu items**, which would show "Ctrl+O" beside Import book…. On Linux, GTK runs a window's accelerators before the focused widget sees the key, so the menu would eat the key before the webview got it. On Windows, whether a Ctrl+key reaches the host's accelerator table while WebView2 has focus is unverified. The browser demo, `dev:mock` and the tests have no menu at all, so the frontend needs its own key handling anyway. That makes two paths to keep in sync, with a risk of firing twice. Instead, keys are handled only in the frontend, on every platform, and the menu is mouse-only. Help → Keyboard shortcuts and the `?` sheet list the keys.
- **Writing window position and size to a file by hand** in `src-tauri`, with no new dependency. It's small, but the plugin already handles monitors that have been unplugged, positions that end up off-screen, and maximised state, all of which are easy to get wrong. It's offered as §1's option, not built by hand.
- **Building the menu from JS** (`@tauri-apps/api/menu`). That needs `menu:` permissions in the capability, and the menu would be built on every load, including HMR reloads. Built in Rust, it needs no permissions and exists before the page loads.
- **A native `<dialog>` for the shortcuts sheet.** jsdom 30 has no `showModal`, so `Shortcuts.test.tsx` couldn't open it. A `role="dialog"` overlay is used instead.

Checked:
- The installed Tauri is 2.12.1, with muda 0.20.0.
  - `tauri::App::on_menu_event` and `set_menu` exist, and `Monitor::work_area()` and `scale_factor()` exist (`tauri-2.12.1/src/window/mod.rs:96`).
  - The window config has `min_width`, `min_height`, `center` and `visible` (`tauri-utils-2.10.1/src/config.rs`).
- **muda's predefined items, per platform**:
  - `quit` and `close_window` are unsupported on GTK 3, so File → Quit is a custom item that calls `app.exit(0)`.
  - `copy`/`cut`/`paste` need muda's `libxdo` feature on GTK 3. They aren't used on Linux or Windows, where the webview handles Ctrl+C/V itself.
  - `about` with `AboutMetadata` is implemented on GTK (`show_about_dialog`) and on Windows. On macOS it ignores authors, comments, licence and website.
- **Capabilities**: `src-tauri/capabilities/default.json` grants `core:default` (which includes `core:event:default`, so `listen` works), `opener:default` and `dialog:default`. A menu built in Rust and an event emitted from Rust need nothing more.
  - The Help menu opens URLs through `tauri_plugin_opener::OpenerExt` on the Rust side, which isn't capability-gated.
- **Zoom keys**: `zoomHotkeysEnabled` isn't set, and Tauri's default is false. On WebView2 that turns off page zoom with Ctrl+±, so those keys are free for reader text size.
- **Mocked events**: the mock in `src/test/mockBackend.ts` runs with `shouldMockEvents: true`. So a test's `emit("menu", …)` from `@tauri-apps/api/event` reaches the app's `listen("menu")`, as the indexing events already do.
- **Platform detection**: `isTauri()` in `@tauri-apps/api` 2.12.1 reads `globalThis.isTauri`, which `mockIPC` doesn't set. Nothing in this plan depends on it, and the shortcuts behave the same in the app, the browser and tests.
- **Escape**: the existing handlers are `document` keydown listeners in `BookmarkPopover.tsx`, `HighlightPopover.tsx` and the toolbar effect in `ReaderView.tsx`, plus React `onKeyDown` on the inputs in `NoteCard.tsx` and `BooksView.tsx`. React's handlers run at the root container, and the `document` listeners run before `window` ones while bubbling. So a `window` listener sees every one of them first.
- **Platforms**: the app is built and tested on Linux (WebKitGTK) and Windows (WebView2). macOS builds but is untested (README Install).

## 1. Window: `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`
- The `windows[0]` config:
  - `"width": 1280, "height": 800, "minWidth": 720, "minHeight": 480, "center": true, "visible": false`.
  - 1280 is the width at which the margin column appears. 720 still fits the 272px sidebar beside a readable column, and 480 keeps the Books toolbar and a few rows in view.
- New `fn fit_to_screen(window: &tauri::WebviewWindow) -> tauri::Result<()>` in `src-tauri/src/lib.rs`, called in `.setup` before `commands::register`. It reads `window.current_monitor()?` and converts its `work_area().size` to logical size with its `scale_factor()`. If 1280×800 doesn't fit in 90% of that area, it sets the size to the smaller of the two, re-centres the window and then calls `show()`. Without a monitor, as under some Wayland compositors, it just shows the window.
  - This keeps a 1366×768 laptop (728px of work area) from opening with the bottom off-screen.
  - The window starts hidden, so it never visibly jumps.
  - An error in this function is logged with `eprintln!` and the window is shown anyway, so a sizing problem can't leave the window hidden. The memory note about a blank window caused by the fontconfig cache is a separate issue: there the window shows but stays empty.
- **Remember the size and position** with `tauri-plugin-window-state`, which you approved on 2026-10-12: one crate in `src-tauri/Cargo.toml`, the 2.x release matching Tauri 2.12, pinned like the other Tauri plugins. No npm package is needed, because the Rust side saves on close and restores on open, and the JS API isn't used. Its capability isn't needed for the same reason.
  - It's registered with `StateFlags::all() - StateFlags::VISIBLE`, so it never fights the hidden start.
  - `fit_to_screen` runs only when the plugin restored nothing, which happens on first launch or after its file is deleted.
  - A window restored onto a monitor that's no longer connected is the plugin's to handle; check it in Verification by unplugging a second screen.

## 2. Key handling: new `src/shortcuts.ts`
- `export type Action`, the shared vocabulary for keys and menu items:
  - `"go-home" | "go-books" | "go-bookmarks" | "go-search"`
  - `"import-book" | "import-folder" | "back-up" | "restore"`
  - `"shortcuts"`
  - `"text-larger" | "text-smaller" | "text-reset"`, reserved for reader-settings (they do nothing until that plan lands).
  - `export const MENU_ACTIONS: Action[]` lists the ones the menu sends.
- `export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)`, and `export function keyLabel(key: string, opts?: { shift?: boolean })`. It renders `"Ctrl+O"` / `"Ctrl+Shift+O"`, or `"⌘O"` / `"⇧⌘O"` on a Mac.
- `export function isEditable(target: EventTarget | null)`: true for `input` (other than checkbox and radio), `textarea`, `select` and `[contenteditable]`.
- `export function shortcutFor(e: KeyboardEvent, opts: { browserKeys?: boolean } = {}): Action | null`, a pure function so it can be unit-tested. With `browserKeys`, Mod+F, Mod+O and Mod+Shift+O return null, so the browser keeps Find and Open. It returns null when `e.repeat`, `e.isComposing` or `e.altKey` is set. The primary modifier is `metaKey` on a Mac and `ctrlKey` elsewhere, and the other one must be up. The bindings:

  | Key | Action | In a text field |
  | --- | --- | --- |
  | Mod+F | `go-search` | works |
  | Mod+O | `import-book` | works |
  | Mod+Shift+O | `import-folder` | works |
  | Mod+1 / 2 / 3 / 4 | Home / Books / Bookmarks & notes / Search | works |
  | Mod+= (and Mod++) / Mod+- / Mod+0 | text size (reserved) | works |
  | `?`, with no modifier other than Shift | `shortcuts` | ignored, so `?` can still be typed |

  It matches on `e.key`, and on `e.code` (`Digit1` to `Digit4`, `Equal`, `Minus`, `Digit0`) for the digits and `=`/`-`, so non-US layouts work too.
- No Back up or Restore keys. Both open a file dialog and are rare, so the menu is enough.
- `export function useShortcuts(onAction: (a: Action) => void, enabled: boolean)` adds one `window` keydown listener. When `shortcutFor` returns an action, the listener calls `e.preventDefault()` and then `onAction`. It skips events that are already `defaultPrevented`.
  - In the browser demo, `App` passes `browserKeys: import.meta.env.MODE === "demo"`, so Mod+F stays the browser's Find (the demo is a web page, and people expect it there) and Mod+O / Mod+Shift+O stay the browser's, since the demo can't import anyway. Chrome also keeps Ctrl+1–4 for its tabs, so in practice the demo's keys are `?`, the reader's arrows and Escape. The desktop app takes all of them.

## 3. Wiring: `src/App.tsx`, `src/ReaderView.tsx`, `src/BooksView.tsx`, `src/SearchView.tsx`
- `App.tsx` gets `function runAction(a: Action)`:
  - `go-*` closes the reader (`setReader(null)`) and calls `navigate(...)`.
    - `go-search` from the reader does what the sidebar's Search this book does: `setSearchBookId(reader.bookId)`.
    - `go-search` anywhere else keeps the current scope and bumps a new `searchFocus` counter.
  - `import-book`, `import-folder`, `back-up` and `restore` close the reader, go to Books and set `booksRequest` to `{ action, seq }`. `seq` is a counter, so the same action twice in a row still runs.
  - `shortcuts` sets `showShortcuts` to true.
  - Text-size actions are passed on to the reader-settings handler once it exists, and ignored until then.
  - `useShortcuts(runAction, !showShortcuts)` runs while the sheet is closed, and `listen<Action>("menu", (e) => runAction(e.payload))` is registered in an effect, unlistened on unmount as `useIndexing` does. While the sheet is open, menu actions still run and close it first.
- `SearchView.tsx`: a new prop `focusRequest: number`, added to the deps of the existing effect that focuses `inputRef` when `active`. So Mod+F focuses the box even when Search is already showing.
- `BooksView.tsx`: a new prop `request: { action: "import-book" | "import-folder" | "back-up" | "restore"; seq: number } | null`.
  - An effect on `request?.seq` runs the same function as the button: `importBook`, `importFolder`, `backUp` or `restore`.
  - When the button would be disabled, it sets `importStatus` instead. While `importing`, the message is "Wait for the folder import to finish". For `restore` while `anyQueued`, it's "Stop indexing to restore a backup", the button's existing title.
- `ReaderView.tsx`: its own `window` keydown effect, depending on `chapters`, `activeChapterId` and `onBack`. It ignores events that are `defaultPrevented` or `repeat`, have any modifier, come from an `isEditable` target, or arrive while a note card is being edited (`textRef.current?.querySelector(".note-card textarea")`, so a note being typed is never discarded by a stray key).
  - `Escape` calls `onBack()`. The popovers, selection toolbar and note card handle Escape first and now mark it handled (below), so Escape closes the innermost thing first, then the book.
  - `ArrowLeft`/`ArrowRight` call `selectChapter` with the previous or next entry of `chapters`. They do nothing at either end. The keys don't scroll horizontally today, since `.reader-content` only scrolls vertically.
- Each existing Escape handler gets `e.preventDefault()`: `BookmarkPopover.tsx`, `HighlightPopover.tsx`, the toolbar effect in `ReaderView.tsx`, the textarea in `NoteCard.tsx`, and `cancelOnEscape` and the filter input in `BooksView.tsx`. Nothing else changes.

## 4. Shortcuts sheet: new `src/ShortcutsSheet.tsx`, `src/App.css`, `src/HomeView.tsx`
- `<div className="sheet-backdrop">` holds `<div role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" className="sheet">`.
  - The heading is `<h2 id="shortcuts-title">Keyboard shortcuts</h2>`.
  - There are two `<section>`s, each a `<dl>` of key and description pairs.
    - **Anywhere**:
      - `Mod+F`: Search (in a book: search that book)
      - `Mod+O`: Import a book
      - `Mod+Shift+O`: Import a folder
      - `Mod+1`–`4`: Home, Books, Bookmarks & notes, Search
      - `?`: This list
    - **In the reader**:
      - `←` / `→`: Previous / next chapter
      - `Esc`: Close the popup, or go back
    - A third section, **Text size**, is added by the reader-settings plan if it lands.
    - In the demo (`browserKeys`), the Mod+F and Mod+O rows are left out, since those keys belong to the browser there.
  - Keys are rendered with `keyLabel` inside `<kbd>`.
  - At the bottom is a `button-primary` "Close", which is focused on open.
- Closing: Escape (handled with `preventDefault`), Close, or a click on the backdrop. Focus returns to the element that was focused before. Tab is kept inside the sheet with a small wrap between its first and last focusable elements.
- CSS:
  - `.sheet-backdrop` is `position: fixed; inset: 0` with `rgba(0, 0, 0, 0.35)`. It's a new `--backdrop` token, with `0.55` in dark mode.
  - `.sheet` is `--surface` with `--radius` and the popovers' shadow, `max-width: 28rem` and `--space-6` padding.
  - `kbd` is `--text-sm` in `--font-ui`, with a 1px `--border` and `--space-1`/`--space-2` padding.
  - All of it uses the type-spacing tokens, so `styles.test.ts` passes.
- `HomeView.tsx`: under the recent books, add `<p className="home-hint">Press <kbd>?</kbd> for keyboard shortcuts</p>`, styled `--text-sm` and `--muted` (the feedback plan removes `.status`). It's the only hint in the browser demo, which has no menu.

## 5. App menu: new `src-tauri/src/menu.rs`, `src-tauri/src/lib.rs`
- `pub fn build(app: &tauri::App) -> tauri::Result<Menu<Wry>>`, using `MenuBuilder`/`SubmenuBuilder`. Item ids are the `Action` strings, and labels are as written here. Items that open a dialog end in "…", following the menu convention on every platform, though the Books screen's buttons don't:
  - **File**:
    - Import book… (`import-book`), Import folder… (`import-folder`)
    - separator
    - Back up library… (`back-up`), Restore library… (`restore`)
    - separator
    - Quit (`quit`, handled in Rust by calling `close()` on the main window rather than `app.exit(0)`, so close-requested handlers such as the reading-progress plan's save still run; the app exits when its last window closes). On macOS the App menu's Quit is this same custom item, not the predefined one, for the same reason.
  - **View**: Home, Books, Bookmarks & notes, Search (`go-*`). The reader-settings plan adds "Larger text / Smaller text / Default text size" here behind a separator, and a Theme submenu (System, Light, Sepia, Dark; actions `theme-*`).
  - **Help**:
    - Keyboard shortcuts (`shortcuts`)
    - separator
    - Pitaka website (`website`, opens `https://mstyles.github.io/pitaka/`)
    - Report a problem (`report`, opens `https://github.com/mstyles/pitaka/issues`)
    - separator
    - `PredefinedMenuItem::about(Some("About Pitaka"), …)`, whose `AboutMetadata` has:
      - name "Pitaka";
      - `version: app.package_info().version`;
      - comments: the bundle's `shortDescription`;
      - `license: "MIT OR Apache-2.0"`;
      - `website`: the homepage;
      - `copyright: "© Matt Styles"`.
  - **macOS** (`#[cfg(target_os = "macos")]`): the first submenu is the app menu, holding About, Services, Hide, Hide Others, Show All and Quit (predefined), and the File menu loses its Quit. An **Edit** submenu holds Undo, Redo, Cut, Copy, Paste and Select All (predefined), because without them ⌘C/⌘V stop working in the webview on macOS. A Window submenu holds Minimize. This is untested, like the rest of the macOS build.
- `pub fn handle(app: &AppHandle, event: MenuEvent)`:
  - `quit` → `app.exit(0)`;
  - `website` / `report` → `app.opener().open_url(url, None::<&str>)`, with errors ignored;
  - any other id → `app.emit("menu", id)`.
  - It holds no app logic and doesn't touch `state.conn`, so the thin-commands rule holds: the frontend runs the same code as the buttons.
- `lib.rs`: `mod menu;`, plus `.menu(|app| menu::build(app))` and `.on_menu_event(menu::handle)` on the builder. The menu is a window menu bar on Linux (GTK) and Windows, and the global menu on macOS. On GNOME it takes about 28px above the content; Linux and Windows differ only in how it's drawn.
- `MENU_ACTIONS` in `shortcuts.ts` must match the ids `menu.rs` emits. §6 checks this.

## 6. Tests
- `src/shortcuts.test.ts`, using `new KeyboardEvent("keydown", {...})` and jsdom, where `isMac` is false:
  - `Ctrl+F` → `go-search`, `Ctrl+O` → `import-book`, `Ctrl+Shift+O` → `import-folder`, and `Ctrl+3` → `go-bookmarks`, also with `key: "#"` and `code: "Digit3"` as an AZERTY layout produces.
  - `Meta+F` → null, `Ctrl+Alt+F` → null, and `repeat: true` → null.
  - `?` → `shortcuts`; `?` with `isEditable` true → null; `Ctrl+O` from an `<input>` → `import-book`.
  - `keyLabel("O", { shift: true })` is `"Ctrl+Shift+O"`.
  - With `{ browserKeys: true }`: `Ctrl+F`, `Ctrl+O` and `Ctrl+Shift+O` → null; `Ctrl+2` and `?` still map.
  - `menu ids match`: read `src-tauri/src/menu.rs` from disk, as `fonts.test.ts` does. Collect the ids passed to `MenuItemBuilder::with_id`, and check that every one except `quit`, `website` and `report` is in `MENU_ACTIONS`, and that every `MENU_ACTIONS` entry is in the file.
- New `src/Shortcuts.test.tsx`, with `renderApp` and `user.keyboard`:
  - From Home, `{Control>}f{/Control}` shows the Search heading with the search box focused. Pressing it again after clicking the results area focuses the box again.
  - `Ctrl+2` shows Books, and `Ctrl+3` shows Bookmarks & notes.
  - `Ctrl+O` on Home goes to Books, calls `plugin:dialog|open`, then `import_book` with `{ path: "/books/test.epub" }`, and shows "Already in library as book #…".
  - With `scan` keeping a folder import running, `Ctrl+O` makes no dialog call and shows "Wait for the folder import to finish".
  - `emit("menu", "back-up")` from `@tauri-apps/api/event` calls `backup_library` with `{ path: "/backups/pitaka-backup.pitaka" }`. `emit("menu", "restore")` while a book is queued (the `semantic` option) shows "Stop indexing to restore a backup" and makes no `read_backup_manifest` call.
  - **Reader**: open Test Book of Research, then find a chapter by title, not index, because the spine starts with `nav.xhtml`.
    - `{ArrowRight}` makes the next chapter's sidebar button `active`, and `{ArrowLeft}` returns. `{ArrowLeft}` on the first chapter does nothing.
    - `{Escape}` returns to Books.
  - **Escape order**:
    - Select text so the selection toolbar shows: `{Escape}` hides it and the reader is still open. A second `{Escape}` leaves.
    - The same with the highlight popover and with the bookmark popover.
  - **A note being edited**: with a note card's textarea open and focus moved to the body, `{Escape}` and `{ArrowRight}` neither leave nor change chapter.
  - Typing `←` in the bookmark popover's new-folder input doesn't change chapter.
  - `Ctrl+F` in the reader opens Search with the "Search in" picker set to that book.
  - **The sheet**:
    - `?` opens a dialog named "Keyboard shortcuts", listing "Ctrl+Shift+O" and "Previous / next chapter", with Close focused.
    - `{Escape}` closes it and leaves the screen as it was.
    - `?` typed into the search box types "?" and opens nothing.
    - While the sheet is open, `Ctrl+2` does nothing.
  - Home shows "Press ? for keyboard shortcuts".
- `src/Demo.test.tsx`, with `vi.stubEnv("MODE", "demo")`: `?` opens the sheet, which has no "Ctrl+F" or "Ctrl+O" row; a `Ctrl+F` keydown isn't `defaultPrevented` and leaves the screen as it was; `Ctrl+O` makes no `plugin:dialog|open` call.
- Existing tests pass unchanged. The added `preventDefault()` calls don't change any Escape behaviour.
- Rust: no unit test for `menu.rs`. `tauri::test` needs the `test` feature, which isn't enabled. The id-matching test and the manual check in Verification cover it.

## 7. README
- Feature list: one line saying keyboard shortcuts cover search, import, the sections and chapter-by-chapter reading, that `?` lists them, and that there's an app menu.
- "How it's built": `src/shortcuts.ts` as the one place keys are handled; `src-tauri/src/menu.rs`, which emits a `menu` event with the same action names; the window starting hidden and fitted to the screen on first launch; and `tauri-plugin-window-state` restoring its size and position after that.
- "What's actually verified": `shortcuts.test.ts` and `Shortcuts.test.tsx`, plus what was checked by hand in `npm run tauri dev` on Linux and in the Windows build. macOS is untested.
- Known limitations:
  - the menu shows no shortcut hints beside its items (see `?`);
  - leaving the reader from the menu discards a note being written, as Back does;
  - in the browser demo, Ctrl/⌘+F and Ctrl/⌘+O are left to the browser.
- Roadmap: add and tick "Keyboard shortcuts, an app menu and a larger default window".
- Per the site-copy memory, no change to `site/` until the release that ships it.

## Verification
1. `npx tsc --noEmit`, `npm test`, `npm run format:check`, `cargo clippy --workspace --all-targets`, `cargo test -p ebook_research_core`.
2. `npm run dev:mock` and `npm run dev:demo` in Chrome: every shortcut in the sheet, Escape order in the reader, `?` in a text field, and the Home hint.
3. `npm run tauri dev` on Linux:
   - the window opens at 1280×800, centred, with the margin column, and on a 1366×768 display it fits;
   - it can't shrink below 720×480;
   - resized and moved, it reopens where it was left; with that position on a second monitor that's since been unplugged, it opens on screen;
   - every menu item works; About shows the version;
   - Ctrl+F/O/1–4 reach the webview with the menu bar present;
   - Ctrl+C/V still work in the note textarea.
4. The Windows build (CI artifact on the Windows PC):
   - the same checks;
   - that Ctrl+F doesn't open WebView2's own find bar, now that `preventDefault` is called;
   - that Ctrl+± doesn't zoom the page;
   - that the About box reads correctly.
