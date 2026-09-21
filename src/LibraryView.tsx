import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import FolderView from "./FolderView";
import type {
  BookmarkFolder,
  BookSummary,
  FolderBookmark,
  ImportOutcome,
  SearchMode,
  SearchResult,
} from "./types";

type Props = {
  /** False while the reader is open; counts are refetched on return. */
  active: boolean;
  onOpenBook: (bookId: number) => void;
  onOpenSearchResult: (result: SearchResult) => void;
  onOpenBookmark: (bookmark: FolderBookmark) => void;
};

function LibraryView({ active, onOpenBook, onOpenSearchResult, onOpenBookmark }: Props) {
  const [importStatus, setImportStatus] = useState("");
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [exactWords, setExactWords] = useState(false);
  const [folders, setFolders] = useState<BookmarkFolder[]>([]);
  const [openFolderId, setOpenFolderId] = useState<number | null>(null);
  const [newFolderName, setNewFolderName] = useState("");

  async function refreshBooks() {
    try {
      setBooks(await invoke<BookSummary[]>("list_books"));
    } catch (err) {
      setImportStatus(`Loading library failed: ${err}`);
    }
  }

  async function refreshFolders() {
    try {
      setFolders(await invoke<BookmarkFolder[]>("list_bookmark_folders"));
    } catch (err) {
      setImportStatus(`Loading bookmark folders failed: ${err}`);
    }
  }

  // On mount, and on return from the reader, which may have changed bookmarks.
  useEffect(() => {
    if (!active) return;
    refreshBooks();
    refreshFolders();
  }, [active]);

  async function createFolder() {
    try {
      await invoke<BookmarkFolder>("create_bookmark_folder", { name: newFolderName });
      setNewFolderName("");
      await refreshFolders();
    } catch (err) {
      setImportStatus(`Creating folder failed: ${err}`);
    }
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
      // Hits in the removed book would open a book that no longer exists.
      setResults((hits) => hits.filter((r) => r.book_id !== book.id));
      await Promise.all([refreshBooks(), refreshFolders()]);
    } catch (err) {
      setImportStatus(`Remove failed: ${err}`);
    }
  }

  async function runSearch(exact: boolean) {
    if (!query.trim()) return;
    const mode: SearchMode = exact ? "exact" : "stemmed";
    setSearching(true);
    try {
      const hits = await invoke<SearchResult[]>("search_library", { query, mode });
      setResults(hits);
    } catch (err) {
      setImportStatus(`Search failed: ${err}`);
    } finally {
      setSearching(false);
    }
  }

  function toggleExactWords(exact: boolean) {
    setExactWords(exact);
    // Re-run straight away so the two modes are easy to compare.
    runSearch(exact);
  }

  const openFolder = folders.find((f) => f.id === openFolderId);
  if (openFolder) {
    return (
      <FolderView
        folder={openFolder}
        active={active}
        onBack={() => setOpenFolderId(null)}
        onOpenBookmark={onOpenBookmark}
        onChanged={refreshFolders}
      />
    );
  }

  return (
    <main className="container">
      <h1>Pitaka</h1>

      <div className="row">
        <button onClick={importBook}>Import EPUB…</button>
        <span>{importStatus}</span>
      </div>

      <ul className="book-list">
        {books.map((b) => (
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

      <section className="folders">
        <h2>Bookmarks</h2>
        {folders.length === 0 ? (
          <p className="folders-empty">
            No bookmark folders yet. Create one here, or bookmark a passage while reading.
          </p>
        ) : (
          <ul className="folder-list">
            {folders.map((f) => (
              <li key={f.id} className="folder-row" onClick={() => setOpenFolderId(f.id)}>
                <span className="folder-row-name">{f.name}</span>
                <span className="book-meta">
                  {f.bookmark_count === 1 ? "1 passage" : `${f.bookmark_count} passages`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            createFolder();
          }}
        >
          <input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.currentTarget.value)}
            placeholder="New folder name"
          />
          <button type="submit">Create</button>
        </form>
      </section>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          runSearch(exactWords);
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="Search your library…"
        />
        <button type="submit" disabled={searching}>
          {searching ? "Searching…" : "Search"}
        </button>
        <label
          className="search-mode"
          title="Match whole words as typed, without matching related forms (e.g. learn / learning)"
        >
          <input
            type="checkbox"
            checked={exactWords}
            onChange={(e) => toggleExactWords(e.currentTarget.checked)}
          />
          Exact words
        </label>
      </form>

      <ul className="results">
        {results.map((r) => (
          <li key={r.content_block_id} onClick={() => onOpenSearchResult(r)}>
            <div className="result-meta">
              {r.book_title ?? "Untitled"} — chapter {r.chapter_idx}
            </div>
            <div
              className="result-snippet"
              dangerouslySetInnerHTML={{
                __html: r.snippet
                  .split("[").join("<mark>")
                  .split("]").join("</mark>"),
              }}
            />
          </li>
        ))}
      </ul>
    </main>
  );
}

export default LibraryView;
