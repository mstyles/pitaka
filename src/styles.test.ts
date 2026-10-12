// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Read from disk, as in fonts.test.ts: Vitest replaces CSS imports with "".
const css: string = readFileSync("src/App.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selector: string; decls: [string, string][] };

// Each innermost `selector { declarations }` block, so rules inside @media
// are included.
const rules: Rule[] = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => ({
  selector: m[1].trim().replace(/\s+/g, " "),
  decls: m[2]
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(":");
      return [
        d.slice(0, i).trim(),
        d
          .slice(i + 1)
          .trim()
          .replace(/\s+/g, " "),
      ];
    }),
}));

const isRoot = (r: Rule) => r.selector === ":root";
const outsideRoot = rules.filter((r) => !isRoot(r));

function values(prop: (p: string) => boolean): { selector: string; value: string }[] {
  return outsideRoot.flatMap((r) =>
    r.decls.filter(([p]) => prop(p)).map(([, value]) => ({ selector: r.selector, value })),
  );
}

// Values in the reader that scale with the reading text stay in em (App.css
// says why beside each one).
const SPACING_EXEMPT = new Set([
  ".reader-paragraph",
  ".reader-chapter-heading",
  ".reader-content",
  ".note-margin",
  ".with-margin .note-margin",
  ".with-margin .note-margin:empty",
  ".note-hint",
  ".result-snippet mark",
  ".scope-toggle button + button",
]);

// The reader's text takes its size, spacing and width from the Display
// panel (readerSettings.ts), and its chapter heading is in em of that size.
const READER_TEXT: Record<string, Record<string, string>> = {
  ".reader-text": {
    "font-size": "var(--reader-size)",
    "line-height": "var(--reader-leading)",
    "max-width": "var(--reader-measure)",
  },
};
const FONT_SIZE_EXEMPT = new Set([".reader-chapter-heading"]);

const allowed = (v: { selector: string; value: string }, prop: string) =>
  READER_TEXT[v.selector]?.[prop] === v.value;

// Splits on spaces outside parentheses, so a calc() stays one part.
function parts(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === " " && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.filter(Boolean);
}

function isSpacing(part: string): boolean {
  if (part === "0" || part === "auto" || /^var\(--space-\d+\)$/.test(part)) return true;
  if (part.startsWith("calc(")) {
    const rest = part
      .replace(/var\(--space-\d+\)/g, "")
      .replace(/\b\d+px\b/g, "")
      .replace(/-?\d+(\.\d+)?/g, "");
    return /^calc\([\s()*+\-/]*\)$/.test(rest);
  }
  return false;
}

describe("App.css tokens", () => {
  it("every font-size is a --text token", () => {
    const bad = values((p) => p === "font-size").filter(
      (v) =>
        !/^var\(--text-[a-z0-9]+\)$/.test(v.value) &&
        !allowed(v, "font-size") &&
        !FONT_SIZE_EXEMPT.has(v.selector),
    );
    expect(bad).toEqual([]);
  });

  it("every line-height is a --leading token", () => {
    const bad = values((p) => p === "line-height").filter(
      (v) =>
        !/^var\(--leading-[a-z]+\)$/.test(v.value) &&
        v.value !== "0" &&
        v.value !== "1" &&
        !allowed(v, "line-height"),
    );
    expect(bad).toEqual([]);
  });

  it("spacing uses --space tokens", () => {
    const bad = values((p) => /^(padding|margin)(-[a-z]+)?$/.test(p) || p === "gap").filter(
      (v) =>
        !v.selector.split(",").every((s) => SPACING_EXEMPT.has(s.trim())) &&
        !parts(v.value).every(isSpacing),
    );
    expect(bad).toEqual([]);
  });

  it("every var() it uses is defined", () => {
    const root = rules.find(isRoot)!;
    const defined = new Set(root.decls.map(([p]) => p));
    // Set per element, not in :root: the highlight colour classes, and a
    // generated book cover's tint.
    defined.add("--hl");
    defined.add("--cover-tint");
    const used = new Set(Array.from(css.matchAll(/var\((--[a-z0-9-]+)/g), (m) => m[1]));
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });

  it("every animation is a short entrance or one of the loading loops", () => {
    const bad = values((p) => p === "animation").filter(
      (v) =>
        !/var\(--motion-(fast|base)\)/.test(v.value) &&
        !/^(spin|skeleton-pulse) [\d.]+s (linear|ease-in-out) infinite$/.test(v.value) &&
        v.value !== "none !important",
    );
    expect(values((p) => p === "animation").length).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it("turns animation off under prefers-reduced-motion", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\{\s*animation: none !important;\s*\}/,
    );
  });

  it("leaves icon strokes to Lucide", () => {
    // Lucide sets the stroke as attributes; CSS may fill an icon, not restroke it.
    const bad = values((p) => p.startsWith("stroke"));
    expect(bad).toEqual([]);
  });

  describe("themes", () => {
    const light = rules.find(isRoot)!;
    const lightColours = light.decls
      .filter(([p, v]) => p.startsWith("--") && /^(#|rgba?\()/.test(v))
      .map(([p]) => p);
    const theme = (selector: string) => {
      const rule = rules.find((r) => r.selector === selector);
      expect(rule).toBeDefined();
      return new Map(rule!.decls);
    };
    // The system's dark mode, unless the reader picked Light or Sepia.
    const systemDark = theme(':root:not([data-theme="light"]):not([data-theme="sepia"])');

    it("every colour token has a dark value", () => {
      expect(lightColours).toContain("--accent-strong");
      expect(lightColours).toContain("--hover");
      expect(lightColours.filter((p) => !systemDark.has(p))).toEqual([]);
    });

    it("the chosen Dark theme matches the system's dark mode", () => {
      expect(Object.fromEntries(theme(':root[data-theme="dark"]'))).toEqual(
        Object.fromEntries(systemDark),
      );
    });

    it("Sepia sets every colour token", () => {
      const sepia = theme(':root[data-theme="sepia"]');
      expect(lightColours.filter((p) => !sepia.has(p))).toEqual([]);
      expect(sepia.get("color-scheme")).toBe("light");
    });
  });

  it("the reader's text takes its size, spacing and width from the settings", () => {
    const text = rules.find((r) => r.selector === ".reader-text")!;
    expect(Object.fromEntries(text.decls)).toMatchObject(READER_TEXT[".reader-text"]);
  });
});
