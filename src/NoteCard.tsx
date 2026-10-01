import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import type { HighlightColor, Note } from "./types";

type Props = {
  /** Null for a note that doesn't exist yet, which opens ready to type. */
  note: Note | null;
  contentBlockId: number;
  highlightId: number | null;
  /** The highlight's colour, for the rule that matches the card to its marker. */
  color: HighlightColor | null;
  onChanged: () => void;
  /** A new note was saved; the card stays open showing it. */
  onCreated: (note: Note) => void;
  onClose: () => void;
};

/** A note in the reader's margin: read it, or edit it in place. */
function NoteCard({ note, contentBlockId, highlightId, color, onChanged, onCreated, onClose }: Props) {
  const [editing, setEditing] = useState(note == null);
  const [draft, setDraft] = useState(note?.body ?? "");
  const [error, setError] = useState("");

  async function save() {
    setError("");
    if (!draft.trim()) {
      // An emptied note is a deleted one; a new one is just abandoned.
      if (note) await remove();
      else onClose();
      return;
    }
    try {
      if (note) {
        await invoke("update_note", { noteId: note.id, body: draft });
        setEditing(false);
      } else {
        const created =
          highlightId != null
            ? await invoke<Note>("add_highlight_note", { highlightId, body: draft })
            : await invoke<Note>("add_paragraph_note", { contentBlockId, body: draft });
        onCreated(created);
      }
      onChanged();
    } catch (err) {
      setError(String(err));
    }
  }

  async function remove() {
    if (!note) return;
    const confirmed = await ask("Delete this note?", {
      title: "Delete note",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    try {
      await invoke("delete_note", { noteId: note.id });
      onClose();
      onChanged();
    } catch (err) {
      setError(String(err));
    }
  }

  function cancel() {
    setError("");
    if (!note) {
      onClose();
      return;
    }
    setDraft(note.body);
    setEditing(false);
  }

  return (
    <div
      className={`note-card${color ? ` note-card-${color}` : ""}`}
      role="group"
      aria-label={highlightId != null ? "Note on highlight" : "Note on paragraph"}
    >
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") cancel();
            }}
            aria-label="Note"
            rows={4}
            autoFocus
          />
          <div className="note-card-actions">
            <button type="submit" className="button-primary">
              Save
            </button>
            <button type="button" onClick={cancel}>
              Cancel
            </button>
            {note && (
              <button type="button" className="button-danger" onClick={remove}>
                Delete
              </button>
            )}
          </div>
        </form>
      ) : (
        <>
          <div className="note-card-body">{note?.body}</div>
          <div className="note-card-actions">
            <button onClick={() => setEditing(true)}>Edit</button>
            <button onClick={onClose}>Hide</button>
          </div>
        </>
      )}
      {error && <div className="bookmark-popover-error">{error}</div>}
    </div>
  );
}

export default NoteCard;
