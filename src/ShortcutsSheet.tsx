import { type ReactNode, useEffect, useRef } from "react";
import { keyLabel } from "./shortcuts";

type Props = {
  /** The browser demo, where Mod+F and Mod+O are left to the browser. */
  browserKeys: boolean;
  onClose: () => void;
};

type Row = { keys: ReactNode; does: string };

const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/** The keyboard shortcuts, from `?` or Help → Keyboard shortcuts. */
function ShortcutsSheet({ browserKeys, onClose }: Props) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus moves in on open and back to where it was on close.
  useEffect(() => {
    const before = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  // In the capture phase, so no key reaches the screen behind the sheet.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab" && sheetRef.current) {
        const focusable = Array.from(sheetRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const inside = sheetRef.current.contains(document.activeElement);
        if (!inside || document.activeElement === (e.shiftKey ? first : last)) {
          e.preventDefault();
          (e.shiftKey ? last : first)?.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const anywhere: Row[] = [
    ...(browserKeys
      ? []
      : [
          { keys: <kbd>{keyLabel("F")}</kbd>, does: "Search (in a book: search that book)" },
          { keys: <kbd>{keyLabel("O")}</kbd>, does: "Import a book" },
          { keys: <kbd>{keyLabel("O", { shift: true })}</kbd>, does: "Import a folder" },
        ]),
    {
      keys: (
        <>
          <kbd>{keyLabel("1")}</kbd>–<kbd>4</kbd>
        </>
      ),
      does: "Home, Books, Bookmarks & notes, Search",
    },
    { keys: <kbd>?</kbd>, does: "This list" },
  ];
  const reader: Row[] = [
    {
      keys: (
        <>
          <kbd>←</kbd> / <kbd>→</kbd>
        </>
      ),
      does: "Previous / next chapter",
    },
    { keys: <kbd>Esc</kbd>, does: "Close the popup, or go back" },
  ];

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
      >
        <h2 id="shortcuts-title">Keyboard shortcuts</h2>
        <Section title="Anywhere" rows={anywhere} />
        <Section title="In the reader" rows={reader} />
        <div className="sheet-actions">
          <button ref={closeRef} className="button-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section className="sheet-section">
      <h3 className="section-label">{title}</h3>
      <dl>
        {rows.map((r) => (
          <div key={r.does} className="sheet-row">
            <dt>{r.keys}</dt>
            <dd>{r.does}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default ShortcutsSheet;
