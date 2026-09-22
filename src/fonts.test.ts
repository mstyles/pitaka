// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Read from disk: Vitest replaces CSS imports, even `?raw`, with "".
// Paths are relative to the repo root, where Vitest runs.
const css: string = readFileSync("src/fonts.css", "utf8");

// See the comment at the top of fonts.css: a combining macron in a latin
// subset's range makes Chrome decompose "ā" and misplace the macron.
describe("bundled font subsets", () => {
  const faces = Array.from(css.matchAll(/@font-face\s*{([^}]*)}/g), (m) => ({
    src: /src: url\(([^)]*)\)/.exec(m[1])![1],
    range: /unicode-range: ([^;]*);/.exec(m[1])![1].split(","),
  }));

  it("has a latin and latin-ext face for each family", () => {
    expect(faces).toHaveLength(6);
  });

  it.each(faces.filter((f) => !f.src.includes("latin-ext")))(
    "$src leaves out the combining macron",
    ({ range }) => {
      expect(range).toContain("U+0000-00FF");
      expect(range).not.toContain("U+0304");
    },
  );

  it.each(faces.filter((f) => f.src.includes("latin-ext")))(
    "$src covers the precomposed Pali letters",
    ({ range }) => {
      // ā ī ū (U+0100-017F) and ṃ ṭ ḍ ṇ ḷ ṅ (U+1E00-1E9F).
      expect(range).toEqual(expect.arrayContaining(["U+0100-02BA", "U+1E00-1E9F"]));
    },
  );
});
