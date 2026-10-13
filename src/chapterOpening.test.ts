import { describe, expect, it } from "vitest";
import { chapterOpening } from "./chapterOpening";
import type { ChapterContent } from "./types";

const TITLE = "Paṭācārā";

/** A chapter whose blocks have these texts, with ids 1, 2, 3… */
function chapter(title: string | null, texts: string[]): ChapterContent {
  return {
    chapter_id: 1,
    chapter_idx: 0,
    chapter_title: title,
    book_id: 1,
    blocks: texts.map((text, i) => ({ id: i + 1, block_idx: i, text })),
  };
}

const chars = (n: number) => "x".repeat(n);

describe("chapterOpening", () => {
  it("takes a first block that is the title as the heading", () => {
    const c = chapter(TITLE.normalize("NFD"), [`  ${TITLE.toLowerCase().normalize("NFC")} `]);
    expect(chapterOpening(c).headingId).toBe(1);
  });

  it("opens with a long paragraph right after the heading", () => {
    expect(chapterOpening(chapter(TITLE, [TITLE, chars(120)]))).toEqual({
      headingId: 1,
      openingId: 2,
    });
  });

  it("skips short labels to the first paragraph of prose", () => {
    const c = chapter(TITLE, [TITLE, chars(18), chars(40), chars(150)]);
    expect(chapterOpening(c).openingId).toBe(4);
  });

  it("looks only a few blocks ahead", () => {
    const c = chapter(TITLE, [TITLE, ...Array(5).fill(chars(20)), chars(150)]);
    expect(chapterOpening(c)).toEqual({ headingId: 1, openingId: null });
  });

  it("counts from the first block when there's no heading", () => {
    expect(chapterOpening(chapter("Part One", [chars(120)]))).toEqual({
      headingId: null,
      openingId: 1,
    });
  });

  it("has no heading without a title", () => {
    expect(chapterOpening(chapter(null, [TITLE])).headingId).toBeNull();
  });

  it("has neither in an empty chapter", () => {
    expect(chapterOpening(chapter(TITLE, []))).toEqual({ headingId: null, openingId: null });
  });
});
