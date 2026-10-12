import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import type {
  BackupManifest,
  BookSummary,
  BookScan,
  ImportOutcome,
  LibraryCounts,
  SemanticIndexFailed,
  SemanticIndexProgress,
  SemanticIndexStopped,
  SemanticStatus,
} from "./types";

/** The latest indexing event; see `useIndexing`. */
export type Indexing =
  | ({ kind: "progress" } & SemanticIndexProgress)
  | ({ kind: "failed" } & SemanticIndexFailed)
  | ({ kind: "stopped" } & SemanticIndexStopped)
  | null;

/**
 * Follows background indexing for chapter search, which takes minutes a
 * book, and queues books for it. Called from App, which stays mounted, so
 * the Books screen shows where a run is up to on every visit, not just once
 * its next chapter ends.
 */
export function useIndexing() {
  const [indexing, setIndexing] = useState<Indexing>(null);
  /** Stop indexing was clicked: new imports aren't indexed until Index is. */
  const [paused, setPaused] = useState(false);
  /** Books queued from this screen that haven't finished, failed or been stopped. */
  const [queued, setQueued] = useState<ReadonlySet<number>>(new Set());

  function unqueue(bookId: number) {
    setQueued((prev) => {
      if (!prev.has(bookId)) return prev;
      const next = new Set(prev);
      next.delete(bookId);
      return next;
    });
  }

  useEffect(() => {
    const unlisteners = [
      listen<SemanticIndexProgress>("semantic_index_progress", (e) => {
        setIndexing({ kind: "progress", ...e.payload });
        if (e.payload.done === e.payload.total) unqueue(e.payload.book_id);
      }),
      listen<SemanticIndexFailed>("semantic_index_failed", (e) => {
        setIndexing({ kind: "failed", ...e.payload });
        unqueue(e.payload.book_id);
      }),
      listen<SemanticIndexStopped>("semantic_index_stopped", (e) => {
        setIndexing({ kind: "stopped", ...e.payload });
        unqueue(e.payload.book_id);
      }),
      listen("semantic_index_paused", () => setPaused(true)),
    ];
    return () => {
      for (const unlisten of unlisteners) unlisten.then((f) => f());
    };
  }, []);

  // Once the Books screen has shown a finished, failed or stopped run, it's
  // done with.
  function dismissFinished() {
    setIndexing((prev) => (prev?.kind === "progress" && prev.done < prev.total ? prev : null));
  }

  function queue(bookIds: number[]) {
    setPaused(false);
    setQueued((prev) => new Set([...prev, ...bookIds]));
  }

  async function queueIndex(bookId: number) {
    await invoke<number>("queue_index", { bookId });
    queue([bookId]);
  }

  /** `bookIds` are the books that aren't indexed, which the backend queues. */
  async function queueIndexAll(bookIds: number[]) {
    await invoke<number>("queue_index_all");
    queue(bookIds);
  }

  async function stopIndexing() {
    await invoke("stop_indexing");
    setPaused(true);
    setQueued(new Set());
  }

  return {
    indexing,
    paused,
    queued,
    dismissFinished,
    queueIndex,
    queueIndexAll,
    stopIndexing,
  };
}

export type IndexingControls = Omit<ReturnType<typeof useIndexing>, "dismissFinished">;

/** Where a folder import is up to, or how it ended; see `useFolderImport`. */
export type FolderImport = {
  dir: string;
  /** Books found; 0 while the folder is still being scanned. */
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
 * Imports every EPUB and PDF under a folder, one `import_book` call per
 * book, so the library lock is released between books. Called from App, which stays
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
      let scan: BookScan;
      try {
        scan = await invoke<BookScan>("find_books", { dir });
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

const INDEX_STATE_NOTES: Record<BookSummary["index_state"], string> = {
  none: " · not in chapter search",
  partial: " · partly indexed",
  indexed: "",
};

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "a, b and c". */
function listOf(parts: string[]) {
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
    : (parts[0] ?? "");
}

/** What a library holds, leaving out what it has none of, books aside. */
export function countsLine(c: LibraryCounts) {
  const counted = [
    [c.bookmark_folders, "bookmark folder"],
    [c.bookmarks, "bookmark"],
    [c.highlights, "highlight"],
    [c.notes, "note"],
  ] as const;
  return listOf([
    plural(c.books, "book"),
    ...counted.filter(([n]) => n > 0).map(([n, w]) => plural(n, w)),
  ]);
}

const BACKUP_FILTERS = [{ name: "Pitaka backup", extensions: ["pitaka"] }];

/** Today as YYYY-MM-DD, for the backup's suggested file name. */
function today() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Lower case without accents, so "thich" finds "Thích". */
function fold(s: string) {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Whether every word of `filter` appears in the book's title or author, as
 * the row shows them, in any order: "nhat hanh heart" finds a book whose
 * author is stored as "Hanh, Thich Nhat".
 */
export function matchesFilter(book: BookSummary, filter: string) {
  const text = fold(`${book.title ?? "Untitled"} ${book.author ?? "Unknown author"}`);
  return fold(filter)
    .split(/\s+/)
    .every((word) => text.includes(word));
}

export type BookSort = "title" | "added";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** A title as a catalogue files it: "The Sun My Heart" under S. */
function titleKey(title: string) {
  return title.replace(/^(the|an?)\s+/i, "");
}

/** By title, untitled books last; or as `list_books` returns them, newest first. */
export function sortBooks(books: BookSummary[], sort: BookSort) {
  if (sort === "added") return [...books];
  return [...books].sort((a, b) => {
    if (a.title == null || b.title == null) {
      if (a.title != null) return -1;
      if (b.title != null) return 1;
    } else {
      const byTitle = collator.compare(titleKey(a.title), titleKey(b.title));
      if (byTitle !== 0) return byTitle;
    }
    return collator.compare(a.author ?? "", b.author ?? "") || a.id - b.id;
  });
}

function folderImportLine(f: FolderImport) {
  if (f.scanError) return `Import failed: ${f.scanError}`;
  if (f.running) {
    return f.total === 0
      ? `Looking for books in ${f.dir}…`
      : `Importing ${Math.min(f.done + 1, f.total)} of ${f.total}…`;
  }
  if (f.total === 0) return `No EPUB or PDF files in ${f.dir}`;
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
  /** Called after a restore replaces the whole library. */
  onLibraryReplaced: () => void;
  indexer: IndexingControls;
  /** Kept by App, so they survive opening a book and coming back. */
  filter: string;
  onFilterChange: (filter: string) => void;
  sort: BookSort;
  onSortChange: (sort: BookSort) => void;
} & ReturnType<typeof useFolderImport>;

const PAUSED_NOTE = "New imports won't be indexed until you click Index or Index all books.";

function BooksView({
  onOpenBook,
  onLibraryChanged,
  onLibraryReplaced,
  indexer,
  filter,
  onFilterChange,
  sort,
  onSortChange,
  folderImport,
  startFolderImport,
  stopFolderImport,
  clearFolderImport,
}: Props) {
  const [importStatus, setImportStatus] = useState("");
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  /** The row whose title and author are being edited, with what's typed. */
  const [editing, setEditing] = useState<{ id: number; title: string; author: string } | null>(
    null,
  );
  /** Whether this build has chapter search; nothing about indexing shows without it. */
  const [canIndex, setCanIndex] = useState(false);
  const importing = folderImport?.running ?? false;
  const { indexing, paused, queued } = indexer;
  /** The book being indexed right now, if any. */
  const current =
    indexing?.kind === "progress" && indexing.done < indexing.total ? indexing.book_id : null;

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

  useEffect(() => {
    invoke<SemanticStatus>("semantic_status")
      .then((status) => setCanIndex(status.available))
      .catch(() => setCanIndex(false));
  }, []);

  // A book that finished, failed or stopped has a new index state to show.
  const settled =
    indexing && !(indexing.kind === "progress" && indexing.done < indexing.total)
      ? `${indexing.kind}:${indexing.book_id}`
      : null;
  useEffect(() => {
    if (settled) refreshBooks();
  }, [settled]);

  function indexingLine() {
    if (!indexing) return paused ? `Stopped indexing. ${PAUSED_NOTE}` : null;
    const book = books?.find((b) => b.id === indexing.book_id);
    const title = book ? (book.title ?? "Untitled") : `book #${indexing.book_id}`;
    if (indexing.kind === "failed") {
      return `Indexing ${title} for chapter search failed: ${indexing.error}`;
    }
    const { done, total } = indexing;
    if (indexing.kind === "stopped") {
      return `Stopped indexing ${title} at ${done}/${total} chapters. ${PAUSED_NOTE}`;
    }
    if (done === total) return `Indexed ${title} for chapter search`;
    if (paused) return `Stopping indexing ${title} after the chapter in progress…`;
    const more = indexing.queued > 0 ? ` · ${plural(indexing.queued, "more book")} queued` : "";
    return `Indexing ${title} for chapter search… ${done}/${total} chapters${more}`;
  }

  async function act(action: () => Promise<unknown>, failure: string) {
    try {
      await action();
    } catch (err) {
      setImportStatus(`${failure}: ${err}`);
    }
  }

  const unindexed = books?.filter((b) => b.index_state !== "indexed") ?? [];
  const anyQueued = books?.some((b) => queued.has(b.id)) ?? false;
  const line = indexingLine();
  // Index all books and the indexing line still use the whole library.
  const shown =
    books &&
    sortBooks(
      books.filter((b) => matchesFilter(b, filter)),
      sort,
    );
  const filtering = filter.trim() !== "";

  async function importBook() {
    const path = await open({
      multiple: false,
      filters: [{ name: "EPUB or PDF", extensions: ["epub", "pdf"] }],
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

  async function backUp() {
    const path = await save({
      defaultPath: `pitaka-backup-${today()}.pitaka`,
      filters: BACKUP_FILTERS,
    });
    if (!path) return;

    clearFolderImport();
    setImportStatus("Backing up…");
    try {
      const { counts } = await invoke<BackupManifest>("backup_library", { path });
      setImportStatus(`Backed up ${countsLine(counts)} to ${path}`);
    } catch (err) {
      setImportStatus(`Backup failed: ${err}`);
    }
  }

  async function restore() {
    const path = await open({ multiple: false, filters: BACKUP_FILTERS });
    if (!path || Array.isArray(path)) return;

    clearFolderImport();
    let manifest: BackupManifest;
    try {
      manifest = await invoke<BackupManifest>("read_backup_manifest", { path });
    } catch (err) {
      setImportStatus(`Restore failed: ${err}`);
      return;
    }
    const fileName = path.split(/[\\/]/).pop();
    const date = new Date(manifest.created_at).toLocaleDateString(undefined, {
      dateStyle: "medium",
    });
    const confirmed = await ask(
      `${fileName} was backed up on ${date} by Pitaka ${manifest.app_version} and holds ` +
        `${countsLine(manifest.counts)}. Restoring replaces every book, bookmark folder, ` +
        `highlight and note in Pitaka with these. Your current library is saved first as ` +
        `library-before-restore.pitaka in Pitaka's data folder.`,
      { title: "Restore backup?", kind: "warning", okLabel: "Restore", cancelLabel: "Cancel" },
    );
    if (!confirmed) return;

    setImportStatus("Restoring…");
    try {
      const counts = await invoke<LibraryCounts>("restore_library", { path });
      setImportStatus(`Restored ${countsLine(counts)}`);
      onLibraryReplaced();
      await refreshBooks();
    } catch (err) {
      setImportStatus(`Restore failed: ${err}`);
    }
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
      parts.length > 1
        ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
        : parts[0];
    const lost = list ? ` Its ${list} will be deleted too.` : "";
    const confirmed = await ask(
      `Remove "${title}" from the library?${lost} The book's file won't be deleted.`,
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

  async function saveDetails() {
    if (!editing) return;
    const { id, title, author } = editing;
    try {
      await invoke("update_book_details", { bookId: id, title, author });
      const newTitle = title.trim().replace(/\s+/g, " ") || null;
      setEditing(null);
      setImportStatus(`Updated "${newTitle ?? "Untitled"}"`);
      onLibraryChanged();
      await refreshBooks();
    } catch (err) {
      setImportStatus(`Saving failed: ${err}`);
    }
  }

  function cancelOnEscape(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") setEditing(null);
  }

  return (
    <main className="container">
      <h1>Books</h1>

      <div className="row">
        <button className="button-primary" onClick={importBook} disabled={importing}>
          Import book
        </button>
        <button onClick={importFolder} disabled={importing}>
          Import folder
        </button>
        <button onClick={backUp} disabled={importing}>
          Back up
        </button>
        <button
          onClick={restore}
          disabled={importing || anyQueued}
          title={anyQueued ? "Stop indexing to restore a backup" : undefined}
        >
          Restore
        </button>
        {canIndex && unindexed.length > 0 && !anyQueued && (
          <button
            onClick={() =>
              act(() => indexer.queueIndexAll(unindexed.map((b) => b.id)), "Indexing failed")
            }
          >
            Index all books
          </button>
        )}
        {importing && <button onClick={stopFolderImport}>Stop import</button>}
        <span>{importStatus || (folderImport && folderImportLine(folderImport))}</span>
      </div>
      {folderImport && folderImport.failures.length > 0 && (
        <ul className="import-failures">
          {folderImport.failures.map(({ path, error }) => (
            <li key={path}>
              <span className="import-failure-path">{relativePath(path, folderImport.dir)}</span>:{" "}
              {error}
            </li>
          ))}
        </ul>
      )}
      {canIndex && line && (
        <div className="row index-progress">
          <span>{line}</span>
          {current != null && !paused && (
            <button onClick={() => act(indexer.stopIndexing, "Stopping failed")}>
              Stop indexing
            </button>
          )}
        </div>
      )}

      {books && books.length > 0 && (
        <div className="row books-filter">
          <div className="search-field">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6" />
              <path d="M15 15l5.5 5.5" />
            </svg>
            <input
              type="search"
              aria-label="Filter books"
              spellCheck={false}
              value={filter}
              onChange={(e) => onFilterChange(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onFilterChange("");
              }}
              placeholder="Filter by title or author…"
            />
          </div>
          <span className="books-sort-label" id="books-sort-label">
            Sort:
          </span>
          <div className="scope-toggle" role="group" aria-labelledby="books-sort-label">
            <button
              type="button"
              aria-pressed={sort === "title"}
              onClick={() => onSortChange("title")}
            >
              Title
            </button>
            <button
              type="button"
              aria-pressed={sort === "added"}
              onClick={() => onSortChange("added")}
            >
              Recently added
            </button>
          </div>
        </div>
      )}
      {books && filtering && shown!.length > 0 && (
        <p className="status">
          Showing {shown!.length} of {plural(books.length, "book")}
        </p>
      )}

      {books?.length === 0 ? (
        <p className="section-empty">No books yet. Import an EPUB or PDF to start.</p>
      ) : shown?.length === 0 ? (
        <div className="row">
          <p className="section-empty">No books match "{filter.trim()}".</p>
          <button onClick={() => onFilterChange("")}>Clear filter</button>
        </div>
      ) : (
        <ul className="book-list">
          {shown?.map((b) =>
            editing?.id === b.id ? (
              <li key={b.id} className="book-row">
                <form
                  className="book-edit-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveDetails();
                  }}
                >
                  <input
                    className="book-edit-title"
                    aria-label="Title"
                    placeholder="Untitled"
                    value={editing.title}
                    onChange={(e) => setEditing({ ...editing, title: e.currentTarget.value })}
                    onKeyDown={cancelOnEscape}
                    autoFocus
                  />
                  <input
                    className="book-edit-author"
                    aria-label="Author"
                    placeholder="Unknown author"
                    value={editing.author}
                    onChange={(e) => setEditing({ ...editing, author: e.currentTarget.value })}
                    onKeyDown={cancelOnEscape}
                  />
                  <button type="submit" className="button-primary">
                    Save
                  </button>
                  <button type="button" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </form>
              </li>
            ) : (
              <li key={b.id} className="book-row" onClick={() => onOpenBook(b.id)}>
                <span className="book-title">{b.title ?? "Untitled"}</span>
                <span className="book-meta">
                  {b.author ?? "Unknown author"} · {b.chapter_count} chapters
                  {canIndex && INDEX_STATE_NOTES[b.index_state]}
                </span>
                {canIndex && b.index_state !== "indexed" && (
                  <button
                    className="book-index button-quiet button-sm"
                    disabled={current === b.id || queued.has(b.id)}
                    onClick={(e) => {
                      e.stopPropagation(); // the row itself opens the book
                      act(() => indexer.queueIndex(b.id), "Indexing failed");
                    }}
                  >
                    {current === b.id ? "Indexing…" : queued.has(b.id) ? "Queued" : "Index"}
                  </button>
                )}
                <button
                  className="book-edit button-quiet button-sm"
                  onClick={(e) => {
                    e.stopPropagation(); // the row itself opens the book
                    setEditing({ id: b.id, title: b.title ?? "", author: b.author ?? "" });
                  }}
                >
                  Edit
                </button>
                <button
                  className="book-remove button-quiet button-danger button-sm"
                  onClick={(e) => {
                    e.stopPropagation(); // the row itself opens the book
                    removeBook(b);
                  }}
                >
                  Remove
                </button>
              </li>
            ),
          )}
        </ul>
      )}
    </main>
  );
}

export default BooksView;
