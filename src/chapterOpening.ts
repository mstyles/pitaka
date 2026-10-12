import type { ChapterContent } from "./types";

/**
 * A paragraph this long reads as prose; shorter ones near a chapter's start
 * are labels ("PART I", a median of 18 characters in the library) or verse.
 */
export const OPENING_MIN_CHARS = 100;
/** How many blocks past the heading to look for the opening paragraph. */
const OPENING_LOOKAHEAD = 4;

const normal = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Guesses where a chapter opens, as the parser drops heading markup: the
 * title block, when the first block is the chapter's title, and the first
 * paragraph of prose after it, whose first line is set in small caps.
 */
export function chapterOpening(content: ChapterContent): {
  headingId: number | null;
  openingId: number | null;
} {
  const { blocks, chapter_title } = content;
  const first = blocks[0];
  const title = normal(chapter_title ?? "");
  const heading = first != null && title !== "" && normal(first.text) === title ? first : null;
  const from = heading ? 1 : 0;
  const opening = blocks
    .slice(from, from + OPENING_LOOKAHEAD)
    .find((b) => [...b.text].length >= OPENING_MIN_CHARS);
  return { headingId: heading?.id ?? null, openingId: opening?.id ?? null };
}
