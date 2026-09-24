import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import type {
  BookSummary,
  ImportOutcome,
  SemanticIndexFailed,
  SemanticIndexProgress,
} from "./types";

/** The latest indexing event; see `useIndexing`. */
export type Indexing =
  | ({ kind: "progress" } & SemanticIndexProgress)
  | ({ kind: "failed" } & SemanticIndexFailed)
  | null;

/**
 * Follows the background indexing that runs after an import, which takes
 * minutes. Called from App, which stays mounted, so the Books screen shows
 * where a run is up to on every visit, not just once its next chapter ends.
 */
export function useIndexing() {
  const [indexing, setIndexing] = useState<Indexing>(null);
  useEffect(() => {
    const unlisteners = [
      listen<SemanticIndexProgress>("semantic_index_progress", (e) =>
        setIndexing({ kind: "progress", ...e.payload }),
      ),
      listen<SemanticIndexFailed>("semantic_index_failed", (e) =>
        setIndexing({ kind: "failed", ...e.payload }),
      ),
    ];
    return () => {
      for (const unlisten of unlisteners) unlisten.then((f) => f());
    };
  }, []);
  // Once the Books screen has shown a finished or failed run, it's done with.
  function dismissFinished() {
    setIndexing((prev) => (prev?.kind === "progress" && prev.done < prev.total ? prev : null));
  }
  return { indexing, dismissFinished };
}

type Props = {
  onOpenBook: (bookId: number) => void;
  /** Called after a book is added or removed, so a kept search can re-run. */
  onLibraryChanged: () => void;
  indexing: Indexing;
};

function BooksView({ onOpenBook, onLibraryChanged, indexing }: Props) {
  const [importStatus, setImportStatus] = useState("");
  const [books, setBooks] = useState<BookSummary[] | null>(null);

  async function refreshBooks() {
    try {
      setBooks(await invoke<BookSummary[]>("list_books"));
    } catch (err) {
      setImportStatus(`Loading library failed: ${err}`);
    }
  }

  // Remounted on every visit, including on return from the reader.
  useEffect(() => {
    refreshBooks();
  }, []);

  function indexingLine() {
    if (!indexing) return null;
    const book = books?.find((b) => b.id === indexing.book_id);
    const title = book ? (book.title ?? "Untitled") : `book #${indexing.book_id}`;
    if (indexing.kind === "failed") {
      return `Indexing ${title} for chapter search failed: ${indexing.error}`;
    }
    const { done, total } = indexing;
    if (done === total) return `Indexed ${title} for chapter search`;
    return `Indexing ${title} for chapter search… ${done}/${total} chapters`;
  }

  async function importBook() {
    const path = await open({
      multiple: false,
      filters: [{ name: "EPUB", extensions: ["epub"] }],
    });
    if (!path || Array.isArray(path)) return;

    setImportStatus(`Importing ${path}…`);
    try {
      const { book_id, already_imported } = await invoke<ImportOutcome>("import_book", { path });
      setImportStatus(
        already_imported ? `Already in library as book #${book_id}` : `Imported book #${book_id}`,
      );
      if (!already_imported) onLibraryChanged();
      await refreshBooks();
    } catch (err) {
      setImportStatus(`Import failed: ${err}`);
    }
  }

  async function removeBook(book: BookSummary) {
    const title = book.title ?? "Untitled";
    const n = book.bookmark_count;
    const bookmarks = n > 0 ? ` Its ${n} bookmark${n === 1 ? "" : "s"} will be deleted too.` : "";
    const confirmed = await ask(
      `Remove "${title}" from the library?${bookmarks} The EPUB file won't be deleted.`,
      { title: "Remove book", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" },
    );
    if (!confirmed) return;

    try {
      await invoke("delete_book", { bookId: book.id });
      setImportStatus(`Removed "${title}"`);
      onLibraryChanged();
      await refreshBooks();
    } catch (err) {
      setImportStatus(`Remove failed: ${err}`);
    }
  }

  return (
    <main className="container">
      <h1>Books</h1>

      <div className="row">
        <button className="button-primary" onClick={importBook}>Import EPUB…</button>
        <span>{importStatus}</span>
      </div>
      {indexing && <p className="index-progress">{indexingLine()}</p>}

      {books?.length === 0 ? (
        <p className="section-empty">No books yet. Import an EPUB to start.</p>
      ) : (
        <ul className="book-list">
          {books?.map((b) => (
            <li key={b.id} className="book-row" onClick={() => onOpenBook(b.id)}>
              <span className="book-title">{b.title ?? "Untitled"}</span>
              <span className="book-meta">
                {b.author ?? "Unknown author"} · {b.chapter_count} chapters
              </span>
              <button
                className="book-remove"
                onClick={(e) => {
                  e.stopPropagation(); // the row itself opens the book
                  removeBook(b);
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

export default BooksView;
