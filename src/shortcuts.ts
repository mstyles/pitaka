// The app's keyboard shortcuts, and the action names the app menu shares
// with them. Keys are handled only here, in the frontend, on every
// platform: the menu has no accelerators (see src-tauri/src/menu.rs), and
// the browser demo, `dev:mock` and the tests have no menu at all.
import { useEffect, useRef } from "react";

export type Action =
  | "go-home"
  | "go-books"
  | "go-bookmarks"
  | "go-search"
  | "import-book"
  | "import-folder"
  | "back-up"
  | "restore"
  | "shortcuts"
  // Reserved for the reader's text size; nothing handles them yet.
  | "text-larger"
  | "text-smaller"
  | "text-reset";

/** The actions src-tauri/src/menu.rs emits as `menu` events; a test checks they match. */
export const MENU_ACTIONS: Action[] = [
  "import-book",
  "import-folder",
  "back-up",
  "restore",
  "go-home",
  "go-books",
  "go-bookmarks",
  "go-search",
  "shortcuts",
];

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "Ctrl+O" or "Ctrl+Shift+O"; "⌘O" or "⇧⌘O" on a Mac. */
export function keyLabel(key: string, opts: { shift?: boolean } = {}) {
  if (isMac) return `${opts.shift ? "⇧" : ""}⌘${key}`;
  return `Ctrl+${opts.shift ? "Shift+" : ""}${key}`;
}

/** Whether keys typed at `target` are text: `?` is typed there, not a shortcut. */
export function isEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) {
    return target.type !== "checkbox" && target.type !== "radio";
  }
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable ||
    target.closest("[contenteditable]:not([contenteditable='false'])") != null
  );
}

const SECTIONS: Record<string, Action> = {
  "1": "go-home",
  "2": "go-books",
  "3": "go-bookmarks",
  "4": "go-search",
};

/**
 * The action a keydown asks for, if any. `browserKeys` (the browser demo)
 * leaves Mod+F and Mod+O to the browser's Find and Open.
 */
export function shortcutFor(e: KeyboardEvent, opts: { browserKeys?: boolean } = {}): Action | null {
  if (e.repeat || e.isComposing || e.altKey) return null;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const other = isMac ? e.ctrlKey : e.metaKey;

  if (!mod && !other) {
    return e.key === "?" && !isEditable(e.target) ? "shortcuts" : null;
  }
  if (!mod || other) return null;

  // By the physical key too, so layouts where the digits or =/- need
  // Shift (AZERTY) still work.
  const digit = /^Digit([0-9])$/.exec(e.code)?.[1] ?? (/^[0-9]$/.test(e.key) ? e.key : null);
  if (digit != null && digit in SECTIONS) return SECTIONS[digit];
  if (digit === "0") return "text-reset";
  if (e.code === "Equal" || e.key === "=" || e.key === "+") return "text-larger";
  if (e.code === "Minus" || e.key === "-") return "text-smaller";

  const key = e.key.toLowerCase();
  if (opts.browserKeys && (key === "f" || key === "o")) return null;
  if (key === "f" && !e.shiftKey) return "go-search";
  if (key === "o") return e.shiftKey ? "import-folder" : "import-book";
  return null;
}

/**
 * Runs `onAction` for each shortcut pressed while `enabled`. When it
 * returns false the key wasn't used, and the browser keeps it: a reserved
 * text-size key is still the browser's zoom until something handles it.
 */
export function useShortcuts(
  onAction: (a: Action) => boolean | void,
  enabled: boolean,
  opts: { browserKeys?: boolean } = {},
) {
  // The latest callback, so the listener isn't re-added on every render.
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const browserKeys = opts.browserKeys ?? false;

  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      const action = shortcutFor(e, { browserKeys });
      if (action && onActionRef.current(action) !== false) e.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, browserKeys]);
}
