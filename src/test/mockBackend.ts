// Answers the frontend's `invoke` calls from fixtures written by the core
// test `ui_fixtures_are_current` (UPDATE_UI_FIXTURES=1 regenerates them), so
// the UI can run in jsdom or a plain browser tab without the Rust side.
import { mockIPC } from "@tauri-apps/api/mocks";
import fixtureData from "./fixtures/library.json";
import type {
  BookSummary,
  ChapterContent,
  ChapterSummary,
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
};

export const fixtures = fixtureData as Fixtures;

export type MockOptions = {
  /** What the "Import EPUB…" file picker returns; null means cancelled. */
  openPath?: string | null;
  /** Whether the "Remove book" confirmation is accepted. */
  confirm?: boolean;
  /** Commands that should reject, with the error message to reject with. */
  fail?: Partial<Record<string, string>>;
};

export type MockCall = { cmd: string; args: Record<string, unknown> };

export function installMockBackend({
  openPath = "/books/test.epub",
  confirm = true,
  fail = {},
}: MockOptions = {}) {
  const calls: MockCall[] = [];
  let books = fixtures.books.map((b) => ({ ...b }));
  const imported = fixtures.books.find((b) => b.id === fixtures.import_new.book_id)!;

  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    if (fail[cmd]) throw fail[cmd];

    switch (cmd) {
      case "list_books":
        return books;
      case "import_book":
        if (books.some((b) => b.id === imported.id)) return fixtures.import_again;
        books = [...books, { ...imported }];
        return fixtures.import_new;
      case "delete_book": {
        const id = args.bookId as number;
        if (!books.some((b) => b.id === id)) throw `no book with id ${id}`;
        books = books.filter((b) => b.id !== id);
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
      case "plugin:dialog|open":
        return openPath;
      case "plugin:dialog|message":
        return confirm ? "Remove" : "Cancel";
      default:
        throw new Error(`unmocked command: ${cmd}`);
    }
  });

  return { calls };
}
