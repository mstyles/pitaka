# Filter and sort the Books screen

## Context
With a real library imported (53 books from `~/Documents/books`, 41 of them by Thich Nhat Hanh) the Books screen is a long, unsorted-looking list: `list_books` orders by `added_at DESC, id DESC`, so a folder import comes out in file-name order, newest import first. Finding one title means scrolling and reading every row. This adds a filter box above the list that narrows it by title and author as you type, and sorts the list by title, with a toggle back to newest first.

It's frontend only. `BooksView` already holds every `BookSummary` (title, author, counts) from `list_books`, and even a few hundred books filter instantly in the browser, so no new command, query or index is needed. Sorting is done there too, so `list_books` keeps its order and the Home screen's recent books, which rely on it, are untouched.

Out of scope: sorting by author, filtering by index state or format, and searching inside books, which is what the Search screen is for. A server-side `list_books(filter)` was ruled out: it would add a round trip per keystroke and a fixture route for no gain at this size. FTS5 over titles was ruled out for the same reason.

## 1. Matching: `src/BooksView.tsx`
- `export function matchesFilter(book: BookSummary, filter: string): boolean`, next to `plural`.
- Normalise both sides with `fold(s) = s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()`, so case and diacritics don't matter ("thich" matches "Thích", "nibbana" matches "Nibbāna").
- Split the folded filter on whitespace; a book matches when every word appears somewhere in `fold(title + " " + author)`. Words in any order, so "nhat hanh heart" finds *The Heart of the Buddha's Teaching* whose author is stored as "Hanh, Thich Nhat". Substring, not whole-word, so "medit" matches as you type.
- A missing title or author is matched as "Untitled" / "Unknown author", the text the row shows, so what you see is what you can filter on.
- An empty or all-whitespace filter matches everything.

## 2. Sorting: `src/BooksView.tsx`
- `export type BookSort = "title" | "added"` and `export function sortBooks(books: BookSummary[], sort: BookSort): BookSummary[]`, returning a new array. `"added"` keeps `list_books`' order.
- `"title"` compares `titleKey(title)` with `new Intl.Collator(undefined, { sensitivity: "base", numeric: true })`, so case and accents don't split the order and "Book 10" follows "Book 9".
- `titleKey` drops a leading "The ", "A " or "An " (case-insensitive), as library catalogues do, so *The Heart of Understanding* files under H rather than with the 10 other "The …" titles. The row still shows the full title.
- Untitled books sort last. Ties fall back to author, then `id`, so the order is stable.

## 3. State: `src/App.tsx`
- `const [bookFilter, setBookFilter] = useState("")` and `const [bookSort, setBookSort] = useState<BookSort>("title")` in `App`, passed to `BooksView` as `filter` / `onFilterChange` and `sort` / `onSortChange`. `BooksView` is remounted on every visit, including the return from the reader, and the usual flow is filter → open a book → "← Books"; keeping the filter in `App` means you come back to the same short list. This is the same choice `SearchView` makes for its query.
- Neither is saved across app restarts; the sort starts on Title.

## 4. UI: `src/BooksView.tsx`, `src/App.css`
- Between the import/index rows and the list, when `books` is non-empty: a `.search-field` (same magnifier SVG and styles as `SearchView`) holding `<input type="search" aria-label="Filter books" placeholder="Filter by title or author…">`. Shown for any library size; a two-book library gets a box it doesn't need, but a threshold would make it appear and disappear as books are added or removed.
- Beside the box, a `.scope-toggle` (the Search screen's two-button control) labelled `Sort:` with **Title** and **Recently added**, `aria-pressed` on the chosen one.
- `shown = sortBooks(books.filter((b) => matchesFilter(b, filter)), sort)`, rendered in place of `books` in the `<ul className="book-list">`.
- While the filter is non-empty, a `.status` line under the box: `Showing ${shown.length} of ${plural(books.length, "book")}`.
- No matches: `<p className="section-empty">No books match "{filter.trim()}".</p>` with a `Clear filter` button, in place of the list.
- Escape in the box clears it (`onKeyDown`). `type="search"` gives the native clear × in WebKitGTK and WebView2.
- The filter doesn't change what the buttons act on: **Index all books** still queues every unindexed book in the library, not only the shown ones, and `indexingLine` still looks titles up in the full `books`. Remove on a filtered row works as now, and the refreshed list is filtered again.
- `.books-filter { margin-top: 1em; }` on the field's wrapper, and give the input `max-width: 28em` so it doesn't span a wide window. No new colour tokens.

## 5. Tests
- `src/Books.test.tsx`, against the two fixture books ("Test Book of Research" by A. Tester, "A Long Book for Scrolling" by Fixture Author):
  - typing `research` shows only Test Book of Research and the line "Showing 1 of 2 books";
  - typing `fixture` (author only) shows only A Long Book for Scrolling;
  - typing `tester book` (words from author and title, out of order) shows Test Book of Research;
  - typing `zzz` shows `No books match "zzz".`, and clicking Clear filter brings both books back and empties the box;
  - Escape in the box clears it;
  - the filter survives opening a book and clicking "← Books";
  - the list is in title order by default (A Long Book for Scrolling, then Test Book of Research, the reverse of `list_books`' order), and Recently added restores `list_books`' order.
- `src/BooksView.test.ts` (unit, no rendering): `matchesFilter` folds case and diacritics (`"nibbana"` matches title "Nibbāna Sermons"), a null author matches `"unknown"`, and `"   "` matches everything; `sortBooks` files "The Zen Book" under Z, puts "Book 10" after "Book 9", "éclair" between "Eagle" and "Echo", and an untitled book last.
- No core or fixture changes, so `ui_fixtures_are_current` is untouched.

## 6. README
- "What's actually verified": a line for the Books filter saying it's covered by `Books.test.tsx` and checked in `npm run dev:mock` (and, once done, in the Tauri window against the 53-book library).
- Roadmap: add and tick "Filter the Books screen by title or author, and sort it by title".

## Verification
1. `npm test` and `npx tsc --noEmit`.
2. `npm run dev:mock`: type in the box, clear it with Escape and with the button, switch the sort, open a book and come back.
3. `npm run tauri dev` against the real library: "thich" narrows to the 41 Thich Nhat Hanh books (counting "Hanh, Thich Nhat"), "how to" to the eight *How to* books, "buddhist" to the PDF.
