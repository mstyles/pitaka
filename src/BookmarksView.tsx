import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import BookAnnotationsView from "./BookAnnotationsView";
import EmptyState from "./EmptyState";
import FolderView from "./FolderView";
import { SkeletonRows } from "./Skeleton";
import StatusLine, { failed, type Status } from "./StatusLine";
import type { AnnotatedBook, BookAnnotation, BookmarkFolder, FolderBookmark } from "./types";
import { useDelayed } from "./useDelayed";

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
  const [status, setStatus] = useState<Status | null>(null);

  async function refreshFolders() {
    try {
      setFolders(await invoke<BookmarkFolder[]>("list_bookmark_folders"));
    } catch (err) {
      setStatus(failed(`Loading bookmark folders failed: ${err}`));
    }
  }

  // Remounted on every visit, including on return from the reader.
  useEffect(() => {
    refreshFolders();
    invoke<AnnotatedBook[]>("list_annotated_books")
      .then(setAnnotated)
      .catch((err) => setStatus(failed(`Loading highlights and notes failed: ${err}`)));
  }, []);

  async function createFolder() {
    try {
      await invoke<BookmarkFolder>("create_bookmark_folder", { name: newFolderName });
      setNewFolderName("");
      setStatus(null);
      await refreshFolders();
    } catch (err) {
      setStatus(failed(`Creating folder failed: ${err}`));
    }
  }

  const loading = (folders == null || annotated == null) && !status;
  const showSkeleton = useDelayed(loading);
  // Still loading: nothing at first, so an open folder doesn't flash the
  // lists on return from the reader, then skeleton lists. A load error falls
  // through so it can be shown.
  if (loading) {
    if (!showSkeleton || openFolderId != null || openAnnotationsBookId != null) return null;
    return (
      <main className="container">
        <h1>Bookmarks &amp; notes</h1>
        <h2 className="section-label">Folders</h2>
        <SkeletonRows count={2} label="Loading folders" className="folder-list" />
        <section className="annotated-books">
          <h2 className="section-label">Highlights &amp; notes</h2>
          <SkeletonRows count={2} label="Loading highlights and notes" className="folder-list" />
        </section>
      </main>
    );
  }
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
          <EmptyState compact>
            No bookmark folders yet. Create one here, or bookmark a passage while reading.
          </EmptyState>
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
          <EmptyState compact>Select text while reading to highlight it or add a note.</EmptyState>
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
      <StatusLine status={status} />
    </main>
  );
}

export default BookmarksView;
