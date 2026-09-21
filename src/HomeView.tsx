import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Screen } from "./NavBar";
import type { BookmarkFolder, BookSummary } from "./types";

type Props = {
  onNavigate: (screen: Screen) => void;
};

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The launch screen: one card per section, each with a line of live counts. */
function HomeView({ onNavigate }: Props) {
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

  const cards: { screen: Screen; title: string; detail: string; disabled?: boolean }[] = [
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
            <span className="home-card-title">{c.title}</span>
            <span className="home-card-detail">{c.detail}</span>
          </button>
        ))}
      </div>
      {errors.map((e) => (
        <p key={e} className="status">
          {e}
        </p>
      ))}
    </main>
  );
}

export default HomeView;
