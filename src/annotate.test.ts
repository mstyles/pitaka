import { describe, expect, it } from "vitest";
import { segments, selectionOffsets } from "./annotate";
import type { Highlight } from "./types";

function highlight(id: number, start: number, end: number): Highlight {
  return {
    id,
    content_block_id: 1,
    start_offset: start,
    end_offset: end,
    color: "yellow",
    created_at: "",
  };
}

describe("segments", () => {
  it("splits by code point, not UTF-16 unit", () => {
    // "🙂" is one code point but two UTF-16 units.
    const text = "🙂 Paṭācārā went home";
    const parts = segments(text, [highlight(2, 11, 15), highlight(1, 2, 10)]);
    expect(parts.map((p) => [p.text, p.highlight?.id ?? null])).toEqual([
      ["🙂 ", null],
      ["Paṭācārā", 1],
      [" ", null],
      ["went", 2],
      [" home", null],
    ]);
  });

  it("returns the whole text when nothing is highlighted", () => {
    expect(segments("plain", [])).toEqual([{ text: "plain", highlight: null }]);
  });
});

describe("selectionOffsets", () => {
  it("counts code points and skips note markers", () => {
    // As the reader renders it: a highlight, its note marker, then more text.
    const p = document.createElement("p");
    p.innerHTML =
      '🙂 <span><mark>Paṭācārā</mark><button class="note-hint">✎ note</button></span> went home';
    document.body.append(p);
    const after = p.lastChild as Text; // " went home"
    const range = document.createRange();
    range.setStart(after, 1);
    range.setEnd(after, 5);
    expect(range.toString()).toBe("went");
    expect(selectionOffsets(p, range)).toEqual({ start: 11, end: 15 });

    const mark = p.querySelector("mark")!.firstChild as Text;
    range.setStart(p.firstChild!, 0);
    range.setEnd(mark, 3);
    expect(selectionOffsets(p, range)).toEqual({ start: 0, end: 5 });
    p.remove();
  });

  it("handles boundaries given as element offsets", () => {
    const p = document.createElement("p");
    p.innerHTML = "ab<span><mark>cd</mark></span>ef";
    document.body.append(p);
    const range = document.createRange();
    range.setStart(p, 1); // before the span
    range.setEnd(p, 2); // after it
    expect(selectionOffsets(p, range)).toEqual({ start: 2, end: 4 });
    p.remove();
  });
});
