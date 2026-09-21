# Paper visual style

## Context
Most of the styling is still the create-tauri-app starter: Inter, blue hover borders, a shadow on every button, about 15 hard-coded colours with a dark mode that patches only some of them, and headings centred over left-aligned lists at three different widths. Nothing gives the app a look of its own, and the reader, where most time is spent, uses the same sans-serif as the buttons. This change adopts direction A, "Paper", from the style mockups (https://claude.ai/artifact/M85r9QJK6jR4Bzn5xwRB7X). It has a cream background, a burnt-saffron accent, Fraunces for headings, Literata for reading and Source Sans 3 for controls. It isn't a README roadmap item.

Decisions agreed before planning:
- The fonts are bundled as woff2 files. There's no npm dependency and no Google Fonts request, so they look the same on every machine and work offline.
- Home gains a "Your library" list of the 3 most recently imported books, under the cards.
- Dark mode is a dark Paper variant that follows the system theme, as now.
- Paragraph numbers in the reader were ruled out.
- The app icon is the basket concept from the same canvas: a woven cream bowl on a saffron rounded square. *Piṭaka* means "basket", and it still reads at 16px.

Out of scope:
- Chapter titles in search results. The meta line still says "chapter N" from the 0-based `chapter_idx`. It needs `chapter_title` on `SearchResult` in Rust and regenerated fixtures, so it's a separate `fix/` branch.
- Italic font files. The reader drops inline formatting (limitation 3), so there's nothing to set in italics yet.
- A manual light/dark switch.

Checked:
- The fonts come from fontsource 5.3.0 (`@fontsource-variable/*` on jsdelivr), and each is under the SIL Open Font License 1.1. The OFL allows bundling as long as the licence text goes with the fonts.
- The latin-ext files cover `U+0100-017F` and `U+1E00-1E9F`, so Pali diacritics (ā ī ū ṃ ṭ ḍ ṅ ṇ ḷ ñ) render in the bundled faces rather than a fallback.
- `list_books` already orders by `added_at DESC, id DESC`, so the 3 most recent books are its first 3 rows. No Rust change is needed.

## 1. Fonts: new `src/assets/fonts/`, new `src/fonts.css`, `src/main.tsx`
- The files, latin and latin-ext subsets only, at about 310 KB in total:
  - `fraunces-latin{,-ext}-opsz-normal.woff2` (opsz + wght axes, because headings run from 18 to 56px)
  - `literata-latin{,-ext}-wght-normal.woff2`
  - `source-sans-3-latin{,-ext}-wght-normal.woff2`
- Each font's licence is committed next to its files as `OFL-Fraunces.txt`, `OFL-Literata.txt` and `OFL-SourceSans3.txt`, copied from each package's `LICENSE`.
- `src/fonts.css` has six `@font-face` rules copied from fontsource's CSS, keeping the `unicode-range` and `font-display: swap`, and pointing at the files with relative `url()`s so Vite fingerprints and bundles them. The families are `"Fraunces"`, `"Literata"` and `"Source Sans 3"`.
- `main.tsx` imports `./fonts.css` before `App`.

## 2. Tokens and base styles: `src/App.css`
- `:root` defines every colour and shape once:
  - `--bg: #F6F1E7`, `--surface: #FFFCF6`, `--text: #2A241D`, `--muted: #6B6152`, `--border: #E2D8C5`
  - `--accent: #9A4A1C`, `--on-accent: #FFFCF6`, `--danger: #A33A2B`
  - `--mark: #F2D8A2`, `--flash: rgba(214, 160, 60, 0.22)`
  - `--radius: 6px`, `--content: 880px`
  - `--font-display`, `--font-read` and `--font-ui` stacks (Fraunces / Literata / Source Sans 3, each falling back to Georgia or system-ui)
- `@media (prefers-color-scheme: dark)` only redefines the colour variables:
  - `--bg: #1C1814`, `--surface: #25201A`, `--text: #EDE4D3`, `--muted: #B0A48F`, `--border: #3A3228`
  - `--accent: #E0995E`, `--on-accent: #1C1814`, `--danger: #E07A67`
  - `--mark: rgba(224, 153, 94, 0.35)`, `--flash: rgba(224, 153, 94, 0.16)`

  The existing per-rule dark overrides (`.bookmark-popover`, `.bookmark-toggle.bookmarked`, `a:hover`, inputs and buttons) are deleted. Every other rule reads the variables.
- Contrast was checked against WCAG AA: `--muted` on `--bg` is about 5.5:1 in light and 7:1 in dark, and `--accent` on `--bg` is about 6:1. It will be rechecked with the final values in the browser pass.
- Base styles:
  - `body` uses `--font-ui` on `--bg`.
  - `h1` and `h2` use `--font-display` at weight 600 and are left-aligned. The centred `h1` rule goes.
  - `.container` becomes a left-aligned column `max-width: var(--content)`, centred with `margin: 0 auto`, with `padding: 48px 24px`. The 10vh top padding goes.
- Buttons:
  - The default is flat: `1px solid var(--border)` on `--surface`, no shadow, `min-height: 40px`, with the hover border in `--accent`.
  - `.button-primary` fills with `--accent`, using `--on-accent` text.
  - `.button-danger` uses `--danger` text and border.
  - Inputs use the same border and radius, with a `--accent` focus ring (`outline: 2px solid` and an offset) in place of today's `outline: none`, so keyboard focus is visible.
- The unused `a` rules (`#646cff`) go.

## 3. Header: `src/NavBar.tsx`, `App.css`
- A "Pitaka" wordmark (`--font-display`, 20px) sits on the left, with the four buttons on the right. The bar is 64px high on `--surface` with a bottom border, full width, and its content is padded to line up with `.container`.
- The buttons are text-only in `--muted`. The current one is `--text` at weight 600 with a 2px `--accent` bottom border, so the bold-and-underline rule goes.

## 4. Home: `src/HomeView.tsx`, `src/App.tsx`, `App.css`
- The cards are left-aligned, each with an icon tile (a 44px bordered square in `--accent`, holding an inline stroke SVG of a book, a bookmark or a magnifier with `aria-hidden`), a Fraunces title and the detail line in `--muted`. They sit on `--surface` with a border and no shadow. The `h1` "Pitaka" is centred here only, at 56px.
- "Your library" is a small uppercase `--muted` label followed by up to 3 rows from `books.slice(0, 3)`. Each row is a `<button>` showing the title in `--font-read` and `author · N chapters` in `--muted`. Clicking a row opens the reader. The section is hidden while loading, and hidden when the library is empty.
- New prop `onOpenBook(bookId)`. `App` opens the reader with `backLabel: "← Home"`, and closing the reader returns to home because `screen` is still `"home"`.

## 5. Section screens: `BooksView.tsx`, `SearchView.tsx`, `BookmarksView.tsx`, `FolderView.tsx`, `App.css`
- All four use one `.container` width and left-aligned `h1`s. `.book-list`, `.results` and `.folders` lose their own `max-width` and centring.
- Books:
  - `Import EPUB…` gets `button-primary`.
  - The rows are bordered list rows, with the title in `--font-read`.
  - `Remove` is hidden (`opacity: 0`) until the row is hovered or has `:focus-within`, so it still shows for keyboard users. The same goes for the folder passages' `Remove`.
- Search:
  - The input sits in a bordered field with a leading magnifier icon.
  - `Search` gets `button-primary`.
  - After a search has run, a `--muted` line under the form says `N results` or `No results`.
  - Each result is a `--surface` card: `<b>{book_title}</b> · chapter {chapter_idx}` in `--muted`, then the snippet in `--font-read` with `<mark>` in `--mark`.
- Bookmarks and folders:
  - `Create` gets `button-primary`.
  - The folder's `Delete` gets `button-danger`.
  - The passages use `--font-read`.

## 6. Reader: `src/ReaderView.tsx`, `src/BookmarkPopover.tsx` (CSS only), `App.css`
- The sidebar is 272px on `--surface`. It shows the back button, then the book's title (`--font-display`, 18px) and author (`--muted`, 13px). Then comes the chapter list, where the active chapter gets a `--bg` fill and weight 600.
- For the title and author, `ReaderView` calls `list_books` once on mount and picks its `bookId`. Search results and bookmarks don't carry the author, so passing it in from `App` won't work. If the call fails, the header is simply left out, because the chapter error line already covers a broken backend.
- The text column is `max-width: 640px`, in `--font-read` at 19px with `line-height: 1.75`.
- The flash uses `--flash`, and the filled bookmark icon and the popover use `--accent`, `--surface` and `--border`.

## 7. App icon and favicon: new `src-tauri/icons/app-icon.svg`, `src-tauri/icons/*`, `index.html`, `public/`
- The source is `src-tauri/icons/app-icon.svg` (1024×1024 viewBox): a `#9A4A1C` rounded square (`rx="200"`), a `#F6F1E7` bowl with a `#F2D8A2` rim and a `#7A3A15` interior, and `#C9A77A` weave lines clipped to the bowl.
- `npx tauri icon src-tauri/icons/app-icon.svg` regenerates the files already in `src-tauri/icons/`: `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico`, `icon.png` and the `Square*Logo.png`/`StoreLogo.png` set. The `android/`, `ios/` and `64x64.png` outputs it also writes are deleted, since this is a desktop app and `tauri.conf.json`'s `bundle.icon` list is unchanged.
- The favicon becomes `public/favicon.svg`, a copy of the source, linked in `index.html` with `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`. The unused `public/vite.svg` and `public/tauri.svg` are deleted.

## 8. Tests: `src/*.test.tsx`
The styling doesn't change any role or text the existing tests query, so they stay as they are apart from the additions below.
- `Home.test.tsx`:
  - "lists the most recent books": the Your library rows read `A Long Book for Scrolling` then `Test Book of Research`, in `list_books` order, with `Fixture Author · 3 chapters` on the first.
  - "opens a book from home and comes back": click the row, check `get_book_chapters` was called with `{ bookId: 2 }`, click `← Home`, and the `Pitaka` heading is back.
  - The empty-library test also checks that the `Your library` label is gone.
- `ReaderView.test.tsx`: "shows the book's title and author in the sidebar" checks for `A Long Book for Scrolling` and `Fixture Author` inside the `Chapters` nav.
- `Search.test.tsx`: after searching `neural networks` it shows `2 results`, and after `zzzz` it shows `No results`. There's already a `stemmed:zzzz` fixture.
- The mock returns only 2 books, so the 3-book limit isn't exercised by a test. It's `slice(0, 3)` on an already-ordered list, and the browser check covers the rest.

## 9. README
- "What's actually verified":
  - The `HomeView.tsx` bullet gains the recent-books list.
  - The `ReaderView.tsx` bullet gains the sidebar's title and author.
  - A new line for `src/fonts.css`: bundled OFL fonts, latin and latin-ext, with Pali diacritics covered.
- The project tree gains `fonts.css` and `assets/fonts/`.
- Roadmap, Done: `- [x] Paper visual style: bundled serif fonts, colour tokens with a matching dark mode`.

## Verification
1. `npm test`, `npx tsc --noEmit`, `cargo clippy --workspace --all-targets` and `cargo test -p ebook_research_core`.
2. `npm run build`, checking that the six woff2 files are emitted under `dist/assets/`.
3. `npm run dev:mock` in Chrome: screenshot home, Books, Search with results, a folder and the reader, in both light and dark (toggled with DevTools' `prefers-color-scheme` emulation, or by asking you if that isn't available). Check that the fonts loaded (`document.fonts.check`) and measure the contrast of the muted text.
4. Say whether the Tauri window was checked. Its WebKitGTK engine is where font rendering on Linux can differ, and it's the only place the new window and taskbar icon show.
