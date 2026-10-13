import { type ComponentType, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import BookCover from "./BookCover";
import EmptyState from "./EmptyState";
import { ExternalLink, FEEDBACK_LINKS } from "./feedback";
import { BookmarkIcon, BooksIcon, SearchIcon } from "./icons";
import type { Screen } from "./NavBar";
import { SkeletonRows } from "./Skeleton";
import StatusLine, { failed } from "./StatusLine";
import { useDelayed } from "./useDelayed";
import type { BookmarkFolder, BookSummary, ReadingPosition } from "./types";

type Props = {
  /** Bumped by App when the library changes, e.g. covers were found. */
  libraryVersion: number;
  onNavigate: (screen: Screen) => void;
  onOpenBook: (bookId: number) => void;
};

/** How many of the newest books "Your library" lists before linking to the rest. */
const RECENT_COUNT = 3;
/** How many unfinished books "Continue reading" lists. */
const CONTINUE_COUNT = 3;

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const ICONS: Record<Exclude<Screen, "home">, ComponentType<{ size?: number }>> = {
  books: BooksIcon,
  bookmarks: BookmarkIcon,
  search: SearchIcon,
};

function CardIcon({ screen }: { screen: Exclude<Screen, "home"> }) {
  const Icon = ICONS[screen];
  return (
    <span className="home-card-icon" aria-hidden="true">
      <Icon size={22} />
    </span>
  );
}

/**
 * The launch screen: one card per section, each with a line of live counts,
 * then the books being read and the most recently imported ones.
 */
function HomeView({ libraryVersion, onNavigate, onOpenBook }: Props) {
  // Null until loaded, so the cards don't flash an empty-library state.
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [folders, setFolders] = useState<BookmarkFolder[] | null>(null);
  const [positions, setPositions] = useState<ReadingPosition[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    invoke<BookmarkFolder[]>("list_bookmark_folders")
      .then(setFolders)
      .catch((err) => setErrors((e) => [...e, `Loading bookmark folders failed: ${err}`]));
    invoke<ReadingPosition[]>("list_reading_positions", { limit: CONTINUE_COUNT })
      .then(setPositions)
      .catch((err) => setErrors((e) => [...e, `Loading reading positions failed: ${err}`]));
  }, []);

  useEffect(() => {
    invoke<BookSummary[]>("list_books")
      .then(setBooks)
      .catch((err) => setErrors((e) => [...e, `Loading library failed: ${err}`]));
  }, [libraryVersion]);

  const emptyLibrary = books?.length === 0;
  const showSkeleton = useDelayed(books == null && errors.length === 0);

  let booksDetail = "";
  let searchDetail = "";
  if (books) {
    booksDetail = emptyLibrary ? "Import your first book" : plural(books.length, "book");
    searchDetail = emptyLibrary
      ? "Import a book to search"
      : `Search across ${plural(books.length, "book")}`;
  }

  let foldersDetail = "";
  if (folders) {
    const passages = folders.reduce((n, f) => n + f.bookmark_count, 0);
    foldersDetail =
      folders.length === 0
        ? "No folders yet"
        : `${plural(folders.length, "folder")} · ${plural(passages, "passage")}`;
  }
  if (books) {
    const highlights = books.reduce((n, b) => n + b.highlight_count, 0);
    const notes = books.reduce((n, b) => n + b.note_count, 0);
    if (highlights + notes > 0) {
      foldersDetail += ` · ${plural(highlights, "highlight")}, ${plural(notes, "note")}`;
    }
  }

  // Finished books aren't listed, so they show under "Your library" again.
  const reading = (positions ?? []).flatMap((p) => {
    const book = books?.find((b) => b.id === p.book_id);
    return book ? [{ position: p, book }] : [];
  });
  const readingIds = new Set(reading.map((r) => r.book.id));
  const recent = (books ?? []).filter((b) => !readingIds.has(b.id)).slice(0, RECENT_COUNT);

  const cards: {
    screen: Exclude<Screen, "home">;
    title: string;
    detail: string;
    disabled?: boolean;
  }[] = [
    { screen: "books", title: "Books", detail: booksDetail },
    { screen: "bookmarks", title: "Bookmarks & notes", detail: foldersDetail },
    { screen: "search", title: "Search", detail: searchDetail, disabled: emptyLibrary },
  ];

  return (
    <main className="container home">
      <h1>Pitaka</h1>
      <div className="home-cards">
        {cards.map((c) => (
          <button
            key={c.screen}
            className="home-card"
            disabled={c.disabled}
            onClick={() => onNavigate(c.screen)}
          >
            <CardIcon screen={c.screen} />
            <span className="home-card-title">{c.title}</span>
            <span className="home-card-detail">{c.detail}</span>
          </button>
        ))}
      </div>
      {books == null && showSkeleton && (
        <section className="home-recent" aria-labelledby="home-recent-label">
          <h2 id="home-recent-label" className="section-label">
            Your library
          </h2>
          <SkeletonRows count={3} label="Loading library" className="home-recent-list" />
        </section>
      )}
      {emptyLibrary && (
        <div className="home-recent">
          <EmptyState
            icon={<BooksIcon size={28} />}
            title="Welcome to Pitaka"
            actions={
              <button className="button-primary" onClick={() => onNavigate("books")}>
                Go to Books
              </button>
            }
          >
            Import your EPUBs and PDFs to search them, bookmark passages and keep notes. Everything
            stays on this computer.
          </EmptyState>
        </div>
      )}
      {reading.length > 0 && (
        <section className="home-recent" aria-labelledby="home-continue-label">
          <h2 id="home-continue-label" className="section-label">
            Continue reading
          </h2>
          <ul className="home-recent-list">
            {reading.map(({ position: p, book }) => {
              const title = book.title ?? "Untitled";
              return (
                <li key={p.book_id}>
                  <button className="home-recent-row" onClick={() => onOpenBook(p.book_id)}>
                    <span className="book-title">{title}</span>
                    <span className="book-meta">
                      {p.chapter_title ?? `Chapter ${p.chapter_number}`} · {p.percent}%
                    </span>
                    <span
                      className="home-progress"
                      role="progressbar"
                      aria-label={`${title} progress`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={p.percent}
                    >
                      <span className="home-progress-fill" style={{ width: `${p.percent}%` }} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {books && books.length > 0 && (
        <section className="home-recent" aria-labelledby="home-recent-label">
          <h2 id="home-recent-label" className="section-label">
            Your library
          </h2>
          <ul className="home-recent-list">
            {/* list_books is newest first. */}
            {recent.map((b) => (
              <li key={b.id}>
                <button className="home-recent-row" onClick={() => onOpenBook(b.id)}>
                  <BookCover book={b} size="thumb" />
                  <span className="home-recent-text">
                    <span className="book-title">{b.title ?? "Untitled"}</span>
                    <span className="book-meta">
                      {b.author ?? "Unknown author"} · {plural(b.chapter_count, "chapter")}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {books.length > RECENT_COUNT && (
              <li>
                <button className="home-recent-more" onClick={() => onNavigate("books")}>
                  All {books.length} books →
                </button>
              </li>
            )}
          </ul>
        </section>
      )}
      <p className="home-hint">
        Press <kbd>?</kbd> for keyboard shortcuts
      </p>
      <p className="home-feedback">
        Found a bug, or have an idea?{" "}
        <ExternalLink href={FEEDBACK_LINKS.bug}>Report a bug</ExternalLink> ·{" "}
        <ExternalLink href={FEEDBACK_LINKS.idea}>Suggest an idea</ExternalLink> · or{" "}
        <ExternalLink href={FEEDBACK_LINKS.email}>email me</ExternalLink>.
      </p>
      {errors.map((e) => (
        <StatusLine key={e} status={failed(e)} />
      ))}
    </main>
  );
}

export default HomeView;
