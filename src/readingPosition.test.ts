import { describe, expect, it } from "vitest";
import { percentRead, topVisibleBlockId } from "./readingPosition";
import { fixtures } from "./test/mockBackend";

function rect(top: number, bottom: number) {
  return { top, bottom, left: 0, right: 0, width: 0, height: bottom - top } as DOMRect;
}

/** A laid-out container at `top` holding paragraphs with these bottoms. */
function container(top: number, bottoms: number[]) {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientHeight", { value: 500 });
  el.getBoundingClientRect = () => rect(top, top + 500);
  bottoms.forEach((bottom, i) => {
    const p = document.createElement("p");
    p.className = "reader-paragraph";
    p.dataset.blockId = String(i + 1);
    p.getBoundingClientRect = () => rect(bottom - 40, bottom);
    el.appendChild(p);
  });
  return el;
}

describe("topVisibleBlockId", () => {
  it("is null before layout", () => {
    const el = document.createElement("div");
    el.innerHTML = '<p class="reader-paragraph" data-block-id="1"></p>';
    expect(topVisibleBlockId(el)).toBeNull();
  });

  it("finds the first paragraph whose bottom is below the top", () => {
    expect(topVisibleBlockId(container(100, [20, 60, 101, 130, 400]))).toBe(4);
    expect(topVisibleBlockId(container(100, [140, 180, 220, 260, 300]))).toBe(1);
    expect(topVisibleBlockId(container(100, [102, 180, 220, 260, 300]))).toBe(1);
    expect(topVisibleBlockId(container(100, [0, 20, 40, 60, 150]))).toBe(5);
  });
});

describe("percentRead", () => {
  it("matches the core's percent for a saved position", () => {
    const sample = fixtures.reading_position_sample!;
    const chapters = fixtures.chapters[String(sample.book_id)];
    const content = fixtures.chapter_content[String(sample.chapter_id)];
    expect(percentRead(chapters, sample.chapter_id, content.blocks, sample.content_block_id)).toBe(
      sample.percent,
    );
    expect(sample.percent).toBeGreaterThan(0);
  });

  it("is 0 at the start and for an empty book", () => {
    const sample = fixtures.reading_position_sample!;
    const chapters = fixtures.chapters[String(sample.book_id)];
    const first = fixtures.chapter_content[String(chapters[0].id)];
    expect(percentRead(chapters, chapters[0].id, first.blocks, first.blocks[0].id)).toBe(0);
    expect(percentRead([{ id: 1, idx: 0, title: null, char_count: 0 }], 1, [], 1)).toBe(0);
  });
});
