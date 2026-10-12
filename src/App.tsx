import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import BookmarksView from "./BookmarksView";
import BooksView, {
  type BookSort,
  type BookView,
  folderImportLine,
  loadBookView,
  plural,
  saveBookView,
  useFolderImport,
  useIndexing,
} from "./BooksView";
import HomeView from "./HomeView";
import NavBar, { type Screen } from "./NavBar";
import ReaderView from "./ReaderView";
import { applyTheme, loadSettings, saveSettings } from "./readerSettings";
import SearchView from "./SearchView";
import { done, failed, type Status } from "./StatusLine";
import Toaster, { type Toast } from "./Toaster";
import type {
  BookSummary,
  CoverBackfill,
  SemanticIndexFailed,
  SemanticIndexProgress,
} from "./types";
import "./App.css";

/** At most this many toasts show; another drops the oldest. */
const MAX_TOASTS = 3;

type ReaderTarget = {
  bookId: number;
  chapterId?: number;
  focusBlockId?: number;
  /** Names the screen the book was opened from, which is where back returns. */
  backLabel: string;
  openNoteId?: number;
};

function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [reader, setReader] = useState<ReaderTarget | null>(null);
  const [openFolderId, setOpenFolderId] = useState<number | null>(null);
  const [openAnnotationsBookId, setOpenAnnotationsBookId] = useState<number | null>(null);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [bookFilter, setBookFilter] = useState("");
  const [bookSort, setBookSort] = useState<BookSort>("title");
  // Remembered on this computer, as the reader's settings are; the sort isn't.
  const [bookView, setBookView] = useState<BookView>(loadBookView);
  // Passage search's book scope; the reader sets it too.
  const [searchBookId, setSearchBookId] = useState<number | null>(null);
  const { dismissFinished, ...indexer } = useIndexing();
  const folderImport = useFolderImport(() => setLibraryVersion((v) => v + 1));
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Here rather than in the reader, so the theme applies on every screen.
  const [readerSettings, setReaderSettings] = useState(loadSettings);
  const nextToastId = useRef(1);
  const booksShowing = screen === "books" && reader == null;
  // Read from the effects below, which run on events rather than on screen changes.
  const booksShowingRef = useRef(booksShowing);
  booksShowingRef.current = booksShowing;

  /** Reports background work that ended while the Books screen wasn't showing. */
  function notify(status: Status) {
    if (booksShowingRef.current) return;
    const id = nextToastId.current++;
    setToasts((ts) => [...ts, { ...status, id }].slice(-MAX_TOASTS));
  }

  useEffect(() => {
    saveSettings(readerSettings);
    applyTheme(readerSettings.theme);
  }, [readerSettings]);

  // The Books screen's own status lines now have the same news.
  useEffect(() => {
    if (booksShowing) setToasts([]);
  }, [booksShowing]);

  const fi = folderImport.folderImport;
  const wasImporting = useRef(false);
  useEffect(() => {
    const running = fi?.running ?? false;
    if (wasImporting.current && !running && fi) notify(folderImportLine(fi));
    wasImporting.current = running;
  }, [fi?.running]);

  // Covers for books imported before Pitaka read them, found in the
  // background. A failure only means those books keep generated covers.
  function backfillCovers() {
    invoke("backfill_covers").catch(() => {});
  }

  useEffect(() => {
    const unlisten = listen<CoverBackfill>("covers_found", ({ payload }) => {
      if (payload.found > 0) setLibraryVersion((v) => v + 1);
    });
    backfillCovers();
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Listens to the events themselves rather than to `indexer.indexing`,
  // which keeps only the latest: a failure followed at once by the next
  // book's progress would otherwise never be seen.
  useEffect(() => {
    // Books that finished indexing since the queue last emptied.
    let finished = 0;
    const unlisteners = [
      listen<SemanticIndexFailed>("semantic_index_failed", ({ payload }) => {
        invoke<BookSummary[]>("list_books")
          .then((books) => books.find((b) => b.id === payload.book_id)?.title ?? "Untitled")
          .catch(() => `book #${payload.book_id}`)
          .then((title) => notify(failed(`Indexing "${title}" failed: ${payload.error}`)));
      }),
      listen<SemanticIndexProgress>("semantic_index_progress", ({ payload }) => {
        if (payload.done < payload.total) return;
        finished++;
        if (payload.queued === 0) {
          notify(done(`Chapter search is ready for ${plural(finished, "book")}`));
          finished = 0;
        }
      }),
    ];
    return () => {
      for (const unlisten of unlisteners) unlisten.then((f) => f());
    };
  }, []);

  function navigate(to: Screen) {
    if (screen === "books" && to !== "books") dismissFinished();
    // The Bookmarks & notes link always shows the lists.
    setOpenFolderId(null);
    setOpenAnnotationsBookId(null);
    setScreen(to);
  }

  return (
    <>
      {!reader && screen !== "home" && <NavBar current={screen} onNavigate={navigate} />}
      {!reader && screen === "home" && (
        <HomeView
          libraryVersion={libraryVersion}
          onNavigate={navigate}
          onOpenBook={(bookId) => setReader({ bookId, backLabel: "← Home" })}
        />
      )}
      {!reader && screen === "books" && (
        <BooksView
          onOpenBook={(bookId) => setReader({ bookId, backLabel: "← Books" })}
          onLibraryChanged={() => setLibraryVersion((v) => v + 1)}
          onLibraryReplaced={() => {
            // Ids from before a restore mean nothing afterwards.
            setOpenFolderId(null);
            setOpenAnnotationsBookId(null);
            setSearchBookId(null);
            dismissFinished();
            setLibraryVersion((v) => v + 1);
            // The backup may be from before covers, with none for its books.
            backfillCovers();
          }}
          indexer={indexer}
          filter={bookFilter}
          onFilterChange={setBookFilter}
          sort={bookSort}
          onSortChange={setBookSort}
          view={bookView}
          onViewChange={(view) => {
            setBookView(view);
            saveBookView(view);
          }}
          libraryVersion={libraryVersion}
          {...folderImport}
        />
      )}
      {!reader && screen === "bookmarks" && (
        <BookmarksView
          openFolderId={openFolderId}
          onOpenFolder={setOpenFolderId}
          onOpenBookmark={(b, folder) =>
            setReader({
              bookId: b.book_id,
              chapterId: b.chapter_id,
              focusBlockId: b.content_block_id,
              backLabel: `← ${folder.name}`,
            })
          }
          openAnnotationsBookId={openAnnotationsBookId}
          onOpenAnnotations={setOpenAnnotationsBookId}
          onOpenAnnotation={(e, book) =>
            setReader({
              bookId: book.book_id,
              chapterId: e.chapter_id,
              focusBlockId: e.content_block_id,
              backLabel: `← ${book.title ?? "Untitled"}`,
              openNoteId: e.note_id ?? undefined,
            })
          }
        />
      )}
      {/* Kept mounted so the query and results survive leaving the screen. */}
      <div hidden={screen !== "search" || reader != null}>
        <SearchView
          active={screen === "search" && reader == null}
          libraryVersion={libraryVersion}
          bookId={searchBookId}
          onBookIdChange={setSearchBookId}
          onOpenResult={(r) =>
            setReader({
              bookId: r.book_id,
              chapterId: r.chapter_id,
              focusBlockId: r.content_block_id,
              backLabel: "← Search results",
            })
          }
        />
      </div>
      {reader && (
        <ReaderView
          bookId={reader.bookId}
          initialChapterId={reader.chapterId}
          focusBlockId={reader.focusBlockId}
          backLabel={reader.backLabel}
          openNoteId={reader.openNoteId}
          settings={readerSettings}
          onSettingsChange={setReaderSettings}
          onBack={() => setReader(null)}
          onSearchBook={(bookId) => {
            setSearchBookId(bookId);
            setReader(null);
            navigate("search");
          }}
        />
      )}
      <Toaster
        toasts={toasts}
        onDismiss={(id) => setToasts((ts) => ts.filter((t) => t.id !== id))}
        onShow={() => {
          setReader(null);
          navigate("books");
        }}
      />
    </>
  );
}

export default App;
