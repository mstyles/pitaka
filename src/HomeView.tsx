import { type ComponentType, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import EmptyState from "./EmptyState";
import { BookmarkIcon, BooksIcon, SearchIcon } from "./icons";
import type { Screen } from "./NavBar";
import { SkeletonRows } from "./Skeleton";
import StatusLine, { failed } from "./StatusLine";
import { useDelayed } from "./useDelayed";
import type { BookmarkFolder, BookSummary } from "./types";

type Props = {
  onNavigate: (screen: Screen) => void;
  onOpenBook: (bookId: number) => void;
};

/** How many of the newest books "Your library" lists before linking to the rest. */
const RECENT_COUNT = 3;

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
 * then the most recently imported books.
 */
function HomeView({ onNavigate, onOpenBook }: Props) {
  // Null until loaded, so the cards don't flash an empty-library state.
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [folders, setFolders] = useState<BookmarkFolder[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    invoke<BookSummary[]>("list_books")
      .then(setBooks)
      .catch((err) => setErrors((e) => [...e, `Loading library failed: ${err}`]));
    invoke<BookmarkFolder[]>("list_bookmark_folders")
      .then(setFolders)
      .catch((err) => setErrors((e) => [...e, `Loading bookmark folders failed: ${err}`]));
  }, []);

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
      {books && books.length > 0 && (
        <section className="home-recent" aria-labelledby="home-recent-label">
          <h2 id="home-recent-label" className="section-label">
            Your library
          </h2>
          <ul className="home-recent-list">
            {/* list_books is newest first. */}
            {books.slice(0, RECENT_COUNT).map((b) => (
              <li key={b.id}>
                <button className="home-recent-row" onClick={() => onOpenBook(b.id)}>
                  <span className="book-title">{b.title ?? "Untitled"}</span>
                  <span className="book-meta">
                    {b.author ?? "Unknown author"} · {plural(b.chapter_count, "chapter")}
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
      {errors.map((e) => (
        <StatusLine key={e} status={failed(e)} />
      ))}
    </main>
  );
}

export default HomeView;
