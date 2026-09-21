// Answers the frontend's `invoke` calls from fixtures written by the core
// test `ui_fixtures_are_current` (UPDATE_UI_FIXTURES=1 regenerates them), so
// the UI can run in jsdom or a plain browser tab without the Rust side.
import { mockIPC } from "@tauri-apps/api/mocks";
import fixtureData from "./fixtures/library.json";
import type {
  BlockBookmark,
  BookmarkFolder,
  BookSummary,
  ChapterContent,
  ChapterSummary,
  FolderBookmark,
  ImportOutcome,
  SearchResult,
} from "../types";

type Fixtures = {
  import_new: ImportOutcome;
  import_again: ImportOutcome;
  books: BookSummary[];
  chapters: Record<string, ChapterSummary[]>;
  chapter_content: Record<string, ChapterContent>;
  search: Record<string, SearchResult[]>;
  bookmark_folders: BookmarkFolder[];
  folder_bookmarks: Record<string, FolderBookmark[]>;
};

export const fixtures = fixtureData as Fixtures;

export type MockOptions = {
  /** What the "Import EPUB…" file picker returns; null means cancelled. */
  openPath?: string | null;
  /** Whether confirmation dialogs (remove book, delete folder) are accepted. */
  confirm?: boolean;
  /** The library to start with, in place of the fixture books. */
  books?: BookSummary[];
  /** Commands that should reject, with the error message to reject with. */
  fail?: Partial<Record<string, string>>;
};

export type MockCall = { cmd: string; args: Record<string, unknown> };

/** Like SQLite's datetime('now'), which `created_at` defaults to. */
function sqliteNow() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export function installMockBackend({
  openPath = "/books/test.epub",
  confirm = true,
  fail = {},
  books: initialBooks = fixtures.books,
}: MockOptions = {}) {
  const calls: MockCall[] = [];
  let books = initialBooks.map((b) => ({ ...b }));
  const imported = fixtures.books.find((b) => b.id === fixtures.import_new.book_id)!;

  // Bookmark state, seeded from the fixtures and kept consistent the way the
  // SQL is: counts are derived, and deletes cascade.
  let folders = fixtures.bookmark_folders.map(({ bookmark_count: _, ...f }) => ({ ...f }));
  let bookmarks: FolderBookmark[] = Object.values(fixtures.folder_bookmarks).flat();
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
  function findBlock(blockId: number) {
    for (const content of Object.values(fixtures.chapter_content)) {
      const block = content.blocks.find((b) => b.id === blockId);
      if (block && books.some((b) => b.id === content.book_id)) return { content, block };
    }
    throw `no paragraph with id ${blockId}`;
  }

  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    if (fail[cmd]) throw fail[cmd];

    switch (cmd) {
      case "list_books":
        return books.map((b) => ({
          ...b,
          bookmark_count: bookmarks.filter((bm) => bm.book_id === b.id).length,
        }));
      case "import_book":
        if (books.some((b) => b.id === imported.id)) return fixtures.import_again;
        books = [...books, { ...imported }];
        return fixtures.import_new;
      case "delete_book": {
        const id = args.bookId as number;
        if (!books.some((b) => b.id === id)) throw `no book with id ${id}`;
        books = books.filter((b) => b.id !== id);
        bookmarks = bookmarks.filter((b) => b.book_id !== id);
        return null;
      }
      case "search_library": {
        const hits = fixtures.search[`${args.mode}:${args.query}`] ?? [];
        return hits.filter((h) => books.some((b) => b.id === h.book_id));
      }
      case "get_book_chapters":
        return fixtures.chapters[String(args.bookId)] ?? [];
      case "get_chapter_content": {
        const content = fixtures.chapter_content[String(args.chapterId)];
        if (!content) throw `no chapter with id ${args.chapterId}`;
        return content;
      }
      case "create_bookmark_folder": {
        const folder = { id: nextFolderId++, name: folderName(args.name), created_at: sqliteNow() };
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
        return bookmarks.filter((b) => b.folder_id === id).sort((a, b) => a.id - b.id);
      }
      case "get_chapter_bookmarks": {
        const content = fixtures.chapter_content[String(args.chapterId)];
        const order = new Map(content?.blocks.map((b) => [b.id, b.block_idx]));
        return bookmarks
          .filter((b) => b.chapter_id === args.chapterId)
          .sort(
            (a, b) =>
              order.get(a.content_block_id)! - order.get(b.content_block_id)! ||
              a.folder_id - b.folder_id,
          )
          .map((b): BlockBookmark => ({ content_block_id: b.content_block_id, folder_id: b.folder_id }));
      }
      case "plugin:dialog|open":
        return openPath;
      case "plugin:dialog|message": {
        // `ask` resolves true when the answer equals its okLabel.
        const buttons = args.buttons as { OkCancelCustom?: [string, string] } | undefined;
        const [ok, cancel] = buttons?.OkCancelCustom ?? ["Yes", "No"];
        return confirm ? ok : cancel;
      }
      default:
        throw new Error(`unmocked command: ${cmd}`);
    }
  });

  return { calls };
}
