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
  ".note-margin",
  ".note-margin:empty",
  ".note-hint",
  ".result-snippet mark",
  ".scope-toggle button:last-child",
]);

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
      (v) => !/^var\(--text-[a-z0-9]+\)$/.test(v.value),
    );
    expect(bad).toEqual([]);
  });

  it("every line-height is a --leading token", () => {
    const bad = values((p) => p === "line-height").filter(
      (v) => !/^var\(--leading-[a-z]+\)$/.test(v.value) && v.value !== "0" && v.value !== "1",
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
    // Set per element, not in :root: the highlight colour classes.
    defined.add("--hl");
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

  it("every colour token has a dark value", () => {
    const [light, dark] = rules.filter(isRoot);
    const lightColours = light.decls
      .filter(([p, v]) => p.startsWith("--") && /^(#|rgba?\()/.test(v))
      .map(([p]) => p);
    const darkNames = new Set(dark.decls.map(([p]) => p));
    expect(lightColours).toContain("--accent-strong");
    expect(lightColours).toContain("--hover");
    expect(lightColours.filter((p) => !darkNames.has(p))).toEqual([]);
  });
});
