import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import type { BookmarkFolder, FolderBookmark } from "./types";

type Props = {
  folder: BookmarkFolder;
  onBack: () => void;
  onOpenBookmark: (bookmark: FolderBookmark) => void;
  /** Called after a rename, removal or delete, so folder counts can refresh. */
  onChanged: () => void;
};

function passageCount(n: number) {
  return n === 1 ? "1 passage" : `${n} passages`;
}

/** One bookmark folder's passages, each a click away from its place in the book. */
function FolderView({ folder, onBack, onOpenBookmark, onChanged }: Props) {
  const [passages, setPassages] = useState<FolderBookmark[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [status, setStatus] = useState("");

  async function refreshPassages() {
    try {
      setPassages(await invoke<FolderBookmark[]>("list_folder_bookmarks", { folderId: folder.id }));
    } catch (err) {
      setStatus(`Loading folder failed: ${err}`);
    }
  }

  // Remounted on return from the reader, so this also picks up changes made there.
  useEffect(() => {
    refreshPassages();
  }, [folder.id]);

  async function rename() {
    try {
      await invoke("rename_bookmark_folder", { folderId: folder.id, name: newName });
      setRenaming(false);
      setStatus("");
      onChanged();
    } catch (err) {
      setStatus(`Rename failed: ${err}`);
    }
  }

  async function deleteFolder() {
    const confirmed = await ask(
      `Delete the folder "${folder.name}" and its ${passages.length} bookmark${passages.length === 1 ? "" : "s"}? The passages stay in their books.`,
      { title: "Delete folder", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" },
    );
    if (!confirmed) return;
    try {
      await invoke("delete_bookmark_folder", { folderId: folder.id });
      onChanged();
      onBack();
    } catch (err) {
      setStatus(`Delete failed: ${err}`);
    }
  }

  async function removePassage(p: FolderBookmark) {
    try {
      await invoke("remove_bookmark", { folderId: folder.id, contentBlockId: p.content_block_id });
      await refreshPassages();
      onChanged();
    } catch (err) {
      setStatus(`Remove failed: ${err}`);
    }
  }

  return (
    <main className="container folder-view">
      <div className="folder-header">
        <button onClick={onBack}>← Bookmarks</button>
        {renaming ? (
          <form
            className="folder-rename"
            onSubmit={(e) => {
              e.preventDefault();
              rename();
            }}
          >
            <input
              value={newName}
              onChange={(e) => setNewName(e.currentTarget.value)}
              aria-label="Folder name"
              autoFocus
            />
            <button type="submit">Save</button>
            <button
              type="button"
              onClick={() => {
                setRenaming(false);
                setStatus("");
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <h2 className="folder-name">{folder.name}</h2>
            <button
              onClick={() => {
                setNewName(folder.name);
                setRenaming(true);
              }}
            >
              Rename
            </button>
            <button onClick={deleteFolder}>Delete</button>
          </>
        )}
      </div>
      <div className="folder-status">
        {status || passageCount(passages.length)}
      </div>

      {passages.length === 0 ? (
        <p className="folder-empty">
          No passages yet. Open a book and click the bookmark icon beside a paragraph.
        </p>
      ) : (
        <ul className="folder-passages">
          {passages.map((p) => (
            <li key={p.id} className="folder-passage" onClick={() => onOpenBookmark(p)}>
              <div className="folder-passage-meta">
                <span>
                  {p.book_title ?? "Untitled"} — {p.chapter_title ?? `Chapter ${p.chapter_idx + 1}`}
                </span>
                <button
                  className="folder-passage-remove"
                  onClick={(e) => {
                    e.stopPropagation(); // the passage itself opens the reader
                    removePassage(p);
                  }}
                >
                  Remove
                </button>
              </div>
              <div className="folder-passage-text">{p.text}</div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

export default FolderView;
