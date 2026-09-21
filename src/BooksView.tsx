import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import type { BookSummary, ImportOutcome } from "./types";

type Props = {
  onOpenBook: (bookId: number) => void;
  /** Called after a book is added or removed, so a kept search can re-run. */
  onLibraryChanged: () => void;
};

function BooksView({ onOpenBook, onLibraryChanged }: Props) {
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
