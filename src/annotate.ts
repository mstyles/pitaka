// Highlights are stored as code-point offsets into a paragraph's text (the
// core counts `chars()`), while the DOM measures in UTF-16 units. These
// helpers convert between the two.
import type { Highlight } from "./types";

export type Segment = { text: string; highlight: Highlight | null };

/**
 * Splits a paragraph into plain and highlighted runs. `highlights` are the
 * paragraph's own, which never overlap; order doesn't matter.
 */
export function segments(text: string, highlights: Highlight[]): Segment[] {
  const chars = Array.from(text);
  const sorted = [...highlights].sort((a, b) => a.start_offset - b.start_offset);
  const out: Segment[] = [];
  let at = 0;
  for (const h of sorted) {
    if (h.start_offset > at) {
      out.push({ text: chars.slice(at, h.start_offset).join(""), highlight: null });
    }
    out.push({ text: chars.slice(h.start_offset, h.end_offset).join(""), highlight: h });
    at = h.end_offset;
  }
  if (at < chars.length) out.push({ text: chars.slice(at).join(""), highlight: null });
  return out;
}

/** Elements inside a paragraph whose text isn't the paragraph's: the note markers. */
const NOT_TEXT = ".note-hint";

/** Code points of the paragraph's own text before the point (container, offset). */
function codePointsBefore(paragraph: HTMLElement, container: Node, offset: number) {
  const before = document.createRange();
  before.setStart(paragraph, 0);
  before.setEnd(container, offset);
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  let count = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(NOT_TEXT)) continue;
    const text = (node as Text).data;
    if (node === container) {
      count += Array.from(text.slice(0, offset)).length;
      break;
    }
    if (!before.intersectsNode(node)) break;
    count += Array.from(text).length;
  }
  return count;
}

/** A selection inside one paragraph, as code-point offsets into its text. */
export function selectionOffsets(paragraph: HTMLElement, range: Range) {
  return {
    start: codePointsBefore(paragraph, range.startContainer, range.startOffset),
    end: codePointsBefore(paragraph, range.endContainer, range.endOffset),
  };
}
