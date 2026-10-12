# Book covers

## Context
Every book in Pitaka is a line of text. The Books screen and Home's "Your library" list show a title and an author, so finding a book in a 54-book library means reading the list, where a shelf would let you spot the cover. Almost every EPUB has a cover image: all 52 in the real library do. Pitaka ignores it, and `parse_opf` doesn't read `<meta name="cover">` at all. This is the "covers" item from the polish suggestions. It isn't a README roadmap item.

This plan does three things:
- It takes each book's cover at import, and adds covers to the books already in the library.
- It draws a typographic cover for books that have none.
- It shows covers as thumbnails on the Books screen (with a new Grid view) and on Home's recent list.

Build it after `docs/plans/type-spacing-and-buttons.md`, which supplies the `--text-*`/`--space-*` tokens and button styles used here, and after PRs #42 and #43. The Edit form from #42 has to work in the grid. Backups from #43 include the covers, because covers are stored in the library.

Out of scope:
- **Rendering a PDF's first page.** Neither `pdf-extract` nor `lopdf` can rasterise a page. That needs a new crate: `pdfium-render`, which also needs a pdfium binary shipped for each platform, or a pure-Rust renderer like `hayro`. You chose generated covers for now (2026-10-12): a PDF gets its page-1 JPEG when it has one (§2), and otherwise a generated cover. Rendering stays an unticked roadmap item, to revisit if PDFs become common.
- **The reader's sidebar**, the Search picker, bookmark folders, and choosing or uploading a cover by hand. The `book_covers` table leaves room for all of these later.
- **GIF, WebP and SVG covers.** None of the 52 EPUBs uses one (46 JPEG, 6 PNG). Such a book gets a generated cover.

Ruled out:
- **Storing the original image.** The 52 originals total 29.5 MB (median 222 KB, p90 1.2 MB, largest 3.3 MB). The whole library is 31 MB, so this would nearly double it, and every backup with it, since JPEG doesn't deflate. Displaying originals as 32px thumbnails would also make WebKit decode up to 1588×2528 pixels (16 MB) per row. Keeping only originals under 512 KB, with no new crate, was the other option: 36 of the 52 books would get covers and the library would grow about 6 MB. You chose the `image` crate and thumbnails instead.
- **Files in the app data folder.** A backup wouldn't include them, removing a book would leave them behind, and restoring would mismatch them.
- **A `cover` BLOB column on `books`.** `SELECT *` isn't used today, but a separate table keeps the image bytes out of `list_books`'s join and lets `ON DELETE CASCADE` remove a book's cover with it.
- **A command returning base64 or a `data:` URL.** The CSP's `img-src 'self'` blocks `data:` (deliberately, README §"Content Security Policy"). It would also send every cover through JSON on each `list_books`. A `blob:` URL from the bytes would need `blob:` added to the CSP and manual `revokeObjectURL` bookkeeping.
- **Tauri's built-in `asset:` protocol.** It serves files on disk by path, and the covers live in SQLite.
- **Colouring generated covers by a hash of the title.** Editing a title (#42) would then change the colour. `file_hash` isn't in `BookSummary`. Colour comes from `id`, which survives edits and restores, and gives neighbouring books in the grid different colours.

Checked:
- A Python `zipfile`/`ElementTree` survey of the real library's 52 EPUBs, read-only:
  - 23 mark the cover with EPUB 3 `properties="cover-image"`.
  - All 52 have a usable EPUB 2 `<meta name="cover" content="{manifest id}">` pointing at an `image/*` item.
  - The first spine item's `<img src>` or SVG `<image xlink:href>` gives the same file in all 52.
  - Formats: 46 JPEG and 6 PNG, none with alpha. Median size 579×900, smallest 428×662, largest 1588×2528.
- `ebook_research_core/test.epub` has no image at all (manifest: two chapters, NCX, nav), so it gets a generated cover.
- Thumbnails made with Pillow, fit within 300×450 (2× the grid card, for HiDPI screens) and saved as JPEG quality 80: median 20 KB, largest 44 KB, 1.0 MB for all 52. That's what the library and its backups grow by.
- PDFs, with `pdfimages -list -f 1 -l 2`:
  - `BuddhistLifeBuddhistPath.pdf`'s page 1 holds a single 384×582 RGB JPEG (DCTDecode), which is its cover.
  - `Shout_of_Buddha.pdf`'s page 1 holds an 868×1364 grey JPEG 2000 (JPXDecode, 2.6 KB, effectively blank). WebKitGTK can't show JPEG 2000, and it isn't a cover, so this book gets a generated one.
  - `lopdf` 0.42, which `pdf-extract` re-exports, has `Document::get_page_images(page_id)`, which returns each image XObject's `filters`, `width`, `height` and raw `content`.
- `@tauri-apps/api` builds a custom protocol URL with `convertFileSrc(path, "cover")`: `cover://localhost/…` on Linux and macOS, `http://cover.localhost/…` on Windows. `@tauri-apps/api/mocks` has `mockConvertFileSrc` for tests.
- Contrast of cream (`#fffcf6`) text on the six light cover tints in §5: 5.6–7.3:1. For dark mode, each tint scaled to 72% of its RGB: `--text` (`#ede4d3`) on them is 7.0–8.6:1, and they sit at 1.6–2.0:1 against `--bg`, so with the outline they read as objects without glaring.
- The migration number: 001–006 have shipped, and #42 and #43 add none. The reading-progress plan also adds one, so this takes the next free number: 007 if it's built first, 008 if reading progress has landed (the file name, `MIGRATIONS` and the tests' version numbers move together).

## 1. Dependency: `ebook_research_core/Cargo.toml` (approved 2026-10-12)
- `image = { version = "0.25", default-features = false, features = ["jpeg", "png"] }`. It's pure Rust: zune-jpeg and png for decoding, plus its own JPEG encoder. Pitaka uses it only to decode a cover and write a small JPEG thumbnail.
- `src-tauri` doesn't use it. Its `png` 0.17/0.18 already in `Cargo.lock` come from `tauri-codegen`, at build time only.

## 2. Core, extraction: `ebook_research_core/src/cover.rs` (new), `epub.rs`, `pdf.rs`
- `cover.rs`:
  - `pub(crate) const THUMB_MAX: (u32, u32) = (300, 450)`
  - `const MAX_SOURCE_BYTES: usize = 20 << 20`
  - `pub(crate) fn thumbnail(source: &[u8]) -> Result<Vec<u8>>`:
    - refuses a source over `MAX_SOURCE_BYTES` with `bail!("cover image is too large")`;
    - decodes with `image::ImageReader::new(Cursor::new(source)).with_guessed_format()?`. Its `Limits` are `max_image_width`/`max_image_height` = 8000 and `max_alloc` = 256 MiB, so a crafted header can't make it allocate gigabytes;
    - composites any alpha onto `#fffcf6` and converts to RGB8;
    - resizes to fit `THUMB_MAX` with `resize(.., FilterType::Triangle)`, and only when the image is larger: no upscaling;
    - encodes as JPEG quality 80. Every stored cover is JPEG, so the protocol (§4) only ever serves `image/jpeg`. Re-encoding also strips anything odd in the source file.
  - `pub(crate) fn cover_key(thumb: &[u8]) -> String`: the first 12 hex digits of the thumbnail's SHA-256. It's the cache key in the URL.
- `epub.rs`:
  - `Opf` gains `cover_id: Option<String>`. `parse_opf` sets it from:
    - the first manifest item whose `properties` has the `cover-image` token; otherwise
    - `<meta name="cover" content="…">`, when `content` is a manifest id whose `media_type` starts with `image/`. Some books put the href in `content`, so a manifest item with that href is accepted too.
  - `fn cover_path(zip, opf_dir, opf) -> Option<String>` returns that item's resolved path. As a fallback, it looks at the first non-nav spine item. If that page has at most one paragraph of text (`extract_chapter(..).blocks.len() <= 1`, so a title page with a publisher's logo and real text doesn't qualify), it takes the page's first `<img src>` or `<image href | xlink:href>`, resolved with `resolve_href` against the page's folder. The match uses a small `LenientReader` pass over `img`/`image` start tags, not a regex.
  - `ParsedBook` gains `pub cover: Option<Vec<u8>>`, the raw source bytes. `parse_epub` fills it after step 4.
  - A missing zip entry or an unreadable cover is `None`, never an error: a cover never fails an import.
  - `pub fn read_epub_cover(path: &str) -> Result<Option<Vec<u8>>>` reads only container.xml, the OPF and the image, for the backfill. `parse_epub` shares `cover_path` with it.
- `pdf.rs`:
  - `fn page_one_jpeg(doc: &Document) -> Option<Vec<u8>>`: page 1's images from `get_page_images`, used only if there is exactly one image, its `filters` are exactly `["DCTDecode"]`, its width is at least 300px, and its height/width ratio is between 1.2 and 1.8 (a portrait cover). Then it returns `content.to_vec()`.
  - `parse_pdf` sets `cover` from it, and `pub fn read_pdf_cover(path) -> Result<Option<Vec<u8>>>` loads with the existing `load` and calls it.
- `db/test_util.rs`: `one_chapter_book` sets `cover: None`.
- `lib.rs`: `mod cover;`

## 3. Core, storage: `migrations/007_book_covers.sql`, `db/covers.rs` (new), `db/import.rs`, `db/library.rs`, `db/mod.rs`, `lib.rs`
- The migration:
  ```sql
  -- One row per book once its cover has been looked for. `thumb` is a
  -- JPEG of at most 300x450; NULL when the book has none ('none') or its
  -- file was missing or changed when the backfill looked ('unavailable').
  CREATE TABLE book_covers (
      book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
      source  TEXT NOT NULL CHECK (source IN ('epub', 'pdf', 'none', 'unavailable')),
      thumb   BLOB,
      key     TEXT,
      CHECK ((thumb IS NULL) = (key IS NULL))
  );
  ```
  It's listed in `migrations()` in `db/mod.rs`, after #43's `const MIGRATIONS` change, so `schema_version()` becomes 7.
- `db/covers.rs`:
  - `pub(super) fn save_cover(conn: &Connection, book_id: i64, format: &str, source: Option<&[u8]>) -> Result<()>`:
    - `thumbnail(source)` on success writes `source = format`, `thumb` and `key`;
    - `None`, or a thumbnail error, writes `'none'` with NULLs. The error is dropped deliberately, with a comment: a broken cover image shouldn't cost the book.
    - It runs `INSERT OR REPLACE INTO book_covers …`. A replace is safe here, unlike on `books`, because nothing references `book_covers`.
  - `pub fn book_cover(conn: &Connection, book_id: i64) -> Result<Option<Vec<u8>>>` reads `SELECT thumb FROM book_covers WHERE book_id = ?1`.
  - `#[derive(Serialize, Debug, PartialEq)] pub struct CoverBackfill { pub checked: i64, pub found: i64 }`
  - `pub fn backfill_covers(conn: &Mutex<Connection>) -> Result<CoverBackfill>`:
    - It locks only for each query and write, never while reading a file, so a 25 MB PDF doesn't stall the UI.
    - It lists `SELECT b.id, b.file_path, b.file_hash, b.format FROM books b LEFT JOIN book_covers c ON c.book_id = b.id WHERE c.book_id IS NULL`.
    - For each book, unlocked: if the file is missing or `file_hash(path)` differs, it records `'unavailable'`. Otherwise it reads the cover with `read_epub_cover` or `read_pdf_cover`, then locks and calls `save_cover`.
    - A book removed in the meantime makes the insert fail its foreign key. That error is skipped.
    - `file_hash` in `import.rs` becomes `pub(super)`.
- `import.rs` `load_book`: after the chapters, inside the same transaction, `save_cover(&tx, book_id, parsed.format, parsed.cover.as_deref())`. Every newly imported book then has a row, so the backfill never sees it.
- `library.rs` `BookSummary` gains `pub cover: Option<String>`, the `key`, with `None` meaning a generated cover. `list_books` adds `LEFT JOIN book_covers bc ON bc.book_id = b.id` and selects `bc.key`. `GROUP BY b.id` stays valid because the join is one-to-one.
- Re-export `book_cover`, `backfill_covers` and `CoverBackfill` from `db/mod.rs` and `lib.rs`.
- The backup (#43): covers are in `library.db`, so they come along. `library_counts` doesn't change. A restored backup made before this change is migrated to 7 by `prepare`, gets an empty `book_covers`, and the next backfill fills it.

## 4. Tauri: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `tauri.conf.json`
- The `cover` protocol, in `lib.rs`: `.register_asynchronous_uri_scheme_protocol("cover", commands::cover_protocol)` on the builder. `commands::cover_protocol(ctx, request, responder)`:
  - clones `ctx.app_handle()` and runs in `tauri::async_runtime::spawn_blocking`;
  - parses the book id from `request.uri().path()`, which is `/{id}-{key}`, the leading digits before `-`;
  - locks `state.conn` and calls `db::book_cover`;
  - responds `200` with `Content-Type: image/jpeg` and `Cache-Control: max-age=31536000, immutable`. That's safe because the key changes with the image, including when a book id is reused after a restore.
  - A bad path, a missing cover or a db error gives `404` with an empty body.
- `backfill_covers(app: AppHandle) -> Result<(), String>` starts `spawn_blocking`, which runs `db::backfill_covers(&state.conn)` and then emits `covers_found` with the `CoverBackfill`. It returns at once. Doc comment: ``/// Frontend calls: `invoke("backfill_covers")` once per launch; listen for `covers_found` ({ checked, found }).``
- Add `commands::backfill_covers` to `generate_handler!` after #43's `restore_library`.
- `tauri.conf.json`: `img-src 'self' cover: http://cover.localhost` in both `csp` and `devCsp`.

## 5. Frontend: `src/types.ts`, new `src/BookCover.tsx`, `BooksView.tsx`, `HomeView.tsx`, `App.tsx`, `App.css`
- `types.ts`:
  - `BookSummary` gains `cover: string | null`;
  - new `export type CoverBackfill = { checked: number; found: number }`.
- `BookCover.tsx`: `function BookCover({ book, size }: { book: BookSummary; size: "thumb" | "card" })`.
  - With `book.cover`: `<img className={`cover cover-${size}`} src={convertFileSrc(`${book.id}-${book.cover}`, "cover")} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />`. The `alt` is empty because the title is right beside it.
  - Without a cover, or after `onError`: `<div className={`cover cover-${size} cover-generated`} style={{ "--cover-tint": `var(--cover-${(book.id % 6) + 1})` }} aria-hidden="true">`.
    - At `thumb` size it holds only the title's first letter, in `--font-display`.
    - At `card` size it holds the title (`--font-display`, `--text-md`, clamped to 4 lines) and the author (`--text-sm`, 1 line). "Untitled" and "Unknown author" are used when they're missing.
- `App.css`:
  - Six tints, with darker variants in dark mode so the covers don't glare on the dark background:
    - light: `--cover-1: #8a4b2a` (clay), `--cover-2: #5f6b4a` (olive), `--cover-3: #4a5d73` (slate), `--cover-4: #6e4a63` (plum), `--cover-5: #7f6224` (ochre), `--cover-6: #3f5f5a` (teal);
    - dark (72% of each), in the dark block and `[data-theme="dark"]` if the reader-settings plan has landed: `#63361e`, `#444d35`, `#354353`, `#4f3547`, `#5b471a`, `#2d4441`;
    - Sepia, if it has landed, uses the light tints.
  - A new `--cover-text` token: `#fffcf6` light, `#ede4d3` dark. Generated covers use it rather than `--on-accent`, which is near-black in dark mode.
  - `.cover` has `aspect-ratio: 2 / 3`, `object-fit: cover`, `border-radius: 3px`, `background: var(--border)` (so it doesn't flash while loading) and `box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12)`.
  - `.cover-thumb` is `width: 32px` with `flex-shrink: 0`. `.cover-card` is `width: 100%`.
  - `.cover-generated` has a `--cover-tint` background, `--cover-text` text, a centred column, padding `--space-3`, and an inset 1px rule at `--space-2` drawn with `outline: 1px solid rgba(255, 252, 246, 0.35); outline-offset: calc(-1 * var(--space-2))`, so it looks like a printed cover.
  - In dark mode, `.cover` gains `outline: 1px solid var(--border)` so the covers keep an edge against `--bg`.
- `BooksView.tsx`:
  - Props gain `view: BookView` and `onViewChange`. In `App.tsx`: `const [bookView, setBookView] = useState<BookView>(loadBookView)`, with `export type BookView = "list" | "grid"` beside `BookSort`.
  - The choice is remembered per computer, as the reader settings are: `loadBookView()` reads `localStorage["pitaka.book-view"]` inside `try` and returns `"grid"` only for exactly that value, otherwise `"list"`; `setBookView` writes it inside `try`. Sort stays unremembered, as today.
  - A second `scope-toggle` after Sort: `<span className="books-sort-label" id="books-view-label">View:</span>` with **List** and **Grid** buttons, using `aria-pressed`, as Sort does.
  - List view: each `.book-row` starts with `<BookCover book={b} size="thumb" />`. Otherwise it's unchanged.
  - Grid view: `<ul className="book-grid">` (`display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: var(--space-6) var(--space-4)`) of `<li className="book-card">`. Each card holds:
    - `<BookCover size="card" />`;
    - `.book-card-title` (`--font-read`, `--text-sm`, 2-line clamp);
    - `.book-card-meta` (author, `--text-sm`, muted, 1 line);
    - a `.book-card-actions` row with the same Index, Edit and Remove buttons and handlers as the list row. Like `.book-row`, they're shown on hover and `:focus-within`.
    - Clicking the card opens the book. While editing (#42's `editing` state), the card's title and meta are replaced by the same form, stacked: Title and Author inputs at full width, then Save and Cancel.
  - The generated cover's `title` attribute isn't set. The card's title text is the accessible name of the row.
- `HomeView.tsx`: each `.home-recent-row` starts with `<BookCover book={b} size="thumb" />`. `.home-recent-row` already uses `display: flex`. It gains `align-items: center`, and the title and meta move into one `<span className="home-recent-text">` so the baseline layout of the two spans still works.
- `App.tsx`:
  - On mount: `invoke("backfill_covers").catch(() => {})`. A failure only means generated covers stay.
  - `listen<CoverBackfill>("covers_found", (e) => { if (e.payload.found > 0) setLibraryVersion((v) => v + 1) })`, unlistened on unmount.
  - After a restore (#43's `onLibraryReplaced`), it calls `backfill_covers` again for books the backup had no cover rows for.
  - `BooksView` and `HomeView` get `libraryVersion` and re-run `list_books` when it changes. Search already does.

## 6. Mock backend and demo: `src/test/mockBackend.ts`, `src/test/setup.ts`, `src/demo/installDemo.ts`, `db/ui_fixtures.rs`
- `ui_fixtures.rs`: when the fixture library is built, the first book gets `save_cover(conn, id, "epub", Some(&test_jpeg(600, 900)))`, where `test_jpeg` is a solid-colour image made with `image`. Every other book gets `None`. Regenerate with `UPDATE_UI_FIXTURES=1 cargo test -p ebook_research_core ui_fixtures`. That updates `src/test/fixtures/library.json`, which now has `cover` on every book (one key, the rest `null`), and `src/demo/library.json`, where the demo's one book is `null`.
- `mockBackend.ts`:
  - `case "backfill_covers"` returns `null`, then, when the new option `backfillFound?: number` is set, emits `covers_found` with `{ checked: n, found: n }` and sets that many books' `cover` to `"mock"`;
  - `case "list_books"` passes `cover` through.
- `setup.ts` and `installDemo.ts` call `mockConvertFileSrc("linux")`. In `dev:mock` and the demo, `cover://` doesn't resolve in a browser, so `onError` falls back to the generated cover. That's expected, and noted in a comment.

## 7. Tests
- `cover.rs` `#[cfg(test)]`:
  - `thumbnail_fits_and_does_not_upscale`: a 600×900 JPEG gives a 300×450 JPEG, starting `FF D8 FF`. 1588×2528 fits within 300×450, keeping its aspect ratio to within 1px. 100×150 stays 100×150.
  - `png_with_alpha_becomes_jpeg_on_paper`: a 10×10 fully transparent RGBA PNG gives a JPEG whose centre pixel is within 3 of `#fffcf6`.
  - `thumbnail_rejects_bad_input`: random bytes, an empty slice, a JPEG 8001×10 (over the limits), and `MAX_SOURCE_BYTES + 1` zero bytes are all `Err`.
  - `cover_key_is_12_hex_and_tracks_content`: two different thumbnails give different 12-character lowercase-hex keys.
- `epub.rs` tests, with `write_epub` taking `&[(&str, &[u8])]` (existing callers pass `.as_bytes()`):
  - `cover_from_epub3_property`: an OPF with `properties="cover-image"` on `img/c.jpg` and a `<meta name="cover">` pointing elsewhere. `parse_epub(..).cover` is `c.jpg`'s bytes.
  - `cover_from_epub2_meta`: only `<meta name="cover" content="cov">`. Then the variant where `content` is the href. Then the variant where `cov` is `application/xhtml+xml`: no cover from meta, so it falls back to the spine.
  - `cover_from_first_spine_page`: no metadata, and a first page of `<svg><image xlink:href="../images/front.jpg"/></svg>` gives `front.jpg`. When that page has two paragraphs of text, the result is `None`.
  - `missing_cover_file_is_no_cover`: the meta points at an absent entry. `parse_epub` succeeds with `cover: None` and its chapters intact.
  - `read_epub_cover_matches_parse_epub`, on the first test's file.
- `pdf.rs`:
  - `page_one_jpeg_takes_a_single_portrait_jpeg`: a `lopdf` document built in the test with one DCTDecode image XObject, 400×600, on page 1, returns its bytes.
  - With two images, a FlateDecode image, a 400×300 image, or a 200×300 image, it returns `None`.
  - `tests/fixtures/pdf/test.pdf` gives `None`.
- `db/covers.rs`:
  - `import_saves_a_cover_row_for_every_book`: `load_book` with `cover: Some(jpeg)` gives `book_covers.source = 'epub'` and a 12-character key that `list_books` returns. `cover: None` gives `'none'` and `list_books` `cover == None`. Corrupt bytes give `'none'`, and the import still succeeds.
  - `book_cover_returns_the_thumbnail`: the bytes start `FF D8 FF`, and an unknown id gives `Ok(None)`.
  - `covers_go_with_the_book`: `delete_book` leaves no `book_covers` row.
  - `backfill_fills_only_missing_rows`: three books are loaded and their rows deleted to simulate a pre-007 library. Book A's file is a real EPUB written with a cover, B's path doesn't exist, and C's file has different contents from its `file_hash`. `backfill_covers` returns `{ checked: 3, found: 1 }`, with sources `epub`, `unavailable` and `unavailable`. A second run returns `{ checked: 0, found: 0 }`.
  - `migration_007_adds_an_empty_table`: an `open_db` on a database at version 6 with books gives `user_version` 7, an empty `book_covers`, and `list_books` with every `cover` `None`.
- `tests/integration.rs`:
  - `test_epub_gets_a_generated_cover`: import `test.epub`. `list_books` `cover` is `None`, the `book_covers.source` is `'none'`, and `backfill_covers` returns `{ checked: 0, found: 0 }`.
  - `backup_keeps_covers`: import a temporary EPUB written with a cover, back up, and restore into a fresh `open_db`. `book_cover` gives the same bytes, and `list_books` the same key.
- `src/Books.test.tsx`:
  - The fixture book with a cover renders an `img` whose `src` is `cover://localhost/{id}-{key}` and `alt` is `""`. A book without one renders `.cover-generated` with its title's first letter. `fireEvent.error(img)` swaps it for `.cover-generated`.
  - **Grid** (`aria-pressed` true) shows a `.book-grid` with one `.book-card` per book, each with its title and author. Clicking a card opens the reader. Tab reaches Remove, which still asks and removes. Edit shows the Title/Author form inside the card, and Save updates the card. **List** brings the rows back.
  - The filter and title sort apply in the grid: filter "zen" shows only matching cards.
  - `src/test/setup.ts`'s `afterEach` clears `localStorage`, unless the reader-settings plan has already added that.
  - Grid is remembered: after choosing **Grid**, unmounting and `renderApp()` again shows the grid; `localStorage["pitaka.book-view"] = "bogus"` gives List; a throwing `localStorage` (stubbed) gives List and no error.
- `src/Home.test.tsx`: each recent row has a cover (an `img` or `.cover-generated`), and clicking the row still opens the book.
- `src/Books.test.tsx` (there's no App-level test file): with `backfillFound: 1`, `backfill_covers` is called once on mount, and after `covers_found` the Books list re-fetches (`list_books` called again) and that book shows an `img`.
- `src/Demo.test.tsx`: unchanged. Run it, since the demo book now renders a generated cover.
- `ui_fixtures_are_current` passes after regeneration.

## 8. README
- Feature list: "**Covers**: each book's cover is taken from the EPUB (or a PDF's front-page image), with a typographic cover for books without one, in a list or a grid."
- "How it's built":
  - a `cover.rs` entry: extraction order, thumbnailing to a 300×450 JPEG, decode limits;
  - `db/covers.rs`: the `book_covers` table, the once-per-launch backfill, and the `cover://` protocol serving thumbnails under `img-src 'self' cover: http://cover.localhost`.
- "What's actually verified": the tests above, the Python survey numbers from Context (52/52 covers found, 1.0 MB of thumbnails), and what was checked in `npm run tauri dev`. The CSP entry gains the `cover:` source.
- Schema migrations: 007 `book_covers`.
- Known limitations, a new one: a PDF gets a cover only when page 1 is a single JPEG image. Otherwise, and for GIF, WebP or SVG covers, it gets a generated one. A book whose file was missing or changed when covers were first looked for keeps a generated cover until it's removed and re-imported.
- Roadmap: add and tick "Book covers on the Books screen and Home, with a grid view". Add, unticked, "Render a PDF's first page as its cover (needs a PDF renderer)".
- `site/`: no change until the release that ships it, per the site-copy memory. New README and site screenshots of the grid go in with that release too.

## Verification
1. `cargo test -p ebook_research_core`, `cargo clippy --workspace --all-targets` (and `--features semantic`), `npx tsc --noEmit`, `npm test`, `npm run format:check`.
2. `npm run dev:mock`:
   - list and grid, light and dark, at 1366px and 560px;
   - generated covers for every book, through the `onError` fallback;
   - the Edit form inside a grid card;
   - Home's recent rows.
3. `npm run tauri dev` on a copy of the real library:
   - the first launch backfills, and the log or the event payload should give `{ checked: 54, found: 53 }`: 52 EPUBs plus `BuddhistLifeBuddhistPath.pdf`;
   - covers appear without restarting;
   - the grid scrolls smoothly;
   - `library.db` grows by about 1 MB;
   - a second launch checks 0 books;
   - importing a new EPUB shows its cover at once;
   - removing it leaves no `book_covers` row.

   Also check in WebKitGTK that `cover://` loads under the release CSP (`npm run tauri build`'s binary, not just `devCsp`).
