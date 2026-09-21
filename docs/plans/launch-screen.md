# Launch screen

## Context
Everything outside the reader is on one page. `LibraryView` stacks import and the book list, bookmark folders, and search, so the page gets longer with every feature, and a new user sees all three areas at once without being told where to start. This change adds a home screen that the app opens on. It has three cards: **Books**, **Bookmarks** and **Search**. Each card opens its own screen, and a slim header lets you move between screens. It isn't a README roadmap item. It's a UX change that the next features (highlights, notes, export) will need, because each of them wants its own screen.

Decisions agreed before planning:
- The app always opens on home. It doesn't remember the last screen, which isn't worth the extra state.
- Each section screen has a header with `Home · Books · Bookmarks · Search`, so going from a search hit to your bookmarks doesn't mean going back through home.
- The reader's back button returns to where the book was opened from: `← Books`, `← Search results` or `← <folder name>`. Today it always says `← Library`.
- The search query and results survive leaving the Search screen, not just a trip into the reader.
- There's no search box on home. Search is reached by its card.

Out of scope: keyboard shortcuts (e.g. Ctrl+F for Search), restyling beyond the home cards and header, and restoring scroll position in a list after returning from the reader (it isn't restored today either). No Rust, `types.ts` or fixture changes: every count the home screen shows comes from `list_books` and `list_bookmark_folders`, which already return `bookmark_count`. A router was ruled out by the project rules. Plain `useState` for the current screen is enough for four screens.

Checked in the mock (`src/test/mockBackend.ts`): `search_library` filters its fixture hits to books still in the library. So a search that's re-run after a book is removed drops that book's hits there, the same way the real FTS query does.

## 1. Screens and navigation: `src/App.tsx`, new `src/NavBar.tsx`
- `type Screen = "home" | "books" | "bookmarks" | "search"`, held in `useState<Screen>("home")` in `App`.
- `ReaderTarget` gains `backLabel: string`. `App` sets it where it opens the reader: `"← Books"` from a book row, `"← Search results"` from a hit, and `` `← ${folder.name}` `` from a folder passage. Closing the reader only clears `reader`, and `screen` is untouched while reading, so you land back where you started.
- `App` also owns `openFolderId: number | null`, moved up from `LibraryView`. That way the open folder survives the reader, which unmounts `BookmarksView`. Navigating to Bookmarks from home or the header resets it to `null`, so the Bookmarks link always shows the folder list.
- `App` owns `libraryVersion: number`, which is bumped by `BooksView` after a successful import or remove (see §4).
- Mounting: `SearchView` is always mounted and hidden with `hidden={screen !== "search" || reader != null}`, the same trick `LibraryView` uses today, so its state survives. Home, Books and Bookmarks mount only while they're shown and refetch on mount. The `active` props on those views go away, because remounting does their refresh.
- `NavBar({ current, onNavigate })` renders a `<nav aria-label="Sections">` containing four `<button>`s: `Home`, `Books`, `Bookmarks`, `Search`. The current one gets `aria-current="page"`. It's shown above every section screen, including an open folder, and not on home or in the reader.

## 2. Home: new `src/HomeView.tsx`
- Props: `onNavigate(screen)`. On mount it fetches `list_books` and `list_bookmark_folders` in parallel.
- The `<h1>Pitaka</h1>` is followed by three card `<button>`s, each with a title and one line of detail:
  - **Books**: `2 books` / `1 book`, or `Import your first EPUB` when the library is empty.
  - **Bookmarks**: `1 folder · 2 passages` (the passages are the sum of `bookmark_count`), or `No folders yet`.
  - **Search**: `Search across 2 books`. It's `disabled` with the line `Import a book to search` once the library has loaded and is empty. While the counts are loading, the detail lines are blank and nothing is disabled, so the cards don't flash.
- On failure it shows `Loading library failed: <err>` or `Loading bookmark folders failed: <err>` under the cards, and the cards stay usable.
- The Search link in the header stays enabled with an empty library. The screen works, it just finds nothing.

## 3. Books: new `src/BooksView.tsx` (from `LibraryView.tsx`)
- Moves over unchanged: `importBook`, `removeBook`, the `Import EPUB…` button, the status line and the book list with Remove.
- It gets an `<h1>Books</h1>`, plus props `onOpenBook(bookId)` and `onLibraryChanged()`. The latter is called after an import that added a book (`already_imported: false`) and after a successful remove.
- Removing a book no longer touches search results directly. §4 handles that.
- An empty library shows `No books yet. Import an EPUB to start.`

## 4. Search: new `src/SearchView.tsx` (from `LibraryView.tsx`)
- Moves over unchanged: `query`, `results`, `searching`, `exactWords`, `runSearch`, `toggleExactWords`, the form and the results list. It gets an `<h1>Search</h1>` and a status line for `Search failed: <err>`.
- Props: `active`, `libraryVersion`, `onOpenResult(result)`.
- It keeps the last search it actually ran, `{ query, exact, version }`, in a `useRef`. When `active` becomes true and `libraryVersion` differs from the stored version, it re-runs that search, so hits in a removed book disappear and a newly imported book's hits appear. The re-run uses the stored query, not whatever is in the box now. Returning from the reader with no library change doesn't re-run anything.
- When `active` becomes true it focuses the query input through a ref.

## 5. Bookmarks: new `src/BookmarksView.tsx` (from `LibraryView.tsx`), `src/FolderView.tsx`
- Moves over: `folders`, `newFolderName`, `refreshFolders`, `createFolder`, the folder list, the empty-state copy and the create form. It gets an `<h1>Bookmarks</h1>` and its own status line for `Loading bookmark folders failed: <err>` and `Creating folder failed: <err>`.
- Props: `openFolderId`, `onOpenFolder(id | null)` and `onOpenBookmark(bookmark, folder)`. The folder is passed so `App` can build the back label. When `openFolderId` matches a loaded folder, it renders `FolderView` instead of the list.
- `FolderView`: the back button becomes `← Bookmarks`, and the `active` prop is dropped because it now remounts after the reader. Otherwise it's unchanged.

## 6. Reader: `src/ReaderView.tsx`
- A new `backLabel: string` prop replaces the hard-coded `← Library`. The button gets the class `reader-back`, which ellipsizes a long folder name inside the sidebar.

## 7. Styles: `src/App.css`
- `.app-nav`: a row of plain buttons along the top of `.container`, with a bottom border. `[aria-current="page"]` is shown bold and underlined.
- `.home`: a three-column grid of `.home-card` buttons, collapsing to one column below 600px. Each card has a large title (`.home-card-title`) and a muted detail line (`.home-card-detail`, the same colour as `.book-meta`). `:disabled` cards are shown at reduced opacity.
- `.reader-back`: `max-width: 100%`, `overflow: hidden`, `text-overflow: ellipsis`, `white-space: nowrap`.
- `.folders h2` becomes unused once Bookmarks has an `h1` and is removed.
- `LibraryView.tsx` is deleted.

## 8. Tests: `src/*.test.tsx`, `src/test/renderApp.tsx`
- `renderApp.tsx` gains `goTo(user, section)`. If the `Sections` nav is present it clicks that button, and otherwise it clicks the home card whose name starts with `section`.
- New `Home.test.tsx`:
  - The app opens on home: the cards read `2 books`, `1 folder · 2 passages` and `Search across 2 books`, and there's no `Sections` nav and no `.reader`.
  - Each card opens its screen (its `h1`) with the matching header button marked `aria-current="page"`, and `Home` goes back to the cards.
  - Empty library: remove both books in Books, then go Home. The Books card reads `Import your first EPUB`, the Search card is disabled with `Import a book to search`, and Bookmarks reads `1 folder · 0 passages`, since the folder outlives its passages.
  - With `fail: { list_books: "database is locked" }`, it shows `Loading library failed: database is locked`.
- `LibraryView.test.tsx` is split into two files:
  - `Books.test.tsx` takes the import, remove and load-error tests, each starting with `goTo(user, "Books")`. It also adds "opens a book and comes back to Books", which clicks `← Books` and checks the `Books` heading.
  - `Search.test.tsx` takes the two search tests and the search-error test, plus:
    - "keeps the search when leaving and coming back": search `neural networks`, go Home, then Search. The input still holds the query, there are 2 results, and `search_library` was called once.
    - "re-runs the search after a book is removed": search `neural networks`, remove *Test Book of Research* in Books, then go back to Search. There are 0 results and `search_library` was called twice with the same arguments.
    - "focuses the search box when opened": `document.activeElement` is the query input.
    - The back-to-results test moves here from `ReaderView.test.tsx`, clicking `← Search results`.
- `ReaderView.test.tsx`: open books via `goTo(user, "Books")` and hits via `goTo(user, "Search")`. Otherwise the assertions are unchanged.
- `Bookmarks.test.tsx`: each test starts with `goTo(user, "Bookmarks")`, or with Books when it opens the long book. The passage round trip clicks `← Know your limit - Oct 10 2026` and still expects the folder heading. It also adds "the Bookmarks header button leaves an open folder": open the folder, click `Bookmarks` in the nav, and the folder list is shown.

## 9. README
- "What's actually verified", frontend bullets: replace the `LibraryView.tsx` bullet with `HomeView.tsx` (cards with counts, empty states), `BooksView.tsx`, `SearchView.tsx` (kept across screens, re-run after the library changes) and `BookmarksView.tsx`/`FolderView.tsx`, plus the `NavBar.tsx` header. In the `ReaderView.tsx` bullet, the back button returns to where the book was opened. Add home and navigation to the list of what the frontend tests cover.
- Roadmap, Done: add `- [x] Launch screen with separate Books, Bookmarks and Search screens`.
- Known limitations: no change.

## Verification
1. `npm test` and `npx tsc --noEmit`.
2. `cargo clippy --workspace --all-targets` and `cargo test -p ebook_research_core`. These should be unchanged, since no Rust is touched.
3. `npm run dev:mock` in Chrome: screenshot home, each screen, the empty-library home, and the reader's back label from a folder with a long name. Check that the cards collapse at a narrow width.
4. Say whether the Tauri window was clicked through (`npm run tauri dev`).

## Implementation notes (differences from this plan)
- `BookmarksView` holds `folders` as `null` until loaded and renders nothing meanwhile, so returning from the reader to an open folder doesn't flash the folder list. A load error still renders so it can be shown.
- `BooksView` also shows `No books yet. Import an EPUB to start.` for an empty library, and `.folders-empty` became a shared `.section-empty`.
- The test helper `search()` clicks the submit button inside the search form, because the header now has a `Search` button too.
- Verification: `npm test` (42 tests), `tsc`, clippy and core tests pass. In Chrome against the mocks: home cards with counts, Search autofocus, a hit opening with `← Search results` and returning with the search kept, a folder passage with the long folder name ellipsized in `← Know your limit - Oct 1…` and returning to the folder. The narrow-width collapse of the cards wasn't checked, because the browser window couldn't be resized. The Tauri window hasn't been clicked through.
