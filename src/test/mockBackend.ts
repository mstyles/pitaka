// Answers the frontend's `invoke` calls from fixtures written by the core
// test `ui_fixtures_are_current` (UPDATE_UI_FIXTURES=1 regenerates them), so
// the UI can run in jsdom or a plain browser tab without the Rust side.
import { emit } from "@tauri-apps/api/event";
import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import fixtureData from "./fixtures/library.json";
import type {
  AnnotatedBook,
  BackupManifest,
  BlockBookmark,
  BookAnnotation,
  BookmarkFolder,
  BookSummary,
  ChapterAnnotations,
  ChapterContent,
  ChapterMatch,
  ChapterSummary,
  BookScan,
  CoverBackfill,
  FolderBookmark,
  Highlight,
  ImportOutcome,
  IndexState,
  Note,
  ReadingPosition,
  SearchMode,
  SearchResult,
  SemanticIndexFailed,
  SemanticIndexProgress,
  SemanticIndexStopped,
  SemanticStatus,
} from "../types";

export type Fixtures = {
  /** What importing the fixture book returns; absent in the demo's data. */
  import_new?: ImportOutcome;
  import_again?: ImportOutcome;
  books: BookSummary[];
  chapters: Record<string, ChapterSummary[]>;
  chapter_content: Record<string, ChapterContent>;
  search: Record<string, SearchResult[]>;
  bookmark_folders: BookmarkFolder[];
  folder_bookmarks: Record<string, FolderBookmark[]>;
  /** Absent in the demo's data: the demo has no chapter search. */
  semantic_status?: SemanticStatus;
  chapter_matches?: Record<string, ChapterMatch[]>;
  /** What scanning a folder returns; absent in the demo's data. */
  find_books?: BookScan;
  /** Absent in the demo's data, which starts with nothing highlighted. */
  chapter_annotations?: Record<string, ChapterAnnotations>;
  annotated_books?: AnnotatedBook[];
  book_annotations?: Record<string, BookAnnotation[]>;
  /** A backup of the fixture library's manifest; absent in the demo's data. */
  backup_manifest?: BackupManifest;
  /** Where the long book would be left at Part Two's paragraph 10; absent in the demo's data. */
  reading_position_sample?: ReadingPosition;
};

const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink"];

const NO_SEMANTIC: SemanticStatus = { available: false, indexed_books: 0, total_books: 0 };

export const fixtures = fixtureData as Fixtures;

export type MockOptions = {
  /** The library to serve, in place of the test fixtures (the browser demo's book). */
  data?: Fixtures;
  /** Answers `search_library`; by default, the fixtures' recorded searches. */
  search?: (books: BookSummary[], query: string, mode: SearchMode) => SearchResult[];
  /** When set, `import_book` always rejects with this message. */
  importError?: string;
  /** Paths `import_book` rejects, with the message to reject with. */
  importErrors?: Record<string, string>;
  /** When set, each `import_book` call waits for this before answering. */
  importGate?: Promise<unknown>;
  /** Commands that wait for their promise to settle before answering, e.g. to see a loading state. */
  gates?: Partial<Record<string, Promise<unknown>>>;
  /** What the "Import book" file picker returns; null means cancelled. */
  openPath?: string | null;
  /** What the "Import folder" picker returns; null means cancelled. */
  openDir?: string | null;
  /** Answers `find_books`, in place of the fixtures' scan. */
  scan?: BookScan;
  /** Whether confirmation dialogs (remove book, delete folder) are accepted. */
  confirm?: boolean;
  /** The library to start with, in place of the fixture books. */
  books?: BookSummary[];
  /** Commands that should reject, with the error message to reject with. */
  fail?: Partial<Record<string, string>>;
  /** Overrides the fixtures' `semantic_status`, e.g. to offer chapter search. */
  semantic?: Partial<SemanticStatus>;
  /** Overrides books' `index_state`, by book id. */
  indexStates?: Record<number, IndexState>;
  /** What the "Back up" save dialog returns; null means cancelled. */
  savePath?: string | null;
  /** When set, the backup and restore commands always reject with this message. */
  backupError?: string;
  /**
   * When set, `backfill_covers` finds covers for this many books without one,
   * then sends `covers_found`, as the app does once its background run ends.
   */
  backfillFound?: number;
};

export type MockCall = { cmd: string; args: Record<string, unknown> };

/** Like SQLite's datetime('now'), which `created_at` defaults to. */
function sqliteNow() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export function installMockBackend({
  data = fixtures,
  search,
  importError,
  importErrors = {},
  importGate,
  gates = {},
  openPath = "/books/test.epub",
  openDir = "/books/folder",
  scan,
  confirm = true,
  fail = {},
  books: initialBooks = data.books,
  semantic = {},
  indexStates = {},
  savePath = "/backups/pitaka-backup.pitaka",
  backupError,
  backfillFound,
}: MockOptions = {}) {
  const calls: MockCall[] = [];
  const openedUrls: string[] = [];
  const withIndexState = (list: BookSummary[]) =>
    list.map((b) => ({ ...b, index_state: indexStates[b.id] ?? b.index_state }));
  const startingBooks = () => withIndexState(initialBooks);
  let books = startingBooks();

  // Bookmark state, seeded from the fixtures and kept consistent the way the
  // SQL is: counts are derived, and deletes cascade.
  const startingFolders = () =>
    data.bookmark_folders.map(({ bookmark_count: _, ...f }) => ({ ...f }));
  const startingBookmarks = (): FolderBookmark[] => Object.values(data.folder_bookmarks).flat();
  let folders = startingFolders();
  let bookmarks = startingBookmarks();
  let nextFolderId = Math.max(0, ...folders.map((f) => f.id)) + 1;
  let nextBookmarkId = Math.max(0, ...bookmarks.map((b) => b.id)) + 1;

  function folderName(name: unknown, exceptId?: number) {
    const trimmed = String(name).trim();
    if (!trimmed) throw "folder name can't be empty";
    const lower = trimmed.toLowerCase();
    if (folders.some((f) => f.id !== exceptId && f.name.toLowerCase() === lower)) {
      throw `a folder named "${trimmed}" already exists`;
    }
    return trimmed;
  }
  function folderIndex(id: number) {
    const i = folders.findIndex((f) => f.id === id);
    if (i < 0) throw `no folder with id ${id}`;
    return i;
  }
  function withCount(f: (typeof folders)[number]): BookmarkFolder {
    return { ...f, bookmark_count: bookmarks.filter((b) => b.folder_id === f.id).length };
  }
  // Highlight and note state, seeded the same way. Errors use the core's
  // wording, since the UI shows them as they come.
  const seeded = Object.values(data.chapter_annotations ?? {});
  const startingHighlights = (): Highlight[] => seeded.flatMap((a) => a.highlights);
  const startingNotes = (): Note[] => seeded.flatMap((a) => a.notes);
  let highlights = startingHighlights();
  let notes = startingNotes();
  let nextHighlightId = Math.max(0, ...highlights.map((h) => h.id)) + 1;
  let nextNoteId = Math.max(0, ...notes.map((n) => n.id)) + 1;

  function checkColor(color: unknown) {
    if (!HIGHLIGHT_COLORS.includes(String(color))) throw `unknown highlight colour "${color}"`;
    return color as Highlight["color"];
  }
  function checkBody(body: unknown) {
    const trimmed = String(body).trim();
    if (!trimmed) throw "note can't be empty";
    return trimmed;
  }
  function findHighlight(id: number) {
    const h = highlights.find((h) => h.id === id);
    if (!h) throw `no highlight with id ${id}`;
    return h;
  }
  function findNote(id: number) {
    const n = notes.find((n) => n.id === id);
    if (!n) throw `no note with id ${id}`;
    return n;
  }
  /** A block's chapter and position, whether or not its book is still in the library. */
  function blockPlace(blockId: number) {
    for (const content of Object.values(data.chapter_content)) {
      const block = content.blocks.find((b) => b.id === blockId);
      if (block) return { content, block };
    }
    throw `no paragraph with id ${blockId}`;
  }
  /** Paragraph order, then a paragraph's own note before its highlights by start. */
  function readingOrder(blockId: number, highlightId: number | null) {
    const { content, block } = blockPlace(blockId);
    const start = highlightId == null ? -1 : findHighlight(highlightId).start_offset;
    return [content.chapter_idx, block.block_idx, start];
  }
  function byReadingOrder<T>(key: (item: T) => number[]) {
    return (a: T, b: T) => {
      const [x, y] = [key(a), key(b)];
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
      return 0;
    };
  }
  function bookOf(blockId: number) {
    return blockPlace(blockId).content.book_id;
  }
  function counts(bookId: number) {
    return {
      highlight_count: highlights.filter((h) => bookOf(h.content_block_id) === bookId).length,
      note_count: notes.filter((n) => bookOf(n.content_block_id) === bookId).length,
    };
  }

  // Where each book was left. A counter stands in for `read_at`'s clock,
  // so "most recently read" is deterministic.
  let positions = new Map<number, { blockId: number; finished: boolean; seq: number }>();
  let nextSeq = 1;

  /** A book's position, worked out from the fixtures with the core's formula. */
  function positionOf(bookId: number): ReadingPosition | null {
    const saved = positions.get(bookId);
    if (!saved) return null;
    const { content, block } = blockPlace(saved.blockId);
    const chapters = data.chapters[String(bookId)] ?? [];
    const place = chapters.findIndex((c) => c.id === content.chapter_id);
    const total = chapters.reduce((n, c) => n + c.char_count, 0);
    const before =
      chapters.slice(0, place).reduce((n, c) => n + c.char_count, 0) +
      content.blocks
        .filter((b) => b.block_idx < block.block_idx)
        .reduce((n, b) => n + [...b.text].length, 0);
    const percent = saved.finished
      ? 100
      : total === 0
        ? 0
        : Math.floor((before * 200 + total) / (2 * total));
    return {
      book_id: bookId,
      chapter_id: content.chapter_id,
      content_block_id: block.id,
      chapter_title: content.chapter_title,
      chapter_number: place + 1,
      chapter_count: chapters.length,
      percent,
      finished: saved.finished,
      read_at: sqliteNow(),
    };
  }

  /** Trims and collapses whitespace, and "" becomes null, as the core does. */
  function cleanField(value: unknown) {
    return String(value).trim().replace(/\s+/g, " ") || null;
  }
  /** A hit or bookmark with its book's current title, as the core reads it at query time. */
  function withBookTitle<T extends { book_id: number; book_title: string | null }>(h: T): T {
    return { ...h, book_title: books.find((b) => b.id === h.book_id)?.title ?? null };
  }

  function findBlock(blockId: number) {
    for (const content of Object.values(data.chapter_content)) {
      const block = content.blocks.find((b) => b.id === blockId);
      if (block && books.some((b) => b.id === content.book_id)) return { content, block };
    }
    throw `no paragraph with id ${blockId}`;
  }

  // `shouldMockEvents` lets the app's `listen` calls work without Rust, and
  // tests send indexing events with `indexingEvents`.
  function answer(cmd: string, args: Record<string, unknown>) {
    if (fail[cmd]) throw fail[cmd];

    switch (cmd) {
      case "list_books":
        return books.map((b) => ({
          ...b,
          bookmark_count: bookmarks.filter((bm) => bm.book_id === b.id).length,
          ...counts(b.id),
        }));
      case "import_book": {
        const importBook = () => {
          if (importError) throw importError;
          const error = importErrors[String(args.path)];
          if (error) throw error;
          const imported = data.books.find((b) => b.id === data.import_new!.book_id)!;
          if (books.some((b) => b.id === imported.id)) return data.import_again;
          books = [...books, { ...imported }];
          return data.import_new;
        };
        return importGate ? importGate.then(importBook) : importBook();
      }
      case "find_books":
        return scan ?? data.find_books;
      case "delete_book": {
        const id = args.bookId as number;
        if (!books.some((b) => b.id === id)) throw `no book with id ${id}`;
        books = books.filter((b) => b.id !== id);
        bookmarks = bookmarks.filter((b) => b.book_id !== id);
        highlights = highlights.filter((h) => bookOf(h.content_block_id) !== id);
        notes = notes.filter((n) => bookOf(n.content_block_id) !== id);
        positions.delete(id);
        return null;
      }
      case "update_book_details": {
        const id = args.bookId as number;
        if (!books.some((b) => b.id === id)) throw `no book with id ${id}`;
        books = books.map((b) =>
          b.id === id
            ? { ...b, title: cleanField(args.title), author: cleanField(args.author) }
            : b,
        );
        return null;
      }
      case "search_library": {
        const mode = args.mode as SearchMode;
        const bookId = args.bookId as number | null | undefined;
        // Scoped ranks equal library-wide ones (pinned by the core test
        // search_can_be_limited_to_one_book), so filtering is enough.
        const inScope = bookId == null ? books : books.filter((b) => b.id === bookId);
        if (search) return search(inScope, String(args.query), mode);
        const hits = data.search[`${mode}:${args.query}`] ?? [];
        return hits.filter((h) => inScope.some((b) => b.id === h.book_id)).map(withBookTitle);
      }
      case "semantic_status":
        return { ...(data.semantic_status ?? NO_SEMANTIC), ...semantic };
      case "queue_index":
        return 1;
      case "queue_index_all":
        return books.filter((b) => b.index_state !== "indexed").length;
      case "stop_indexing":
        return null;
      case "search_chapters": {
        const matches = data.chapter_matches?.[String(args.query)] ?? [];
        return matches.filter((m) => books.some((b) => b.id === m.book_id)).map(withBookTitle);
      }
      case "get_book_chapters":
        return data.chapters[String(args.bookId)] ?? [];
      case "get_chapter_content": {
        const content = data.chapter_content[String(args.chapterId)];
        if (!content) throw `no chapter with id ${args.chapterId}`;
        return content;
      }
      case "set_reading_position": {
        const blockId = args.contentBlockId as number;
        blockPlace(blockId);
        positions.set(bookOf(blockId), {
          blockId,
          finished: Boolean(args.finished),
          seq: nextSeq++,
        });
        return null;
      }
      case "get_reading_position":
        return positionOf(args.bookId as number);
      case "list_reading_positions":
        return [...positions.entries()]
          .filter(([, p]) => !p.finished)
          .sort(([, a], [, b]) => b.seq - a.seq)
          .slice(0, args.limit as number)
          .map(([bookId]) => positionOf(bookId)!);
      case "create_bookmark_folder": {
        const folder = {
          id: nextFolderId++,
          name: folderName(args.name),
          created_at: sqliteNow(),
        };
        folders = [...folders, folder];
        return withCount(folder);
      }
      case "rename_bookmark_folder": {
        const id = args.folderId as number;
        const i = folderIndex(id);
        folders[i] = { ...folders[i], name: folderName(args.name, id) };
        return null;
      }
      case "delete_bookmark_folder": {
        const id = args.folderId as number;
        folderIndex(id);
        folders = folders.filter((f) => f.id !== id);
        bookmarks = bookmarks.filter((b) => b.folder_id !== id);
        return null;
      }
      case "list_bookmark_folders":
        return folders
          .map(withCount)
          .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
      case "add_bookmark": {
        const folderId = args.folderId as number;
        const blockId = args.contentBlockId as number;
        folderIndex(folderId);
        const { content, block } = findBlock(blockId);
        const existing = bookmarks.find(
          (b) => b.folder_id === folderId && b.content_block_id === blockId,
        );
        if (existing) return existing.id;
        const bookmark: FolderBookmark = {
          id: nextBookmarkId++,
          folder_id: folderId,
          content_block_id: blockId,
          book_id: content.book_id,
          book_title: books.find((b) => b.id === content.book_id)?.title ?? null,
          chapter_id: content.chapter_id,
          chapter_idx: content.chapter_idx,
          chapter_title: content.chapter_title,
          text: block.text,
        };
        bookmarks = [...bookmarks, bookmark];
        return bookmark.id;
      }
      case "remove_bookmark": {
        const before = bookmarks.length;
        bookmarks = bookmarks.filter(
          (b) => !(b.folder_id === args.folderId && b.content_block_id === args.contentBlockId),
        );
        if (bookmarks.length === before) throw "that passage isn't in this folder";
        return null;
      }
      case "list_folder_bookmarks": {
        const id = args.folderId as number;
        folderIndex(id);
        return bookmarks
          .filter((b) => b.folder_id === id)
          .sort((a, b) => a.id - b.id)
          .map(withBookTitle);
      }
      case "get_chapter_bookmarks": {
        const content = data.chapter_content[String(args.chapterId)];
        const order = new Map(content?.blocks.map((b) => [b.id, b.block_idx]));
        return bookmarks
          .filter((b) => b.chapter_id === args.chapterId)
          .sort(
            (a, b) =>
              order.get(a.content_block_id)! - order.get(b.content_block_id)! ||
              a.folder_id - b.folder_id,
          )
          .map((b): BlockBookmark => ({
            content_block_id: b.content_block_id,
            folder_id: b.folder_id,
          }));
      }
      case "add_highlight": {
        const color = checkColor(args.color);
        const blockId = args.contentBlockId as number;
        const { block } = findBlock(blockId);
        const [start, end] = [args.start as number, args.end as number];
        if (start < 0 || start >= end || end > Array.from(block.text).length) {
          throw `highlight range ${start}..${end} is outside the paragraph`;
        }
        if (
          highlights.some(
            (h) => h.content_block_id === blockId && h.start_offset < end && h.end_offset > start,
          )
        ) {
          throw "that overlaps an existing highlight";
        }
        const highlight: Highlight = {
          id: nextHighlightId++,
          content_block_id: blockId,
          start_offset: start,
          end_offset: end,
          color,
          created_at: sqliteNow(),
        };
        highlights = [...highlights, highlight];
        return highlight;
      }
      case "set_highlight_color": {
        const color = checkColor(args.color);
        const h = findHighlight(args.highlightId as number);
        highlights = highlights.map((x) => (x === h ? { ...h, color } : x));
        return null;
      }
      case "delete_highlight": {
        const h = findHighlight(args.highlightId as number);
        notes = notes.filter((n) => n.highlight_id !== h.id);
        highlights = highlights.filter((x) => x !== h);
        return null;
      }
      case "add_highlight_note":
      case "add_paragraph_note": {
        const body = checkBody(args.body);
        let blockId: number;
        let highlightId: number | null = null;
        if (cmd === "add_highlight_note") {
          const h = findHighlight(args.highlightId as number);
          if (notes.some((n) => n.highlight_id === h.id)) throw "that highlight already has a note";
          blockId = h.content_block_id;
          highlightId = h.id;
        } else {
          blockId = args.contentBlockId as number;
          findBlock(blockId);
          if (notes.some((n) => n.content_block_id === blockId && n.highlight_id == null)) {
            throw "that paragraph already has a note";
          }
        }
        const now = sqliteNow();
        const note: Note = {
          id: nextNoteId++,
          content_block_id: blockId,
          highlight_id: highlightId,
          body,
          created_at: now,
          updated_at: now,
        };
        notes = [...notes, note];
        return note;
      }
      case "update_note": {
        const body = checkBody(args.body);
        const n = findNote(args.noteId as number);
        notes = notes.map((x) => (x === n ? { ...n, body, updated_at: sqliteNow() } : x));
        return null;
      }
      case "delete_note": {
        const n = findNote(args.noteId as number);
        notes = notes.filter((x) => x !== n);
        return null;
      }
      case "get_chapter_annotations": {
        const inChapter = (blockId: number) =>
          blockPlace(blockId).content.chapter_id === args.chapterId;
        return {
          highlights: highlights
            .filter((h) => inChapter(h.content_block_id))
            .sort(byReadingOrder((h) => readingOrder(h.content_block_id, h.id))),
          notes: notes
            .filter((n) => inChapter(n.content_block_id))
            .sort(byReadingOrder((n) => readingOrder(n.content_block_id, n.highlight_id))),
        } satisfies ChapterAnnotations;
      }
      case "list_annotated_books":
        return books
          .map((b): AnnotatedBook => ({
            book_id: b.id,
            title: b.title,
            author: b.author,
            ...counts(b.id),
          }))
          .filter((b) => b.highlight_count > 0 || b.note_count > 0)
          .sort(
            (a, b) =>
              (a.title ?? "").toLowerCase().localeCompare((b.title ?? "").toLowerCase()) ||
              a.book_id - b.book_id,
          );
      case "list_book_annotations": {
        const bookId = args.bookId as number;
        if (!books.some((b) => b.id === bookId)) throw `no book with id ${bookId}`;
        const entry = (
          blockId: number,
          h: Highlight | null,
          note: Note | undefined,
        ): BookAnnotation => {
          const { content, block } = blockPlace(blockId);
          return {
            content_block_id: blockId,
            chapter_id: content.chapter_id,
            chapter_idx: content.chapter_idx,
            chapter_title: content.chapter_title,
            highlight_id: h?.id ?? null,
            color: h?.color ?? null,
            text: h
              ? Array.from(block.text).slice(h.start_offset, h.end_offset).join("")
              : block.text,
            note_id: note?.id ?? null,
            note_body: note?.body ?? null,
          };
        };
        return [
          ...highlights
            .filter((h) => bookOf(h.content_block_id) === bookId)
            .map((h) =>
              entry(
                h.content_block_id,
                h,
                notes.find((n) => n.highlight_id === h.id),
              ),
            ),
          ...notes
            .filter((n) => n.highlight_id == null && bookOf(n.content_block_id) === bookId)
            .map((n) => entry(n.content_block_id, null, n)),
        ].sort(byReadingOrder((e) => readingOrder(e.content_block_id, e.highlight_id)));
      }
      case "backup_library":
        if (backupError) throw backupError;
        return {
          ...fixtures.backup_manifest!,
          counts: {
            books: books.length,
            bookmark_folders: folders.length,
            bookmarks: bookmarks.length,
            highlights: highlights.length,
            notes: notes.length,
          },
        } satisfies BackupManifest;
      case "read_backup_manifest":
        if (backupError) throw backupError;
        return fixtures.backup_manifest;
      case "restore_library":
        if (backupError) throw backupError;
        // As if restoring a backup of the fixture library, which the
        // manifest describes, even when the test started with no books.
        books = withIndexState(data.books);
        folders = startingFolders();
        bookmarks = startingBookmarks();
        highlights = startingHighlights();
        notes = startingNotes();
        positions = new Map();
        return fixtures.backup_manifest!.counts;
      case "backfill_covers":
        if (backfillFound) {
          // After answering, as the app's run happens in the background.
          setTimeout(() => {
            const found = new Set(
              books
                .filter((b) => b.cover == null)
                .slice(0, backfillFound)
                .map((b) => b.id),
            );
            books = books.map((b) => (found.has(b.id) ? { ...b, cover: "mock" } : b));
            const payload: CoverBackfill = { checked: found.size, found: found.size };
            emit("covers_found", payload);
          }, 0);
        }
        return null;
      case "plugin:opener|open_url":
        openedUrls.push(args.url as string);
        return undefined;
      case "plugin:dialog|save":
        return savePath;
      case "plugin:dialog|open": {
        const options = args.options as { directory?: boolean } | undefined;
        return options?.directory ? openDir : openPath;
      }
      case "plugin:dialog|message": {
        // `ask` resolves true when the answer equals its okLabel.
        const buttons = args.buttons as { OkCancelCustom?: [string, string] } | undefined;
        const [ok, cancel] = buttons?.OkCancelCustom ?? ["Yes", "No"];
        return confirm ? ok : cancel;
      }
      default:
        throw new Error(`unmocked command: ${cmd}`);
    }
  }

  mockIPC(
    (cmd, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args });
      const gate = gates[cmd];
      return gate ? gate.then(() => answer(cmd, args)) : answer(cmd, args);
    },
    { shouldMockEvents: true },
  );
  // Book covers are `cover://localhost/…` URLs, as on Linux. Nothing serves
  // them in a browser or jsdom, so `npm run dev:mock` and the demo show the
  // generated covers that a failed image falls back to.
  mockConvertFileSrc("linux");

  return { calls, openedUrls };
}

/** Sends the events the app sends while it indexes a book for chapter search. */
export const indexingEvents = {
  progress: (payload: SemanticIndexProgress) => emit("semantic_index_progress", payload),
  failed: (payload: SemanticIndexFailed) => emit("semantic_index_failed", payload),
  stopped: (payload: SemanticIndexStopped) => emit("semantic_index_stopped", payload),
  paused: () => emit("semantic_index_paused"),
};
