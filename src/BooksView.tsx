import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import BookCover from "./BookCover";
import EmptyState from "./EmptyState";
import { BackupIcon, BooksIcon, FolderIcon, ImportIcon, RestoreIcon, SearchIcon } from "./icons";
import { SkeletonRows } from "./Skeleton";
import StatusLine, { busy, done, failed, info, type Status } from "./StatusLine";
import { useDelayed } from "./useDelayed";
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

export function plural(n: number, word: string) {
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

/** The Books screen as rows, or as a grid of covers. */
export type BookView = "list" | "grid";

const BOOK_VIEW_KEY = "pitaka.book-view";

/** The view last chosen on this computer; storage can be unavailable, which means the list. */
export function loadBookView(): BookView {
  try {
    return localStorage.getItem(BOOK_VIEW_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export function saveBookView(view: BookView) {
  try {
    localStorage.setItem(BOOK_VIEW_KEY, view);
  } catch {
    // Not remembered, then: the choice still applies until the app closes.
  }
}

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

/**
 * Where a folder import is up to, or how it ended. "1 failed" is still done:
 * the failed paths are listed in red below it.
 */
export function folderImportLine(f: FolderImport): Status {
  if (f.scanError) return failed(`Import failed: ${f.scanError}`);
  if (f.running) {
    return busy(
      f.total === 0
        ? `Looking for books in ${f.dir}…`
        : `Importing ${Math.min(f.done + 1, f.total)} of ${f.total}…`,
    );
  }
  if (f.total === 0) return info(`No EPUB or PDF files in ${f.dir}`);
  const prefix = f.stopped ? `Stopped after ${f.done} of ${f.total}: ` : "";
  if (f.imported === 0 && f.failures.length === 0 && f.already > 0) {
    return info(`${prefix}Nothing new: ${f.already} already in library`);
  }
  const parts = [];
  if (f.imported > 0) parts.push(`Imported ${plural(f.imported, "book")}`);
  if (f.already > 0) parts.push(`${f.already} already in library`);
  if (f.failures.length > 0) parts.push(`${f.failures.length} failed`);
  return done(prefix + (parts.length > 0 ? parts.join(", ") : "nothing imported"));
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
  view: BookView;
  onViewChange: (view: BookView) => void;
  /** Bumped by App when the library changes elsewhere, e.g. covers were found. */
  libraryVersion: number;
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
  view,
  onViewChange,
  libraryVersion,
  folderImport,
  startFolderImport,
  stopFolderImport,
  clearFolderImport,
}: Props) {
  const [importStatus, setImportStatus] = useState<Status | null>(null);
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
      setImportStatus(failed(`Loading library failed: ${err}`));
    }
  }

  // Remounted on every visit, including on return from the reader; and
  // refreshed as a folder import adds books, so the list fills in.
  useEffect(() => {
    refreshBooks();
  }, [folderImport?.imported, libraryVersion]);

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

  function indexingLine(): Status | null {
    if (!indexing) return paused ? info(`Stopped indexing. ${PAUSED_NOTE}`) : null;
    const book = books?.find((b) => b.id === indexing.book_id);
    const title = book ? (book.title ?? "Untitled") : `book #${indexing.book_id}`;
    if (indexing.kind === "failed") {
      return failed(`Indexing ${title} for chapter search failed: ${indexing.error}`);
    }
    const { done: n, total } = indexing;
    if (indexing.kind === "stopped") {
      return info(`Stopped indexing ${title} at ${n}/${total} chapters. ${PAUSED_NOTE}`);
    }
    if (n === total) return done(`Indexed ${title} for chapter search`);
    if (paused) return info(`Stopping indexing ${title} after the chapter in progress…`);
    const more = indexing.queued > 0 ? ` · ${plural(indexing.queued, "more book")} queued` : "";
    return busy(`Indexing ${title} for chapter search… ${n}/${total} chapters${more}`);
  }

  async function act(action: () => Promise<unknown>, failure: string) {
    try {
      await action();
    } catch (err) {
      setImportStatus(failed(`${failure}: ${err}`));
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
  const emptyLibrary = books?.length === 0;
  const showSkeleton = useDelayed(books == null);

  async function importBook() {
    const path = await open({
      multiple: false,
      filters: [{ name: "EPUB or PDF", extensions: ["epub", "pdf"] }],
    });
    if (!path || Array.isArray(path)) return;

    clearFolderImport();
    setImportStatus(busy(`Importing ${path}…`));
    try {
      const { book_id, already_imported } = await invoke<ImportOutcome>("import_book", { path });
      setImportStatus(
        done(
          already_imported ? `Already in library as book #${book_id}` : `Imported book #${book_id}`,
        ),
      );
      if (!already_imported) onLibraryChanged();
      await refreshBooks();
    } catch (err) {
      setImportStatus(failed(`Import failed: ${err}`));
    }
  }

  async function importFolder() {
    const dir = await open({ directory: true, multiple: false });
    if (!dir || Array.isArray(dir)) return;
    // The row shows whichever import happened last.
    setImportStatus(null);
    startFolderImport(dir);
  }

  async function backUp() {
    const path = await save({
      defaultPath: `pitaka-backup-${today()}.pitaka`,
      filters: BACKUP_FILTERS,
    });
    if (!path) return;

    clearFolderImport();
    setImportStatus(busy("Backing up…"));
    try {
      const { counts } = await invoke<BackupManifest>("backup_library", { path });
      setImportStatus(done(`Backed up ${countsLine(counts)} to ${path}`));
    } catch (err) {
      setImportStatus(failed(`Backup failed: ${err}`));
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
      setImportStatus(failed(`Restore failed: ${err}`));
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

    setImportStatus(busy("Restoring…"));
    try {
      const counts = await invoke<LibraryCounts>("restore_library", { path });
      setImportStatus(done(`Restored ${countsLine(counts)}`));
      onLibraryReplaced();
      await refreshBooks();
    } catch (err) {
      setImportStatus(failed(`Restore failed: ${err}`));
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
      setImportStatus(done(`Removed "${title}"`));
      onLibraryChanged();
      await refreshBooks();
    } catch (err) {
      setImportStatus(failed(`Remove failed: ${err}`));
    }
  }

  async function saveDetails() {
    if (!editing) return;
    const { id, title, author } = editing;
    try {
      await invoke("update_book_details", { bookId: id, title, author });
      const newTitle = title.trim().replace(/\s+/g, " ") || null;
      setEditing(null);
      setImportStatus(done(`Updated "${newTitle ?? "Untitled"}"`));
      onLibraryChanged();
      await refreshBooks();
    } catch (err) {
      setImportStatus(failed(`Saving failed: ${err}`));
    }
  }

  function cancelOnEscape(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") setEditing(null);
  }

  /** The Title and Author form, in a list row or (stacked) in a grid card. */
  function editForm(edit: NonNullable<typeof editing>, stacked: boolean) {
    return (
      <form
        className={stacked ? "book-edit-form book-edit-form-stacked" : "book-edit-form"}
        onSubmit={(e) => {
          e.preventDefault();
          saveDetails();
        }}
      >
        <input
          className="book-edit-title"
          aria-label="Title"
          placeholder="Untitled"
          value={edit.title}
          onChange={(e) => setEditing({ ...edit, title: e.currentTarget.value })}
          onKeyDown={cancelOnEscape}
          autoFocus
        />
        <input
          className="book-edit-author"
          aria-label="Author"
          placeholder="Unknown author"
          value={edit.author}
          onChange={(e) => setEditing({ ...edit, author: e.currentTarget.value })}
          onKeyDown={cancelOnEscape}
        />
        <button type="submit" className="button-primary">
          Save
        </button>
        <button type="button" onClick={() => setEditing(null)}>
          Cancel
        </button>
      </form>
    );
  }

  /** A book's Index, Edit and Remove buttons, the same in a row and a card. */
  function bookActions(b: BookSummary) {
    return (
      <>
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
      </>
    );
  }

  const importBookButton = (
    <button className="button-primary button-icon" onClick={importBook} disabled={importing}>
      <ImportIcon />
      Import book
    </button>
  );
  const importFolderButton = (
    <button className="button-icon" onClick={importFolder} disabled={importing}>
      <FolderIcon />
      Import folder
    </button>
  );
  const restoreButton = (
    <button
      className="button-icon"
      onClick={restore}
      disabled={importing || anyQueued}
      title={anyQueued ? "Stop indexing to restore a backup" : undefined}
    >
      <RestoreIcon />
      Restore
    </button>
  );

  return (
    <main className="container">
      <h1>Books</h1>

      <div className="row">
        {/* An empty library offers these in its empty state instead, so each appears once. */}
        {!emptyLibrary && (
          <>
            {importBookButton}
            {importFolderButton}
            <button className="button-icon" onClick={backUp} disabled={importing}>
              <BackupIcon />
              Back up
            </button>
            {restoreButton}
          </>
        )}
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
        <StatusLine status={importStatus ?? (folderImport && folderImportLine(folderImport))} />
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
          <StatusLine status={line} />
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
            <SearchIcon />
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
          <span className="books-sort-label" id="books-view-label">
            View:
          </span>
          <div className="scope-toggle" role="group" aria-labelledby="books-view-label">
            <button
              type="button"
              aria-pressed={view === "list"}
              onClick={() => onViewChange("list")}
            >
              List
            </button>
            <button
              type="button"
              aria-pressed={view === "grid"}
              onClick={() => onViewChange("grid")}
            >
              Grid
            </button>
          </div>
        </div>
      )}
      {books && filtering && shown!.length > 0 && (
        <p className="result-count">
          Showing {shown!.length} of {plural(books.length, "book")}
        </p>
      )}

      {books == null ? (
        showSkeleton && <SkeletonRows count={3} label="Loading books" className="book-list" />
      ) : emptyLibrary ? (
        <EmptyState
          icon={<BooksIcon size={28} />}
          title="Your library is empty"
          actions={
            <>
              {importBookButton}
              {importFolderButton}
              <span className="empty-state-or">Moving from another computer?</span>
              {restoreButton}
            </>
          }
        >
          Import an EPUB or PDF, or a whole folder of them. Pitaka reads each book once and keeps
          its text on this computer.
        </EmptyState>
      ) : shown?.length === 0 ? (
        <EmptyState
          compact
          actions={<button onClick={() => onFilterChange("")}>Clear filter</button>}
        >
          No books match "{filter.trim()}".
        </EmptyState>
      ) : view === "grid" ? (
        <ul className="book-grid">
          {shown?.map((b) => {
            const isEditing = editing?.id === b.id;
            return (
              <li
                key={b.id}
                className="book-card"
                onClick={isEditing ? undefined : () => onOpenBook(b.id)}
              >
                <BookCover book={b} size="card" />
                {isEditing ? (
                  editForm(editing, true)
                ) : (
                  <>
                    <span className="book-card-title">{b.title ?? "Untitled"}</span>
                    <span className="book-card-meta">{b.author ?? "Unknown author"}</span>
                    <div className="book-card-actions">{bookActions(b)}</div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="book-list">
          {shown?.map((b) =>
            editing?.id === b.id ? (
              <li key={b.id} className="book-row">
                <BookCover book={b} size="thumb" />
                {editForm(editing, false)}
              </li>
            ) : (
              <li key={b.id} className="book-row" onClick={() => onOpenBook(b.id)}>
                <BookCover book={b} size="thumb" />
                <span className="book-title">{b.title ?? "Untitled"}</span>
                <span className="book-meta">
                  {b.author ?? "Unknown author"} · {b.chapter_count} chapters
                  {canIndex && INDEX_STATE_NOTES[b.index_state]}
                </span>
                {bookActions(b)}
              </li>
            ),
          )}
        </ul>
      )}
    </main>
  );
}

export default BooksView;
