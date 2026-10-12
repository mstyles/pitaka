// Where the reader is in a book: the paragraph at the top of the screen,
// whether the end is showing, and how far through the book that is.
import type { ChapterSummary, ContentBlockRow } from "./types";

/** How long after scrolling stops the position is saved. */
export const SAVE_DELAY_MS = 1000;

/**
 * The id of the first paragraph whose bottom is below the container's top,
 * or null before layout (and in jsdom, which has none).
 */
export function topVisibleBlockId(container: HTMLElement): number | null {
  if (container.clientHeight === 0) return null;
  const paragraphs = container.querySelectorAll<HTMLElement>(".reader-paragraph");
  if (paragraphs.length === 0) return null;
  const top = container.getBoundingClientRect().top + 1;
  // Paragraphs are in reading order, so their bottoms only go down.
  let lo = 0;
  let hi = paragraphs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (paragraphs[mid].getBoundingClientRect().bottom > top) hi = mid;
    else lo = mid + 1;
  }
  return Number(paragraphs[lo].dataset.blockId);
}

/** Whether the container is scrolled to its end. */
export function atEnd(container: HTMLElement): boolean {
  if (container.clientHeight === 0) return false;
  return container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
}

/**
 * The share of the book's characters before `blockId`, rounded, as the core
 * works it out for a saved position. 0 for an empty book.
 */
export function percentRead(
  chapters: ChapterSummary[],
  chapterId: number,
  blocks: ContentBlockRow[],
  blockId: number,
): number {
  const total = chapters.reduce((n, c) => n + c.char_count, 0);
  if (total === 0) return 0;
  const place = chapters.findIndex((c) => c.id === chapterId);
  let before = chapters.slice(0, Math.max(place, 0)).reduce((n, c) => n + c.char_count, 0);
  for (const b of blocks) {
    if (b.id === blockId) break;
    before += [...b.text].length;
  }
  return Math.round((before * 100) / total);
}
