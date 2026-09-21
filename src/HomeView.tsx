import { type ReactNode, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Screen } from "./NavBar";
import type { BookmarkFolder, BookSummary } from "./types";

type Props = {
  onNavigate: (screen: Screen) => void;
  onOpenBook: (bookId: number) => void;
};

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const ICONS: Record<Exclude<Screen, "home">, ReactNode> = {
  books: <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z" />,
  bookmarks: <path d="M6 3h12v18l-6-5-6 5z" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5.5 5.5" />
    </>
  ),
};

function CardIcon({ screen }: { screen: Exclude<Screen, "home"> }) {
  return (
    <span className="home-card-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22">
        {ICONS[screen]}
      </svg>
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

  let booksDetail = "";
  let searchDetail = "";
  if (books) {
    booksDetail = emptyLibrary ? "Import your first EPUB" : plural(books.length, "book");
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

  const cards: { screen: Exclude<Screen, "home">; title: string; detail: string; disabled?: boolean }[] = [
    { screen: "books", title: "Books", detail: booksDetail },
    { screen: "bookmarks", title: "Bookmarks", detail: foldersDetail },
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
      {books && books.length > 0 && (
        <section className="home-recent" aria-labelledby="home-recent-label">
          <h2 id="home-recent-label" className="section-label">
            Your library
          </h2>
          <ul className="home-recent-list">
            {/* list_books is newest first. */}
            {books.slice(0, 3).map((b) => (
              <li key={b.id}>
                <button className="home-recent-row" onClick={() => onOpenBook(b.id)}>
                  <span className="book-title">{b.title ?? "Untitled"}</span>
                  <span className="book-meta">
                    {b.author ?? "Unknown author"} · {plural(b.chapter_count, "chapter")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {errors.map((e) => (
        <p key={e} className="status">
          {e}
        </p>
      ))}
    </main>
  );
}

export default HomeView;
