# Highlights and notes

## Context
Bookmarks file whole paragraphs into folders, but there's no way to mark the phrase that matters inside a paragraph, or to write down what you thought about it. The `highlights` and `notes` tables have been in migration 001 since the start, but nothing reads or writes them. This is the README roadmap item "Highlights and notes UI".

What this adds: select text in the reader to highlight it in one of four colours, attach a note to a highlight or to a whole paragraph, and browse every highlight and note per book on the Bookmarks screen, which becomes "Bookmarks & notes".

Out of scope:
- Export (its own roadmap item, "Export bookmarks, notes and highlights").
- Searching notes or highlights. They don't go into `content_fts`, and the Search screen is unchanged.
- Highlights that span paragraphs, overlapping highlights, and keeping annotations when a book is removed and re-imported (limitation 6 already covers this for bookmarks).
- Putting highlights into bookmark folders, and formatting in notes.

Decisions:
- **Highlights anchor to a character range inside one paragraph** (`content_block_id`, `start_offset`, `end_offset`), as the schema already does. Whole-paragraph anchoring was ruled out because it just repeats bookmarks. The usual worry about ranges, that the text shifts under them, doesn't apply here: `content_blocks.text` is never updated after import. A re-import is a delete followed by new block ids, and that loses whole-paragraph anchors just as much.
- **Offsets count Unicode scalar values**, matching `char_start`/`char_end` (`epub.rs` uses `text.chars().count()`). The browser measures selections in UTF-16 code units, so the reader converts them. Pali diacritics are all in the BMP, so the two units only differ for astral characters such as emoji, but the conversion keeps the stored data consistent.
- **One note per highlight and at most one free-standing note per paragraph**, enforced by unique indexes. With a single note per anchor, the reader needs one popover instead of a list.
- **Removing a highlight removes its note too.** The schema's `ON DELETE SET NULL` would turn that note into a paragraph note, which collides with the paragraph's own note (checked below), and a note detached from its quote loses its meaning anyway. The UI confirms first when the highlight has a note.
- **Notes are read and edited in a margin beside the text, hidden until asked for.** A small note marker sits right after the text a note belongs to: the end of the highlight, or the end of the paragraph for a paragraph note. Clicking the marker shows or hides that note's card in the margin. With every note always visible, a heavily annotated chapter would be hard to read. A popover would cover the text the note is about.
- **Highlights and notes share the Bookmarks screen**, as suggested. All three answer "what have I marked?", and a fourth home card would be one more place to look. Folders still organise bookmarks across books. Highlights and notes are grouped per book, because nothing files them into folders.

Checked in `sqlite3` against migrations 001–004 plus the proposed 005:
- Deleting a book cascades to its highlights and notes. Deleting a highlight sets its note's `highlight_id` to NULL.
- Without new indexes, finding a chapter's highlights scans `highlights`. With `idx_highlights_block`, it searches by `idx_content_blocks_chapter` and then the new index.
- `UNIQUE (highlight_id)` allows any number of NULLs, so paragraph notes are unaffected. The partial unique index rejects a second paragraph note on the same block.
- Deleting a highlight with a note fails with `UNIQUE constraint failed: notes.content_block_id` when the paragraph already has its own note. That failure is why `delete_highlight` deletes the note first.
- Nothing has ever written to either table, so the unique indexes can't fail on existing data.

## 1. Migration: `migrations/005_annotations.sql`, `db/mod.rs`
```sql
-- The reader loads a chapter's highlights and notes by paragraph.
CREATE INDEX idx_highlights_block ON highlights(content_block_id);
CREATE INDEX idx_notes_block ON notes(content_block_id);
-- One note per highlight, and one free-standing note per paragraph.
CREATE UNIQUE INDEX idx_notes_highlight ON notes(highlight_id);
CREATE UNIQUE INDEX idx_notes_paragraph ON notes(content_block_id) WHERE highlight_id IS NULL;
```
- Add `M::up(include_str!("../../migrations/005_annotations.sql"))` to `migrations()`.
- SQLite can't add a `CHECK (start_offset < end_offset)` without rebuilding the table, so the core validates ranges instead.

## 2. Core: `db/annotations.rs` (new), `db/mod.rs`, `lib.rs`
Types (all `Serialize, Debug`):
- `Highlight { id, content_block_id, start_offset, end_offset, color: String, created_at }`
- `Note { id, content_block_id, highlight_id: Option<i64>, body, created_at, updated_at }`
- `ChapterAnnotations { highlights: Vec<Highlight>, notes: Vec<Note> }`, with both lists in `block_idx` order and highlights then by `start_offset`.
- `AnnotatedBook { book_id, title: Option<String>, author: Option<String>, highlight_count, note_count }`
- `BookAnnotation { content_block_id, chapter_id, chapter_idx, chapter_title: Option<String>, highlight_id: Option<i64>, color: Option<String>, text, note_id: Option<i64>, note_body: Option<String> }`. Each row is a highlight (with its note, if any) or a paragraph note. `text` is the highlighted substring, or the whole paragraph for a paragraph note.

Functions:
- `pub const HIGHLIGHT_COLORS: [&str; 4] = ["yellow", "green", "blue", "pink"]`. Any other colour fails with `unknown highlight colour "{c}"`.
- `add_highlight(conn, content_block_id, start, end, color) -> Result<Highlight>`. It looks up the block's `book_id` and text (`no paragraph with id {id}`), requires `0 <= start < end <= text.chars().count()` (`highlight range {start}..{end} is outside the paragraph`), and rejects a range that overlaps another highlight in the block (`that overlaps an existing highlight`). Ranges that only touch are allowed.
- `set_highlight_color(conn, highlight_id, color) -> Result<()>` fails with `no highlight with id {id}` when the highlight is missing.
- `delete_highlight(conn, highlight_id) -> Result<()>` deletes the note and then the highlight, in one transaction.
- `add_highlight_note(conn, highlight_id, body) -> Result<Note>` copies `content_block_id` and `book_id` from the highlight (`no highlight with id {id}`). Only the core writes those duplicate columns, so they can't disagree with the highlight.
- `add_paragraph_note(conn, content_block_id, body) -> Result<Note>` takes `book_id` from the block (`no paragraph with id {id}`) and leaves `highlight_id` NULL.
- Both trim the body, which must be non-empty (`note can't be empty`). Both check their unique index up front for a friendly error: `that highlight already has a note` or `that paragraph already has a note`.
- `update_note(conn, note_id, body) -> Result<()>` trims the body, rejects it if empty, and sets `updated_at = datetime('now')`.
- `delete_note(conn, note_id) -> Result<()>`.
- `get_chapter_annotations(conn, chapter_id) -> Result<ChapterAnnotations>` makes two queries, each joining `content_blocks` on `chapter_id`.
- `list_annotated_books(conn) -> Result<Vec<AnnotatedBook>>` returns books with at least one highlight or note, by title.
- `list_book_annotations(conn, book_id) -> Result<Vec<BookAnnotation>>` returns entries in reading order (`ch.idx, cb.block_idx`, paragraph note first, then highlights by `start_offset`). A missing book is an error. The substring comes from a `chars().skip().take()` helper, `slice_chars`, rather than SQL `substr`. `substr` also counts characters, but keeping the logic in one place means the tests exercise it.
- Re-export everything by name from `db/mod.rs` and `lib.rs`.

`library.rs`: add `highlight_count` and `note_count` to `BookSummary`, as subqueries next to `bookmark_count`, so the Remove dialog can warn about them.

## 3. Tauri commands: `commands.rs`, `src-tauri/src/lib.rs`
Thin wrappers, one per core function, with the usual doc comment showing the `invoke` call: `add_highlight { contentBlockId, start, end, color }`, `set_highlight_color { highlightId, color }`, `delete_highlight { highlightId }`, `add_highlight_note { highlightId, body }`, `add_paragraph_note { contentBlockId, body }`, `update_note { noteId, body }`, `delete_note { noteId }`, `get_chapter_annotations { chapterId }`, `list_annotated_books`, `list_book_annotations { bookId }`. Register all ten in `generate_handler!`.

## 4. Frontend types and mock: `types.ts`, `test/mockBackend.ts`
- Mirror `Highlight`, `Note`, `ChapterAnnotations`, `AnnotatedBook`, `BookAnnotation`, and add `HighlightColor = "yellow" | "green" | "blue" | "pink"`. Add `highlight_count`/`note_count` to `BookSummary`.
- In the mock, the `Fixtures` type gains `chapter_annotations`, `annotated_books` and `book_annotations` (all optional, since the demo's data has none). The mock keeps highlights and notes in memory, validates overlap, empty note and duplicate note with the core's error strings, and drops a book's annotations in `delete_book`. The browser demo goes through the same mock, so annotations work there and are lost on reload, like its bookmarks.

## 5. Reader: `ReaderView.tsx`, `annotate.ts` (new), `SelectionToolbar.tsx` (new), `HighlightPopover.tsx` (new), `NoteCard.tsx` (new)
- `annotate.ts`: `segments(text, highlights)` splits a paragraph into plain and highlighted runs by code-point offset. `selectionOffsets(paragraph: HTMLElement, range: Range)` returns `{ start, end }` in code points: it measures a `Range` from the paragraph's start to each end of the selection and takes `Array.from(r.toString()).length`. The note markers are separate elements, so they're excluded from that measurement (the range is measured over text nodes outside `.note-hint`).
- Rendering: each `p.reader-paragraph` renders its segments, with a highlight as `<mark className="hl hl-<color>" data-highlight-id>`.
- Note markers: a highlight with a note is followed by `<button className="note-hint">`, a small raised pen glyph in the accent colour (aria-label "Show note", or "Hide note" while its card is open, with `aria-expanded`). A paragraph note puts the same marker at the end of the paragraph. A marker is styled as an inline superscript and isn't selectable (`user-select: none`), so it doesn't break up selections.
- Margin: `NoteCard` shows a note's body with "Edit" and "Hide" buttons. "Edit" swaps in a `textarea` with Save, Cancel and Delete. Saving an empty note counts as Delete, and Delete asks first via `ask`: `Delete this note?`. Note editing happens only here, never in a popover.
- Layout: when the window is at least 1280px wide (sidebar 272 + padding 80 + text 640 + gap 24 + margin 240 ≈ 1256), `.reader-block` becomes a two-column grid (`640px 240px`, gap 24px), with the margin cell in normal flow, so a tall card pushes the next paragraph down instead of overlapping it. The margin column is always there at that width, so opening a note never reflows the text. A paragraph's open cards stack in text order, and each one has a thin rule in its highlight's colour (neutral for a paragraph note) so it can be matched to its marker. Below 1280px, the cards open under the paragraph instead.
- Selecting: on `mouseup`/`keyup` in `.reader-text`, the reader reads `window.getSelection()`. If the selection is non-empty and its anchor and focus are in the same `.reader-paragraph`, it shows `SelectionToolbar` above the selection's bounding rect. The toolbar has four swatches (aria-labels "Highlight yellow" and so on) and an "Add note" button. "Add note" highlights the text in yellow and then opens an empty `NoteCard` in edit mode for that highlight. When a selection crosses paragraphs, the toolbar instead reads "Highlights stay within one paragraph". Core errors such as overlap appear in the toolbar.
- Clicking a `mark` opens `HighlightPopover`, which has the colour swatches, "Add note" (only when there's no note yet; it opens an empty card in edit mode) and Remove. When the highlight has a note, Remove first asks via `ask`: `Remove this highlight and its note?`. The popover handles Escape and outside clicks like `BookmarkPopover`.
- Paragraph notes: a second hover icon, `note-toggle` (aria-label "Note on this passage"), sits beside `bookmark-toggle`. With no note yet, it opens an empty card in edit mode. Once the paragraph has a note, the marker in the text takes over and the icon toggles the same card.
- State: `annotations: ChapterAnnotations`, loaded with the chapter alongside `get_chapter_bookmarks` and refreshed after every change. `openNoteIds: Set<number>` tracks open cards, and `draftNote: { contentBlockId, highlightId: number | null } | null` tracks a card for a note that doesn't exist yet. Both reset when the chapter changes. A draft that's cancelled leaves its highlight in place. Opening the selection toolbar closes any open popover, and the reverse.
- Arriving from the Bookmarks & notes screen with a note entry opens that note's card. `ReaderView` gets an optional `openNoteId` prop, passed through `ReaderTarget`.

## 6. Bookmarks & notes screen: `BookmarksView.tsx`, `BookAnnotationsView.tsx` (new), `App.tsx`, `NavBar.tsx`, `HomeView.tsx`, `BooksView.tsx`
- The nav label and home card become "Bookmarks & notes". The `Screen` id stays `"bookmarks"`. The home card's detail adds `· N highlights, M notes` when there are any.
- `BookmarksView` gets two sections, "Folders" (today's content) and "Highlights & notes", with one row per `AnnotatedBook` (`Title — 12 highlights, 3 notes`). When there are none, it shows "Select text while reading to highlight it or add a note."
- Clicking a book opens `BookAnnotationsView` (modelled on `FolderView`). It has a back button, the book title, and entries grouped under chapter headings. Each entry has a colour bar, the quoted text, and the note body below it. Clicking an entry opens the reader at that paragraph, with the back label `← <book title>`.
- `App` holds `openAnnotationsBookId` beside `openFolderId`, so the list survives a trip into the reader. `navigate` clears it the same way.
- In `BooksView`'s Remove dialog, the existing bookmark warning also counts highlights and notes, e.g. ` Its 3 bookmarks, 5 highlights and 2 notes will be deleted.`
- `App.css`: colours for `.hl-*` in light and dark (translucent backgrounds so text contrast holds), plus the toolbar, the popover, `.note-hint`, `.note-toggle`, `.note-card`, and the 1280px grid breakpoint for `.reader-block`.

## 7. Tests
Core unit tests in `annotations.rs` (using `one_chapter_book` and `block_ids` from `test_util`):
- `highlight_ranges_count_characters`: on the paragraph `"Paṭācārā went home"`, `add_highlight(0, 8)` succeeds, and `list_book_annotations` gives `text == "Paṭācārā"`. `(0, 19)` fails with "outside the paragraph", while `(0, 18)` passes. `(5, 5)` fails.
- `highlight_overlaps`: `(0,4)` then `(4,8)` both succeed, and `(3,6)` fails with "overlaps".
- `highlight_colors`: `"purple"` fails, and `set_highlight_color` to green shows up in `get_chapter_annotations`. A missing id errors.
- `notes_one_per_anchor`: an empty or whitespace body fails. A second note on the same highlight fails with "already has a note", and so does a second paragraph note. A highlight note and a paragraph note on the same block coexist. A highlight note's `content_block_id` equals its highlight's. Unknown highlight and paragraph ids fail with "no highlight with id" and "no paragraph with id".
- `update_note_bumps_updated_at`: pin `updated_at` to `'2000-01-01 00:00:00'`, update, and check the body changed and `updated_at` didn't stay the same.
- `deleting_highlight_deletes_its_note`: the paragraph has its own note, and its highlight has one too. Deleting the highlight succeeds (this is the case the `SET NULL` cascade would break), leaving just the paragraph note.
- `book_annotations_in_reading_order`: a two-chapter book with annotations added out of order. Both lists come out in reading order, with the counts in `list_annotated_books` and in `list_books`.
- Extend `deleting_folder_or_book_removes_bookmarks` (or add a sibling test): `delete_book` removes the book's highlights and notes, and the FTS `integrity-check` still passes.

Integration (`tests/integration.rs`): import `test.epub` and find a chapter by title. Highlight the first word of its first paragraph and add a note. Remove the book and re-import it, then check `list_annotated_books` is empty.

UI fixtures (`ui_fixtures.rs`): on the long book's first chapter, add a yellow highlight with a note, a green highlight without one, and a paragraph note. Write `chapter_annotations`, `annotated_books` and `book_annotations`, then regenerate `library.json`.

Frontend (`src/Annotations.test.tsx`, plus the existing suites updated for the renamed nav and home card):
- The reader renders fixture highlights as `mark.hl-yellow`/`mark.hl-green`.
- Selecting part of a paragraph (via `document.createRange` and `getSelection().addRange`, then `mouseup`) shows the toolbar. "Highlight blue" calls `add_highlight` with the right code-point offsets, and the new mark appears.
- A selection across two paragraphs shows "Highlights stay within one paragraph" and no swatches.
- Fixture notes start hidden, so their text isn't in the document. Clicking a highlight's "Show note" marker shows its card, and "Hide" removes it again. The marker's `aria-expanded` follows the card.
- Selecting text and then "Add note" calls `add_highlight` and opens an empty card in edit mode. Saving calls `add_highlight_note`, and the new marker appears. Cancelling leaves the highlight with no note.
- Editing a note calls `update_note`. Saving it empty confirms and then calls `delete_note`.
- Clicking a mark opens the popover. Removing a highlight that has a note confirms first, and cancelling keeps it.
- The paragraph `note-toggle` opens an empty card for a paragraph note (saving calls `add_paragraph_note`), and the fixture paragraph note's marker sits at the end of its paragraph.
- Offsets ignore markers: selecting text that comes after a highlight with a note sends the same offsets as it would with the note marker absent.
- The Bookmarks & notes screen lists the fixture book. Opening it shows the entries in order. Clicking one opens the reader at that block with back label `← A Long Book for Scrolling`, and when the entry has a note, its card is already open.
- The Remove book dialog text mentions highlights and notes.

## 8. README
- Roadmap: tick "Highlights and notes UI".
- "What's actually verified": a new bullet for `db/annotations.rs` (code-point ranges, overlap and one-note rules, deleting a highlight deletes its note, cascades on book removal). Also extend the frontend bullet for the selection toolbar, the popover and the Bookmarks & notes screen.
- Known limitations: limitation 6 now also covers highlights and notes. Add that a highlight can't span paragraphs or overlap another, and that notes aren't searchable.
- Schema migrations section: list 005.

## Verification
1. `cargo test -p ebook_research_core`, `cargo clippy --workspace --all-targets`, `npx tsc --noEmit`, `npm test`.
2. `npm run dev:mock`: highlight in each colour, add and edit a note, remove a highlight that has a note, add a paragraph note, then browse the Bookmarks & notes screen and open an entry. Check the margin at 1400px wide (cards beside the text, the text not reflowing when a card opens, a long note pushing the next paragraph down) and at 1000px (cards under the paragraph).
3. `npm run tauri dev`: the same steps on *Understanding Our Mind*, with one highlight over diacritics, and check the data survives an app restart.
