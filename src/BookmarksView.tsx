import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import FolderView from "./FolderView";
import type { BookmarkFolder, FolderBookmark } from "./types";

type Props = {
  /** Held by App so the open folder survives a trip into the reader. */
  openFolderId: number | null;
  onOpenFolder: (folderId: number | null) => void;
  onOpenBookmark: (bookmark: FolderBookmark, folder: BookmarkFolder) => void;
};

function BookmarksView({ openFolderId, onOpenFolder, onOpenBookmark }: Props) {
  // Null until loaded, so returning from the reader to an open folder doesn't
  // flash the folder list first.
  const [folders, setFolders] = useState<BookmarkFolder[] | null>(null);
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
  if (folders == null && !status) return null;
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
      <h1>Bookmarks</h1>
      <section className="folders">
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
        {status && <p className="status">{status}</p>}
      </section>
    </main>
  );
}

export default BookmarksView;
