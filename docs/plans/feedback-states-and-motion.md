# Status feedback, loading and empty states, motion and icons

## Context
After the type and button pass (`docs/plans/type-spacing-and-buttons.md`), the app has a consistent look at rest. It still feels unfinished when things are happening or when there's nothing to show yet:
- **Status is plain grey text.** Every outcome is a grey line of text: `BooksView`'s `importStatus` beside the import buttons, `.status` on Home, Bookmarks and Search, `.folder-status` on a folder and on a book's notes, and `.reader-error`. "Backing up…", "Restored 54 books…" and "Restore failed: …" look the same. Errors aren't red, nothing marks work in progress, and the text isn't in a live region, so a screen reader announces none of it. The four popover and toolbar error lines (`.bookmark-popover-error`, `.selection-toolbar-error`) are red, but aren't announced either.
- **Loading is invisible, and two screens say "empty" while they're still loading:**
  - Books renders an empty `<ul class="book-list">` until `list_books` returns.
  - Bookmarks renders nothing at all (`BookmarksView` returns `null`).
  - `FolderView` and `BookAnnotationsView` start from `[]`, not `null`. So a folder shows "No passages yet…" until its passages arrive, and a book's notes screen briefly lists none.
  - The reader's sidebar and text are blank until the chapter loads.
- **Empty states are one grey sentence.**
  - An empty library on a new install gets "No books yet. Import an EPUB or PDF to start." under buttons that are already there, and nothing points to **Restore**, which a new install is exactly when you'd want.
  - "No results" on Search gives no hint about what to try instead.
- **Nothing moves.** Popovers, the selection toolbar, note cards and whole screens appear instantly. There are no `@keyframes` and no `prefers-reduced-motion` handling.
- **Icons are scattered.** The same magnifier SVG is pasted three times (`SearchView.tsx`, `BooksView.tsx`, `ReaderView.tsx`). The home cards' icons live in `ICONS` in `HomeView.tsx`, `PenIcon` lives in `ReaderView.tsx`, and the bookmark is drawn twice on different grids (24×24 on Home, 16×20 in the reader). Four separate CSS rules set the same stroke style. The nav and the import, backup and restore buttons have no icons.

This plan covers four things:
- a `StatusLine` component, with busy, done, error and info states, used everywhere a status shows today, plus toasts for background work that finishes while you're on another screen;
- delayed skeletons and `aria-busy` while loading;
- an `EmptyState` component, with copy for each empty case;
- short entrance motion with a reduced-motion opt-out, and `src/icons.tsx`, the app's one import point for Lucide icons.

It's frontend only. There's no Rust and no new command. It adds one npm dependency, `lucide-react`, which you approved on 2026-10-12 (§4). It isn't a README roadmap item. Build it after #42, #43 and the type and button pass, since it uses their tokens and button classes and styles their new buttons.

Other plans are being written in parallel:
- **Icons:** the desktop shell, reader settings, reading progress and book covers plans should take any icon they need (a settings "Aa", a chevron, a cover placeholder) from `src/icons.tsx`, adding a Lucide re-export there if it's new (§4).
- **Loading and empty states:** a cover grid or "Continue reading" list should use `EmptyState` and the `.skeleton` classes rather than their own.
- **Menu actions:** the desktop shell plan's menu items (File → Back up) switch to the Books screen before running, so their outcome lands in its `StatusLine` like a click would. Toasts (§1) are only for work that carries on in the background.

Out of scope:
- Exit animations. Popovers and screens unmount immediately. Animating them out needs a delayed-unmount state in every component, for 120ms of polish.
- Animated transitions between screens beyond a fade (slides, shared elements). Pitaka's screens have no spatial order for a slide to follow.
- Reworking what any status says. Every message keeps its wording, so the many existing `findByText` assertions keep passing. Only the presentation changes.
- Progress bars for folder import and indexing. Their lines ("Importing 1 of 3…", "3/24 chapters") become busy `StatusLine`s, and a real bar is a later plan.

Ruled out:
- **Toasts for everything** (every message floats in a corner and fades out). They put the outcome far from the button that caused it, they'd need an App-level context for screens that today own their status, and "Imported 1 book, 1 already in library, 1 failed" has its failure list right below it, which a toast can't keep. You chose both: inline `StatusLine`s for actions on the screen you're looking at, and toasts only for background work that finishes while that screen isn't showing (§1).
- **A toast or animation library** (`sonner`, `framer-motion`). These are new dependencies, the toaster is about 40 lines, and CSS keyframes cover entrance-only motion.
- **The View Transitions API for screen changes.** WebKitGTK's support depends on the system's version, which isn't pinned. A keyframe fade on mount works everywhere.
- **Drawing the icons by hand, or copying Lucide's paths into the repo.** Hand-drawn glyphs are hard to keep optically consistent across about 15 icons and the ones later plans add, and copying paths means doing it again for every new icon. You chose the `lucide-react` package: it's ISC-licensed, tree-shaken to the icons imported (about 1 KB each), and its 24-unit grid and round-capped strokes are what the existing inline SVGs already copy.
- **Skeletons shown straight away.** Local SQLite answers `list_books` in a few milliseconds, and a skeleton that flashes for one frame looks worse than nothing. Skeletons wait 200ms (§2).

Checked:
- **Status strings in tests:** every status string the tests assert ("Removed "…"", "Backed up …", "Import failed: …", "Loading library failed: database is locked", "No results", "Importing 1 of 3…") is set in one of these places:
  - `setImportStatus` or `folderImportLine` in `BooksView.tsx`;
  - `setStatus` in `BookmarksView`, `FolderView`, `BookAnnotationsView` or `SearchView`;
  - `setErrors` in `HomeView`;
  - `setError` in `ReaderView`.
- **Text matching:** all of those reach the screen through `StatusLine`'s text node. Testing Library's `getByText` matches an element's own text, and `StatusLine` keeps the icon in a separate `aria-hidden` element, so the assertions still match.
- **Empty-state copy in tests:** the copy is asserted in `Bookmarks.test.tsx:51` and `:190`, `Books.test.tsx:129` and `:258`, and `Home.test.tsx:90`. §6 updates these.
- **Duplicate buttons:** `Backup.test.tsx` finds **Restore** by name with `getByRole`. So the empty library must not show two buttons with that name (§3).
- **Selection toolbar transform:** `.selection-toolbar` is placed with `transform: translate(-50%, calc(-100% - 8px))`, so its keyframes have to include that translate (§5). `HighlightPopover` and `BookmarkPopover` are placed with `top`/`left` only.
- **Reduced motion:** the reader scrolls with `scrollIntoView({ block: "center" })`, which isn't smooth, so it needs nothing.

## 1. Status: new `src/StatusLine.tsx`, the views, `src/App.css`
- `export type Status = { kind: "busy" | "done" | "error" | "info"; text: string }`, plus helpers `busy(text)`, `done(text)`, `failed(text)` and `info(text)` that return one.
- `StatusLine({ status, className }: { status: Status | null; className?: string })` renders `<p className={"status-line" + kind class + className} role="status" aria-live="polite">`.
  - The paragraph is always rendered, empty when `status` is null, so the live region exists before its first message, which screen readers need.
  - Inside it: `<span className="status-icon" aria-hidden="true">` with the kind's icon, then `<span>{text}</span>`.
  - An `error` uses `role="alert"` instead of `role="status"`.
  - The icons are: `busy`, a `.spinner` (a 14px ring with a gap, made in CSS); `done`, `CheckIcon`; `error`, `AlertIcon`; `info`, none.
- CSS:
  - `.status-line`: `display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); color: var(--muted); min-height: 1.5em`. The min-height means a message appearing doesn't push the list down.
  - `.status-error`: `color: var(--danger)`.
  - `.status-done .status-icon`: `color: var(--accent)`.
  - `.spinner`: a 14px circle with a `2px solid currentColor` border, `border-right-color: transparent`, and `animation: spin 0.8s linear infinite`.
- Call sites. The state changes from `string` to `Status | null`, and the wording stays the same:
  - **`BooksView.tsx`, `importStatus`:**
    - `busy`: `Importing ${path}…`, "Backing up…" and "Restoring…".
    - `done`: the import result line, "Backed up …", "Restored …", "Removed "…"" and "Updated "…"".
    - `failed`: "Loading library failed", `act`'s `${failure}: ${err}`, "Import failed", "Backup failed", "Restore failed", "Remove failed" and "Saving failed".
    - `folderImportLine` returns a `Status`:
      - `busy` while `f.running`;
      - `failed` for `scanError`;
      - `info` for "No EPUB or PDF files…" and "Nothing new…";
      - `done` otherwise. "1 failed" stays `done`, because the red paths in `.import-failures` below it carry the errors.
    - The index progress `line` renders as a `busy` `StatusLine` while a book is indexing, and as `info` when paused.
    - The `<span>` in the import row becomes `<StatusLine status={importStatus ?? (folderImport && folderImportLine(folderImport))} />`.
  - **`HomeView`:** each entry in `errors` becomes a `failed` `StatusLine`.
  - **`BookmarksView`, `SearchView`:** `status` becomes a `Status | null`, and every assignment is a `failed(...)`.
  - **`SearchView`'s result count** stays a plain `.result-count` line. It's a count, not a status. "Searching…" stays on the button, and the results list gets `aria-busy` (§2).
  - **`FolderView`, `BookAnnotationsView`:** the `.folder-status` line shows the passage or highlight count as it does today. When `status` is set (always a failure), it shows `<StatusLine status={status} className="folder-status" />` instead.
  - **`ReaderView`:** `error` renders as `<StatusLine status={failed(error)} className="reader-error" />`.
  - **Popovers and the toolbar:** the four `{error && <div className="bookmark-popover-error">…}` lines and `.selection-toolbar-error` become `<StatusLine status={error ? failed(error) : null} className="bookmark-popover-error" />`, keeping their classes for spacing.
- Remove `.status`, `.folder-status`'s colour and size, and `.reader-error` from `App.css`; `.status-line` covers them. `.section-empty` goes too, since §3 replaces every use.
- **Toasts, for background work only:** new `src/Toaster.tsx`, `src/App.tsx`.
  - Two things in Pitaka carry on after you leave the Books screen: a folder import (`useFolderImport`, run from `App`) and chapter indexing (`useIndexing`). When one of them ends while the Books screen isn't showing (`screen !== "books"` or the reader is open), `App` adds a toast. Nothing else does: an action started on a screen reports in that screen's `StatusLine`, and the desktop shell's menu actions switch to Books first.
  - The toasts:
    - folder import finished: `folderImportLine`'s `Status` for the finished import, with the same wording as on Books ("Imported 12 books, 3 already in library, 2 failed"), and a failed scan as an error;
    - a book's indexing failed (`semantic_index_failed`): an error, `Indexing "${title}" failed: ${error}`;
    - the indexing queue emptied after at least one book finished: done, `Chapter search is ready for ${plural(n, "book")}`.
  - `App` state: `toasts: (Status & { id: number })[]` and `notify(status)`. At most 3 show, and a fourth drops the oldest.
  - `Toaster({ toasts, onDismiss, onShow })` renders `<section className="toaster" aria-label="Notifications">`, fixed at the bottom right (`right` and `bottom` `var(--space-6)`, `z-index: 30`, `max-width: 24rem`, a column with `gap: var(--space-2)`).
  - Each `.toast` is a surface card styled like the popovers (border, `--radius`, the popover shadow, `padding: var(--space-3)`). It holds a `StatusLine`, so it's announced, then **Show** (`button-quiet button-sm`, goes to Books, where the full summary and failure list still are) and a dismiss button (`button-quiet button-sm`, `aria-label="Dismiss"`, an `XIcon`).
  - Done and info toasts dismiss themselves after 6 s; error toasts stay until dismissed or shown. Going to Books clears every toast, since its `StatusLine` now has the same news.

## 2. Loading: new `src/useDelayed.ts`, the views, `src/App.css`
- `export function useDelayed(active: boolean, ms = 200): boolean`: true only once `active` has stayed true for `ms`. It uses a `setTimeout` that's cleared when `active` turns false or the component unmounts.
- Skeleton CSS:
  - `.skeleton`: a `display: block` bar, `height: 0.9em`, `border-radius: var(--radius)`, `background: var(--border)`, `animation: skeleton-pulse 1.2s ease-in-out infinite`.
  - `.skeleton-title` is `width: 45%`, `.skeleton-meta` is `width: 25%`, and `.skeleton-line` is `width: 100%`, with the last line of a paragraph at 60%.
  - `.skeleton-row` reuses `.book-row`'s padding and has no hover or pointer.
- Where they go:
  - **Books:** while `books == null` and `useDelayed(true)`, render `<ul className="book-list" aria-busy="true" aria-label="Loading books">` with 3 `.book-row.skeleton-row` items, each holding a title bar and a meta bar. Before 200ms, render nothing, as today.
  - **Home:** while `books == null`, after the delay, the "Your library" section shows 3 skeleton rows in `.home-recent-list`. The cards' `.home-card-detail` already holds its height.
  - **Bookmarks:** `BookmarksView` returns `null` today while `folders` or `annotated` is null. After the delay, it shows the heading and 2 skeleton rows under each section label, inside `aria-busy="true"` lists.
  - **Folder:** `FolderView`'s `passages` starts as `null`, not `[]`. That fixes the "No passages yet" flash. While it's null, the count line is empty, and after the delay there are 2 skeleton `.folder-passage` cards (a meta bar and two lines).
  - **A book's notes:** `BookAnnotationsView`'s `entries` starts as `null` too, with the same skeleton cards.
  - **Reader:** while `content == null`, after the delay, `.reader-text` gets `aria-busy="true"` and 4 skeleton paragraphs (three lines each, in `--text-read` sizing). The sidebar's chapter list shows 6 short skeleton bars while `chapters` is still empty and loading. A `chaptersLoaded` flag tells "loading" apart from a book with no chapters.
  - **Search:** while `searching`, the existing `.results` list gets `aria-busy="true"` and `.results-stale` (`opacity: 0.6`), so the old results dim instead of jumping. No skeleton is needed; the button already says "Searching…".

## 3. Empty states: new `src/EmptyState.tsx`, the views, `src/App.css`
- `EmptyState({ icon, title, children, actions, compact }: { icon?: ReactNode; title?: string; children: ReactNode; actions?: ReactNode; compact?: boolean })` renders `<div className="empty-state">`, with `empty-state-compact` added when `compact`. In order:
  - the icon in `.empty-state-icon` (a 56px bordered square like `.home-card-icon`, `color: var(--accent)`, `aria-hidden`);
  - an `<h2 className="empty-state-title">` in `--font-display` at `--text-lg`;
  - `<p className="empty-state-body">` at `--text-sm`, `--muted`, `max-width: 32em`;
  - `.empty-state-actions`, a `.row`.
- The full style is centred, with `padding: var(--space-10) var(--space-4)`, a `1px dashed var(--border)` border and `var(--radius)`. The compact style is left-aligned, with no border, no icon and `padding: var(--space-3) 0`, for empty cases next to controls that already exist.
- Each case, with its copy:
  - **Books, empty library** (full; `BooksIcon`):
    - Title "Your library is empty". Body: "Import an EPUB or PDF, or a whole folder of them. Pitaka reads each book once and keeps its text on this computer."
    - Actions: **Import book** (`button-primary button-icon`), **Import folder** and **Restore**, calling the same `importBook`, `importFolder` and `restore` with the same `disabled` rules. Before Restore a `<span className="empty-state-or">Moving from another computer?</span>`.
    - While `books?.length === 0`, the import row's own Import book, Import folder, Back up and Restore buttons aren't rendered, so each name appears once. The row and its `StatusLine` stay, so an import in progress still reports.
  - **Books, filter matches nothing** (compact): body `No books match "{filter}".`, action **Clear filter** (secondary). The wording is unchanged.
  - **Home, empty library** (full; `BooksIcon`), in place of "Your library":
    - Title "Welcome to Pitaka". Body: "Import your EPUBs and PDFs to search them, bookmark passages and keep notes. Everything stays on this computer."
    - Action **Go to Books** (`button-primary`), which calls `onNavigate("books")`. Importing stays on the Books screen only.
  - **Bookmarks, no folders** (compact): body "No bookmark folders yet. Create one here, or bookmark a passage while reading." The wording is unchanged; the Create form is right above it.
  - **Bookmarks, no highlights or notes** (compact; `HighlightIcon`): body "Select text while reading to highlight it or add a note." Unchanged.
  - **Folder, empty** (full; `BookmarkIcon`): title "This folder is empty". Body: "Open a book and click the bookmark icon beside a paragraph to add it here."
  - **A book's notes, none left** (full; `HighlightIcon`): title "No highlights or notes left". Body: "Everything in this book was removed. Select text while reading to add more." The count line already says "0 highlights, 0 notes".
  - **Search, no results** (compact), under the unchanged "No results" count line:
    - Passages: "Try fewer or different words." If Exact words is on, it adds " Exact words only matches whole words; turn it off to match other forms." If the search is scoped to a book, it adds an action **Search all books** (`button-quiet`), which calls `onBookIdChange(null)` and searches again.
    - Chapters: "Chapter search matches meaning, so try describing the idea differently."
- Remove `.folder-empty` and `.section-empty` from `App.css`.

## 4. Icons: `package.json`, new `src/icons.tsx`, the views, `src/App.css`
- `npm install --save-exact lucide-react` pins the current release in `package.json` and `package-lock.json`. It's the one new dependency in this plan, approved on 2026-10-12.
- `src/icons.tsx` is the only file that imports from `lucide-react`. The views import the app's names from it, so a Lucide rename (as `Home` became `House`, and `AlertCircle` became `CircleAlert`) is fixed in one place, and every icon gets the same defaults:
  - `function appIcon(Glyph: LucideIcon) { return ({ size = 18, ...rest }: LucideProps) => <Glyph size={size} strokeWidth={1.6} aria-hidden="true" className="icon" {...rest} />; }`
  - Exports and their Lucide sources: `BooksIcon` (`LibraryBig`), `BookmarkIcon` (`Bookmark`), `SearchIcon` (`Search`), `PenIcon` (`PenLine`), `HomeIcon` (`House`), `HighlightIcon` (`Highlighter`), `ImportIcon` (`BookPlus`), `FolderIcon` (`FolderInput`), `BackupIcon` (`Archive`), `RestoreIcon` (`ArchiveRestore`), `CheckIcon` (`Check`), `AlertIcon` (`CircleAlert`) and `XIcon` (`X`). Check each name against the installed version's exports; `tsc` fails on a missing one.
  - A comment at the top gives the rule for later additions: add a Lucide re-export here, never import `lucide-react` elsewhere, and keep the 1.6 stroke.
- Lucide draws `fill="none"`, `stroke="currentColor"` and round caps and joins as attributes. So the four CSS rules that set the stroke style are deleted:
  - `.home-card-icon svg, .search-field svg`;
  - `.reader-search-book svg`;
  - `.bookmark-toggle svg`;
  - `.note-hint svg, .note-toggle svg`.
  - In their place, `.icon { flex-shrink: 0 }`.
  - `.bookmark-toggle.bookmarked .icon` and `.note-hint[aria-expanded="true"] .icon` set `fill: currentColor`, which a CSS rule can do over an SVG attribute.
  - `.note-toggle`'s 13px size moves to `size={13}`.
  - The inline SVGs in `HomeView`'s `ICONS`, the three magnifiers, the reader's bookmark (16×20 today, 18×18 Lucide now) and `ReaderView`'s `PenIcon` are deleted.
- `.button-icon` (`display: inline-flex; align-items: center; gap: var(--space-2)`) is for buttons that start with an icon.
- Where each icon is used:
  - **`NavBar.tsx`:** each tab gets its icon at 16 (Home, Books, Bookmarks & notes, Search), before the label. Accessible names are unchanged, because the SVG is `aria-hidden`.
  - **`HomeView.tsx`:** `ICONS` and `CardIcon` use the exports.
  - **`BooksView.tsx`:**
    - Import book gets `ImportIcon`, Import folder `FolderIcon`, Back up `BackupIcon` and Restore `RestoreIcon`, all with `button-icon`.
    - The filter field uses `SearchIcon`.
  - **`SearchView.tsx`:** the search field uses `SearchIcon`.
  - **`ReaderView.tsx`:** Search this book gets `SearchIcon size={16}` with `button-icon`; the margin bookmark gets `BookmarkIcon`; `note-toggle` and `note-hint` get `PenIcon`.
  - **`StatusLine`:** `CheckIcon` and `AlertIcon` at 14.
  - **`Toaster`:** `XIcon` at 14 on Dismiss.
  - **`EmptyState`:** as listed in §3, at 28.
  - Row actions (Index, Edit, Remove) stay as text. With the quiet style, text is clearer than three small glyphs.

## 5. Motion: `src/App.css`
- Tokens in `:root`: `--motion-fast: 120ms`, `--motion-base: 180ms` and `--ease-out: cubic-bezier(0.2, 0, 0, 1)`.
- Keyframes:
  - `fade-in` (`from { opacity: 0 }`);
  - `pop-in` (`from { opacity: 0; transform: translateY(-4px) scale(0.98) }`);
  - `toolbar-in` (`from { opacity: 0; transform: translate(-50%, calc(-100% - 4px)) }`, ending on the toolbar's own `translate(-50%, calc(-100% - 8px))`);
  - `spin` and `skeleton-pulse` (`50% { opacity: 0.45 }`).
- Applied, all entrance-only:
  - `main.container` and `.reader`: `animation: fade-in var(--motion-fast) var(--ease-out)`, on each screen change. The kept-mounted Search screen replays it when it's un-hidden, because going from `display: none` to shown restarts the animation.
  - `.bookmark-popover` and `.highlight-popover`: `pop-in var(--motion-fast) var(--ease-out)`, with `transform-origin: top left`.
  - `.selection-toolbar`: `toolbar-in var(--motion-fast) var(--ease-out)`.
  - `.note-card`: `pop-in var(--motion-base) var(--ease-out)` when a note opens in the margin.
  - `.empty-state`: `fade-in var(--motion-base)`.
  - `.status-line > span:last-child`: `fade-in var(--motion-fast)`, keyed by the status text (`<span key={status.text}>`) so a new message fades in.
- Opt-out: `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; } }`. The spinner then shows as a still ring with a gap, skeletons stay solid, and the colour transitions that remain (borders, row-action opacity, the reader's flash) don't move anything, so they stay.

## 6. Tests
- **Mock backend** (`src/test/mockBackend.ts`): a new option, `gates?: Partial<Record<string, Promise<unknown>>>`. The command waits on its gate before answering, generalising `importGate`. `renderApp` passes it through.
- **New `src/Feedback.test.tsx`:**
  - `status line shows busy then done`: with `gates: { backup_library: gate }`, click Back up. The `role="status"` line reads "Backing up…" and holds a `.spinner`. Resolve the gate: it reads "Backed up 3 books, …" and holds `svg.icon`, not a spinner.
  - `a failure is an alert`: with `fail: { delete_book: "database is locked" }`, remove a book (confirm). `getByRole("alert")` has text `Remove failed: database is locked` and the class `status-error`.
  - `the live region exists before any message`: on Books, `getAllByRole("status")` includes an empty `.status-line`.
  - `skeleton waits 200ms` (`fakeTimers: true`, `gates: { list_books: gate }`): open Books. After 100ms there's no `[aria-busy="true"]`. At 250ms, `getByLabelText("Loading books")` has 3 `.skeleton-row`s. Resolve the gate: the skeleton is gone and the book rows are there.
  - `an empty folder doesn't flash before loading` (`gates: { list_folder_bookmarks: gate }`): open a folder with passages. "This folder is empty" never appears before the gate resolves; afterwards, its passages are listed.
  - `a folder import finishing elsewhere shows a toast` (`fakeTimers`, `importGate`): start Import folder, go to Search, open the gate. The "Notifications" region holds "Imported 3 books…"; **Show** goes to Books and clears it. Repeated without Show, it's gone after 6 s.
  - `an error toast stays`: with `fail: { find_books: "permission denied" }`, start Import folder, go to Home. The toast is a `role="alert"` and is still there after 10 s; Dismiss removes it.
  - `no toast while Books is showing`: the same import finishing on Books adds no toast, and the summary is in the import row's `StatusLine`.
  - `indexing toasts` (the `semantic` option): queue two books, go to Search. A `semantic_index_failed` event for one shows `Indexing "…" failed: …`; the other finishing shows "Chapter search is ready for 1 book".
  - `reader shows skeleton paragraphs while a chapter loads` (`fakeTimers`, `gates: { get_chapter_content: gate }`): after 250ms, `.reader-text` has `aria-busy="true"` and 4 `.skeleton` paragraphs.
- **`src/Books.test.tsx`:**
  - Empty library (`books: []`): the heading "Your library is empty", and exactly one button each named Import book, Import folder and Restore. Back up is absent. Clicking Import book still calls `import_book`.
  - `No books match "zzz".` and Clear filter are unchanged.
- **`src/Home.test.tsx:90`:** the assertion becomes the heading "Welcome to Pitaka". Clicking **Go to Books** shows the Books screen.
- **`src/Bookmarks.test.tsx:51`, `:190`:** the text is unchanged and should pass as is; confirm they do.
- **`src/Search.test.tsx`:** after a search with no results: "No results", then "Try fewer or different words.". Scoped to a book, **Search all books** calls `search_library` without a `bookId`. With Exact words on, the extra sentence shows.
- **`src/Backup.test.tsx`:** the new-install case. With `books: []`, Restore is in the empty state and restores, and the list shows the fixture books afterwards.
- **`src/styles.test.ts`** (from the type and button pass), three new checks:
  - every `animation` value uses `--motion-*` or the `spin`/`skeleton-pulse` loops;
  - `App.css` contains the reduced-motion block with `animation: none !important`;
  - no rule other than `.icon` sets `stroke` on an `svg`.
- **New `src/icons.test.tsx`:** each export renders an `svg.icon` with `viewBox="0 0 24 24"`, `aria-hidden="true"`, `width="18"` by default (and `16` with `size={16}`) and `stroke-width="1.6"`. A source check fails if any file other than `src/icons.tsx` imports `lucide-react`.
- **The rest:** run the whole `npm test`. The status wording didn't change, so the existing `findByText` assertions should pass. `src/Demo.test.tsx`'s chapter-list `className` check isn't affected.

## 7. README
- "What's actually verified", frontend tests paragraph, add:
  - statuses are announced (`role="status"`/`"alert"`), with busy, done and error states;
  - skeletons appear only after 200ms;
  - the folder and book-notes screens no longer flash their empty state;
  - the new-install empty state offers Restore;
  - motion is entrance-only and turned off under `prefers-reduced-motion`;
  - icons are Lucide's, re-exported from `src/icons.tsx`;
  - background work that finishes on another screen raises a toast;
  - all covered by `Feedback.test.tsx` and the updated tests, plus whatever was checked in the browser.
- Project structure: add `StatusLine.tsx`, `Toaster.tsx`, `EmptyState.tsx`, `icons.tsx` and `useDelayed.ts` under `src/`.
- "How it's built": the frontend's one npm addition, `lucide-react`, imported only through `src/icons.tsx`.
- Roadmap: add and tick "Status lines and toasts, loading and empty states, entrance motion and a shared icon set", under the Paper item and its type and button follow-up.
- `CLAUDE.md` Frontend bullet: "Report outcomes with `StatusLine` (toasts only for background work finishing on another screen), an empty list with `EmptyState`, and take icons from `src/icons.tsx`, which alone imports `lucide-react`."
- Per the site-copy memory, `site/` doesn't change. The demo picks up the new look on merge.

## Verification
1. `npx tsc --noEmit`, `npm test`, `npm run format:check`, plus the usual `cargo test` and clippy. There are no Rust changes.
2. In `npm run dev:mock` (Chrome), in light and dark:
   - every status (import, backup, restore, remove and edit, each succeeding and failing via the mock's `fail` option);
   - the skeletons, slowed with DevTools' CPU throttling or a temporary gate;
   - each empty state, an empty folder, and a search with no results, both scoped and with Exact words;
   - popovers, the toolbar and note cards opening;
   - a folder import finishing while on Search, as a toast, and its Show.
3. The same with DevTools' "Emulate CSS prefers-reduced-motion: reduce": nothing animates, and the spinner is a still ring.
4. VoiceOver or Orca reading a status and an error, if one is to hand. Otherwise note it as unchecked.
5. `npm run tauri dev`: the first-launch empty library with `XDG_DATA_HOME` pointed at an empty folder, Restore from it, and the motion in WebKitGTK.
