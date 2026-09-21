import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BookmarkFolder } from "./types";

type Props = {
  contentBlockId: number;
  folders: BookmarkFolder[];
  /** The folders this paragraph is already in. */
  checkedFolderIds: Set<number>;
  onChanged: () => void;
  onClose: () => void;
};

/** Ticks a paragraph into or out of bookmark folders, or into a new one. */
function BookmarkPopover({ contentBlockId, folders, checkedFolderIds, onChanged, onClose }: Props) {
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Element;
      // A bookmark icon's own click opens, moves or closes the popover.
      if (target.closest?.(".bookmark-toggle")) return;
      if (ref.current && !ref.current.contains(target)) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose]);

  async function toggle(folderId: number, checked: boolean) {
    setError("");
    try {
      await invoke(checked ? "add_bookmark" : "remove_bookmark", {
        folderId,
        contentBlockId,
      });
    } catch (err) {
      setError(String(err));
    }
    onChanged();
  }

  async function createFolder() {
    setError("");
    try {
      const folder = await invoke<BookmarkFolder>("create_bookmark_folder", { name: newName });
      await invoke("add_bookmark", { folderId: folder.id, contentBlockId });
      setNewName("");
    } catch (err) {
      setError(String(err));
    }
    onChanged();
  }

  return (
    <div className="bookmark-popover" ref={ref} role="dialog" aria-label="Bookmark folders">
      {folders.length > 0 && (
        <>
          <div className="bookmark-popover-heading">Add to folder</div>
          <ul className="bookmark-popover-folders">
            {folders.map((f) => (
              <li key={f.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={checkedFolderIds.has(f.id)}
                    onChange={(e) => toggle(f.id, e.currentTarget.checked)}
                  />
                  {f.name}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          createFolder();
        }}
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.currentTarget.value)}
          placeholder="New folder…"
          aria-label="New folder name"
          autoFocus
        />
      </form>
      {error && <div className="bookmark-popover-error">{error}</div>}
    </div>
  );
}

export default BookmarkPopover;
