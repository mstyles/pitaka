import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import type {
  BookSummary,
  EpubScan,
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

/** Where a folder import is up to, or how it ended; see `useFolderImport`. */
export type FolderImport = {
  dir: string;
  /** EPUBs found; 0 while the folder is still being scanned. */
  total: number;
  done: number;
  imported: number;
  already: number;
  failures: { path: string; error: string }[];
  running: boolean;
  /** Stop was clicked and books were left unimported. */
  stopped: boolean;
  /** The folder itself couldn't be read. */
  scanError?: string;
};

/**
 * Imports every EPUB under a folder, one `import_book` call per book, so the
 * library lock is released between books. Called from App, which stays
 * mounted, so the import carries on while you're on other screens.
 */
export function useFolderImport(onLibraryChanged: () => void) {
  const [folderImport, setFolderImport] = useState<FolderImport | null>(null);
  const runningRef = useRef(false);
  const stopRef = useRef(false);

  function update(change: (prev: FolderImport) => FolderImport) {
    setFolderImport((prev) => prev && change(prev));
  }

  async function startFolderImport(dir: string) {
    if (runningRef.current) return;
    runningRef.current = true;
    stopRef.current = false;
    setFolderImport({
      dir,
      total: 0,
      done: 0,
      imported: 0,
      already: 0,
      failures: [],
      running: true,
      stopped: false,
    });
    try {
      let scan: EpubScan;
      try {
        scan = await invoke<EpubScan>("find_epubs", { dir });
      } catch (err) {
        update((p) => ({ ...p, running: false, scanError: String(err) }));
        return;
      }
      update((p) => ({
        ...p,
        total: scan.paths.length,
        failures: scan.unreadable.map((path) => ({ path, error: "couldn't be read" })),
      }));

      let imported = 0;
      for (const path of scan.paths) {
        if (stopRef.current) {
          update((p) => ({ ...p, stopped: true }));
          break;
        }
        try {
          const { already_imported } = await invoke<ImportOutcome>("import_book", { path });
          if (!already_imported) imported++;
          update((p) =>
            already_imported
              ? { ...p, done: p.done + 1, already: p.already + 1 }
              : { ...p, done: p.done + 1, imported: p.imported + 1 },
          );
        } catch (err) {
          update((p) => ({
            ...p,
            done: p.done + 1,
            failures: [...p.failures, { path, error: String(err) }],
          }));
        }
      }
      update((p) => ({ ...p, running: false }));
      // Once, not per book: a kept search re-runs on every library change.
      if (imported > 0) onLibraryChanged();
    } finally {
      runningRef.current = false;
    }
  }

  /** Ends the import after the book in flight, which can't be cancelled. */
  function stopFolderImport() {
    stopRef.current = true;
  }

  /** Drops a finished import's summary, when another import starts. */
  function clearFolderImport() {
    if (!runningRef.current) setFolderImport(null);
  }

  return { folderImport, startFolderImport, stopFolderImport, clearFolderImport };
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function folderImportLine(f: FolderImport) {
  if (f.scanError) return `Import failed: ${f.scanError}`;
  if (f.running) {
    return f.total === 0
      ? `Looking for books in ${f.dir}…`
      : `Importing ${Math.min(f.done + 1, f.total)} of ${f.total}…`;
  }
  if (f.total === 0) return `No EPUB files in ${f.dir}`;
  const prefix = f.stopped ? `Stopped after ${f.done} of ${f.total}: ` : "";
  if (f.imported === 0 && f.failures.length === 0 && f.already > 0) {
    return `${prefix}Nothing new: ${f.already} already in library`;
  }
  const parts = [];
  if (f.imported > 0) parts.push(`Imported ${plural(f.imported, "book")}`);
  if (f.already > 0) parts.push(`${f.already} already in library`);
  if (f.failures.length > 0) parts.push(`${f.failures.length} failed`);
  return prefix + (parts.length > 0 ? parts.join(", ") : "nothing imported");
}

/** A failed path as it sits under the picked folder. */
function relativePath(path: string, dir: string) {
  return path.startsWith(dir) ? path.slice(dir.length).replace(/^[\\/]+/, "") : path;
}

type Props = {
  onOpenBook: (bookId: number) => void;
  /** Called after a book is added or removed, so a kept search can re-run. */
  onLibraryChanged: () => void;
  indexing: Indexing;
} & ReturnType<typeof useFolderImport>;

function BooksView({
  onOpenBook,
  onLibraryChanged,
  indexing,
  folderImport,
  startFolderImport,
  stopFolderImport,
  clearFolderImport,
}: Props) {
  const [importStatus, setImportStatus] = useState("");
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const importing = folderImport?.running ?? false;

  async function refreshBooks() {
    try {
      setBooks(await invoke<BookSummary[]>("list_books"));
    } catch (err) {
      setImportStatus(`Loading library failed: ${err}`);
    }
  }

  // Remounted on every visit, including on return from the reader; and
  // refreshed as a folder import adds books, so the list fills in.
  useEffect(() => {
    refreshBooks();
  }, [folderImport?.imported]);

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

    clearFolderImport();
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

  async function importFolder() {
    const dir = await open({ directory: true, multiple: false });
    if (!dir || Array.isArray(dir)) return;
    // The row shows whichever import happened last.
    setImportStatus("");
    startFolderImport(dir);
  }

  async function removeBook(book: BookSummary) {
    const title = book.title ?? "Untitled";
    const marked = [
      [book.bookmark_count, "bookmark"],
      [book.highlight_count, "highlight"],
      [book.note_count, "note"],
    ] as const;
    const parts = marked.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
    const list =
      parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
    const lost = list ? ` Its ${list} will be deleted too.` : "";
    const confirmed = await ask(
      `Remove "${title}" from the library?${lost} The EPUB file won't be deleted.`,
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
        <button className="button-primary" onClick={importBook} disabled={importing}>
          Import EPUB…
        </button>
        <button onClick={importFolder} disabled={importing}>
          Import folder…
        </button>
        {importing && <button onClick={stopFolderImport}>Stop</button>}
        <span>{importStatus || (folderImport && folderImportLine(folderImport))}</span>
      </div>
      {folderImport && folderImport.failures.length > 0 && (
        <ul className="import-failures">
          {folderImport.failures.map(({ path, error }) => (
            <li key={path}>
              <span className="import-failure-path">{relativePath(path, folderImport.dir)}</span>
              : {error}
            </li>
          ))}
        </ul>
      )}
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
