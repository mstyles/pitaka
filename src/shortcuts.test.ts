// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Action, keyLabel, MENU_ACTIONS, shortcutFor } from "./shortcuts";

/** The action a keydown on `target` (the body by default) maps to. */
function press(
  init: KeyboardEventInit,
  opts: { browserKeys?: boolean; target?: HTMLElement } = {},
): Action | null {
  const target = opts.target ?? document.body;
  let action: Action | null = null;
  const listener = (e: KeyboardEvent) => {
    action = shortcutFor(e, { browserKeys: opts.browserKeys });
  };
  window.addEventListener("keydown", listener);
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  window.removeEventListener("keydown", listener);
  return action;
}

describe("shortcutFor", () => {
  it("maps Ctrl shortcuts off a Mac", () => {
    expect(press({ key: "f", code: "KeyF", ctrlKey: true })).toBe("go-search");
    expect(press({ key: "o", code: "KeyO", ctrlKey: true })).toBe("import-book");
    expect(press({ key: "O", code: "KeyO", ctrlKey: true, shiftKey: true })).toBe("import-folder");
    expect(press({ key: "3", code: "Digit3", ctrlKey: true })).toBe("go-bookmarks");
  });

  it("maps the digits by their key on layouts like AZERTY", () => {
    expect(press({ key: "#", code: "Digit3", ctrlKey: true })).toBe("go-bookmarks");
  });

  it("ignores Meta, Alt and repeats", () => {
    expect(press({ key: "f", code: "KeyF", metaKey: true })).toBeNull();
    expect(press({ key: "f", code: "KeyF", ctrlKey: true, altKey: true })).toBeNull();
    expect(press({ key: "f", code: "KeyF", ctrlKey: true, repeat: true })).toBeNull();
  });

  it("opens the shortcuts with ?, except in a text field", () => {
    expect(press({ key: "?", shiftKey: true })).toBe("shortcuts");
    const input = document.createElement("input");
    document.body.append(input);
    expect(press({ key: "?", shiftKey: true }, { target: input })).toBeNull();
    expect(press({ key: "o", code: "KeyO", ctrlKey: true }, { target: input })).toBe("import-book");
    input.remove();
  });

  it("leaves Find and Open to the browser in the demo", () => {
    const browserKeys = true;
    expect(press({ key: "f", code: "KeyF", ctrlKey: true }, { browserKeys })).toBeNull();
    expect(press({ key: "o", code: "KeyO", ctrlKey: true }, { browserKeys })).toBeNull();
    expect(
      press({ key: "O", code: "KeyO", ctrlKey: true, shiftKey: true }, { browserKeys }),
    ).toBeNull();
    expect(press({ key: "2", code: "Digit2", ctrlKey: true }, { browserKeys })).toBe("go-books");
    expect(press({ key: "?", shiftKey: true }, { browserKeys })).toBe("shortcuts");
  });

  it("reserves the text size keys", () => {
    expect(press({ key: "=", code: "Equal", ctrlKey: true })).toBe("text-larger");
    expect(press({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true })).toBe("text-larger");
    expect(press({ key: "-", code: "Minus", ctrlKey: true })).toBe("text-smaller");
    expect(press({ key: "0", code: "Digit0", ctrlKey: true })).toBe("text-reset");
  });
});

describe("keyLabel", () => {
  it("names Ctrl and Shift off a Mac", () => {
    expect(keyLabel("O")).toBe("Ctrl+O");
    expect(keyLabel("O", { shift: true })).toBe("Ctrl+Shift+O");
  });
});

describe("the app menu", () => {
  // Read from disk, as fonts.test.ts does; paths are relative to the repo root.
  const menu: string = readFileSync("src-tauri/src/menu.rs", "utf8");
  // `item("id", …)` is menu.rs's shorthand for `MenuItemBuilder::with_id`.
  const ids = Array.from(
    menu.matchAll(/(?:MenuItemBuilder::with_id|\bitem)\(\s*"([a-z-]+)"/g),
    (m) => m[1],
  );

  it("sends the actions the frontend knows", () => {
    expect(ids.length).toBeGreaterThan(0);
    const handledInRust = ["quit", "website", "report"];
    expect(ids.filter((id) => !handledInRust.includes(id))).toEqual(
      expect.arrayContaining(MENU_ACTIONS),
    );
    expect(
      ids.filter((id) => !handledInRust.includes(id) && !MENU_ACTIONS.includes(id as Action)),
    ).toEqual([]);
  });
});
