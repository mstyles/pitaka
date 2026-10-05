import { describe, expect, it } from "vitest";
import coreResults from "../test/fixtures/demo-search.json";
import type { BookSummary, ChapterContent, SearchMode, SearchResult } from "../types";
import demo from "./library.json";
import { porterStem } from "./porter";
import { createSearch } from "./search";

const search = createSearch(Object.values(demo.chapter_content) as ChapterContent[]);
// JSON imports type `index_state` as a plain string.
const books = demo.books as BookSummary[];

describe("demo search matches the core's FTS5 search", () => {
  it.each(Object.entries(coreResults as Record<string, SearchResult[]>))("%s", (key, expected) => {
    const [mode, ...rest] = key.split(":");
    const actual = search(books, rest.join(":"), mode as SearchMode);

    expect(actual.map((r) => r.content_block_id)).toEqual(expected.map((r) => r.content_block_id));
    expect(actual.map((r) => r.snippet)).toEqual(expected.map((r) => r.snippet));
    actual.forEach((r, i) => expect(r.rank).toBeCloseTo(expected[i].rank, 9));
    expect(actual).toEqual(expected.map((r, i) => ({ ...r, rank: actual[i].rank })));
  });

  it("finds nothing once the book is removed", () => {
    expect(search([], "patacara", "stemmed")).toEqual([]);
  });

  it("ignores empty queries and trailing operators", () => {
    expect(search(books, "  ", "stemmed")).toEqual([]);
    expect(search(books, "craving OR", "stemmed")).toEqual(search(books, "craving", "stemmed"));
  });
});

describe("porterStem", () => {
  it.each([
    ["caresses", "caress"],
    ["ponies", "poni"],
    ["cats", "cat"],
    ["agreed", "agre"],
    ["seeing", "see"],
    ["hopping", "hop"],
    ["filing", "file"],
    ["happy", "happi"],
    ["relational", "relat"],
    ["generalization", "gener"],
    ["mindful", "mind"],
    ["controll", "control"],
    ["go", "go"],
  ])("%s -> %s", (word, stem) => {
    expect(porterStem(word)).toBe(stem);
  });
});
