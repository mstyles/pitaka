import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { COLORS } from "./SelectionToolbar";
import type { Highlight } from "./types";

type Props = {
  highlight: Highlight;
  hasNote: boolean;
  /** Where to draw it, relative to its `.reader-block`. */
  top: number;
  left: number;
  onAddNote: () => void;
  onChanged: () => void;
  /** After the highlight is removed; `onClose` follows. */
  onRemoved: () => void;
  onClose: () => void;
};

/** Recolours or removes a highlight, or starts its note. */
function HighlightPopover({
  highlight,
  hasNote,
  top,
  left,
  onAddNote,
  onChanged,
  onRemoved,
  onClose,
}: Props) {
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Element;
      // A highlight's own click opens, moves or closes the popover.
      if (target.closest?.("mark.hl")) return;
      if (ref.current && !ref.current.contains(target)) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose]);

  async function recolor(color: string) {
    setError("");
    try {
      await invoke("set_highlight_color", { highlightId: highlight.id, color });
      onChanged();
    } catch (err) {
      setError(String(err));
    }
  }

  async function remove() {
    if (
      hasNote &&
      !(await ask("Remove this highlight and its note?", {
        title: "Remove highlight",
        kind: "warning",
        okLabel: "Remove",
        cancelLabel: "Cancel",
      }))
    ) {
      return;
    }
    try {
      await invoke("delete_highlight", { highlightId: highlight.id });
      onRemoved();
      onChanged();
      onClose();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div
      className="highlight-popover"
      ref={ref}
      role="dialog"
      aria-label="Highlight"
      style={{ top, left }}
    >
      <div className="highlight-popover-row">
        {COLORS.map((c) => (
          <button
            key={c}
            className={`swatch hl-${c}`}
            aria-label={c[0].toUpperCase() + c.slice(1)}
            aria-pressed={highlight.color === c}
            title={c}
            onClick={() => recolor(c)}
          />
        ))}
      </div>
      <div className="highlight-popover-row">
        {!hasNote && <button onClick={onAddNote}>Add note</button>}
        <button className="button-danger" onClick={remove}>
          Remove
        </button>
      </div>
      {error && <div className="bookmark-popover-error">{error}</div>}
    </div>
  );
}

export default HighlightPopover;
