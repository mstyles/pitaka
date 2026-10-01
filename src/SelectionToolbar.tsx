import type { HighlightColor } from "./types";

export const COLORS: HighlightColor[] = ["yellow", "green", "blue", "pink"];

type Props = {
  /** Where to draw it, relative to `.reader-text`: centred above this point. */
  top: number;
  left: number;
  /** False when the selection crosses paragraphs, which can't be highlighted. */
  valid: boolean;
  error: string;
  onHighlight: (color: HighlightColor) => void;
  onAddNote: () => void;
};

/** Floats above a text selection in the reader, to highlight it or note it. */
function SelectionToolbar({ top, left, valid, error, onHighlight, onAddNote }: Props) {
  return (
    <div
      className="selection-toolbar"
      role="toolbar"
      aria-label="Highlight selection"
      style={{ top, left }}
      // Keeps the selection while a button is pressed.
      onMouseDown={(e) => e.preventDefault()}
    >
      {valid ? (
        <>
          {COLORS.map((c) => (
            <button
              key={c}
              className={`swatch hl-${c}`}
              aria-label={`Highlight ${c}`}
              title={`Highlight ${c}`}
              onClick={() => onHighlight(c)}
            />
          ))}
          <button className="selection-toolbar-note" onClick={onAddNote}>
            Add note
          </button>
        </>
      ) : (
        <span className="selection-toolbar-message">Highlights stay within one paragraph</span>
      )}
      {error && <div className="selection-toolbar-error">{error}</div>}
    </div>
  );
}

export default SelectionToolbar;
