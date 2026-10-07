import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import BookAnnotationsView from "./BookAnnotationsView";
import FolderView from "./FolderView";
import type { AnnotatedBook, BookAnnotation, BookmarkFolder, FolderBookmark } from "./types";

type Props = {
  /** Held by App so the open folder survives a trip into the reader. */
  openFolderId: number | null;
  onOpenFolder: (folderId: number | null) => void;
  onOpenBookmark: (bookmark: FolderBookmark, folder: BookmarkFolder) => void;
  /** Likewise for the book whose highlights and notes are open. */
  openAnnotationsBookId: number | null;
  onOpenAnnotations: (bookId: number | null) => void;
  onOpenAnnotation: (entry: BookAnnotation, book: AnnotatedBook) => void;
};

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function BookmarksView({
  openFolderId,
  onOpenFolder,
  onOpenBookmark,
  openAnnotationsBookId,
  onOpenAnnotations,
  onOpenAnnotation,
}: Props) {
  // Null until loaded, so returning from the reader to an open folder doesn't
  // flash the folder list first.
  const [folders, setFolders] = useState<BookmarkFolder[] | null>(null);
  const [annotated, setAnnotated] = useState<AnnotatedBook[] | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [status, setStatus] = useState("");

  async function refreshFolders() {
    try {
      setFolders(await invoke<BookmarkFolder[]>("list_bookmark_folders"));
    } catch (err) {
      setStatus(`Loading bookmark folders failed: ${err}`);
    }
  }

  // Remounted on every visit, including on return from the reader.
  useEffect(() => {
    refreshFolders();
    invoke<AnnotatedBook[]>("list_annotated_books")
      .then(setAnnotated)
      .catch((err) => setStatus(`Loading highlights and notes failed: ${err}`));
  }, []);

  async function createFolder() {
    try {
      await invoke<BookmarkFolder>("create_bookmark_folder", { name: newFolderName });
      setNewFolderName("");
      setStatus("");
      await refreshFolders();
    } catch (err) {
      setStatus(`Creating folder failed: ${err}`);
    }
  }

  // Still loading; a load error falls through so it can be shown.
  if ((folders == null || annotated == null) && !status) return null;
  const openBook = annotated?.find((b) => b.book_id === openAnnotationsBookId);
  if (openBook) {
    return (
      <BookAnnotationsView
        book={openBook}
        onBack={() => onOpenAnnotations(null)}
        onOpenEntry={(e) => onOpenAnnotation(e, openBook)}
      />
    );
  }
  const openFolder = folders?.find((f) => f.id === openFolderId);
  if (openFolder) {
    return (
      <FolderView
        folder={openFolder}
        onBack={() => onOpenFolder(null)}
        onOpenBookmark={(b) => onOpenBookmark(b, openFolder)}
        onChanged={refreshFolders}
      />
    );
  }

  return (
    <main className="container">
      <h1>Bookmarks &amp; notes</h1>
      <section className="folders" aria-labelledby="folders-label">
        <h2 id="folders-label" className="section-label">
          Folders
        </h2>
        {folders?.length === 0 ? (
          <p className="section-empty">
            No bookmark folders yet. Create one here, or bookmark a passage while reading.
          </p>
        ) : (
          <ul className="folder-list">
            {folders?.map((f) => (
              <li key={f.id} className="folder-row" onClick={() => onOpenFolder(f.id)}>
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
          <button type="submit" className="button-primary">
            Create
          </button>
        </form>
      </section>
      <section className="annotated-books" aria-labelledby="annotated-label">
        <h2 id="annotated-label" className="section-label">
          Highlights &amp; notes
        </h2>
        {annotated?.length === 0 ? (
          <p className="section-empty">Select text while reading to highlight it or add a note.</p>
        ) : (
          <ul className="folder-list">
            {annotated?.map((b) => (
              <li
                key={b.book_id}
                className="folder-row"
                onClick={() => onOpenAnnotations(b.book_id)}
              >
                <span className="folder-row-name">{b.title ?? "Untitled"}</span>
                <span className="book-meta">
                  {plural(b.highlight_count, "highlight")}, {plural(b.note_count, "note")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {status && <p className="status">{status}</p>}
    </main>
  );
}

export default BookmarksView;
