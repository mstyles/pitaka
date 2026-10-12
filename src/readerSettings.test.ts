import { describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  DEFAULTS,
  largerText,
  loadSettings,
  resetText,
  saveSettings,
  smallerText,
} from "./readerSettings";

const KEY = "pitaka.reader-settings";

describe("reader settings", () => {
  it("are the defaults when nothing is stored", () => {
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it("load as stored", () => {
    localStorage.setItem(KEY, '{"v":1,"size":23,"leading":"loose","width":"wide","theme":"sepia"}');
    expect(loadSettings()).toEqual({ size: 23, leading: "loose", width: "wide", theme: "sepia" });
  });

  it("round-trip through saveSettings", () => {
    const s = { size: 16, leading: "tight", width: "narrow", theme: "dark" } as const;
    saveSettings(s);
    expect(loadSettings()).toEqual(s);
  });

  it("drop a field that isn't an allowed value", () => {
    localStorage.setItem(KEY, '{"v":1,"size":99,"leading":"x","theme":"blue"}');
    expect(loadSettings()).toEqual({
      size: 19,
      leading: "normal",
      width: "medium",
      theme: "system",
    });
  });

  it("are the defaults for bad JSON or another version", () => {
    localStorage.setItem(KEY, "not json");
    expect(loadSettings()).toEqual(DEFAULTS);
    localStorage.setItem(KEY, '{"v":2,"size":23,"leading":"loose","width":"wide","theme":"sepia"}');
    expect(loadSettings()).toEqual(DEFAULTS);
    localStorage.setItem(KEY, "null");
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it("survive storage that throws", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    try {
      expect(loadSettings()).toEqual(DEFAULTS);
      expect(() => saveSettings({ ...DEFAULTS, size: 23 })).not.toThrow();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it("step the text size and stop at the ends", () => {
    expect(largerText({ ...DEFAULTS, size: 26 }).size).toBe(26);
    expect(smallerText({ ...DEFAULTS, size: 16 }).size).toBe(16);
    expect(largerText({ ...DEFAULTS, size: 19 }).size).toBe(21);
    expect(smallerText({ ...DEFAULTS, size: 19 }).size).toBe(17);
  });

  it("reset the text but keep the theme", () => {
    expect(resetText({ size: 23, leading: "loose", width: "wide", theme: "dark" })).toEqual({
      ...DEFAULTS,
      theme: "dark",
    });
  });

  it("set the theme on the document, or leave it to the system", () => {
    applyTheme("sepia");
    expect(document.documentElement.dataset.theme).toBe("sepia");
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
