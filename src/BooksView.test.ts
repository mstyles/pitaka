import { describe, expect, it } from "vitest";
import { matchesFilter, sortBooks } from "./BooksView";
import type { BookSummary } from "./types";

function book(id: number, title: string | null, author: string | null = "An Author"): BookSummary {
  return {
    id,
    title,
    author,
    chapter_count: 1,
    bookmark_count: 0,
    highlight_count: 0,
    note_count: 0,
    index_state: "indexed",
  };
}

describe("matchesFilter", () => {
  it("ignores case and accents", () => {
    expect(matchesFilter(book(1, "Nibbāna Sermons"), "NIBBANA")).toBe(true);
    expect(matchesFilter(book(1, "Old Path", "Thích Nhất Hạnh"), "thich nhat")).toBe(true);
  });

  it("needs every word, from the title or author, in any order", () => {
    const b = book(1, "The Heart of the Buddha's Teaching", "Hanh, Thich Nhat");
    expect(matchesFilter(b, "nhat hanh heart")).toBe(true);
    expect(matchesFilter(b, "nhat hanh peace")).toBe(false);
  });

  it("matches the text shown for a missing title or author", () => {
    expect(matchesFilter(book(1, "A Book", null), "unknown")).toBe(true);
    expect(matchesFilter(book(1, null), "untitled")).toBe(true);
  });

  it("matches everything when the filter is blank", () => {
    expect(matchesFilter(book(1, "A Book"), "   ")).toBe(true);
  });
});

describe("sortBooks", () => {
  const titles = (books: BookSummary[]) => books.map((b) => b.title);

  it("files titles without a leading article", () => {
    const books = [book(1, "The Zen Book"), book(2, "A Middle Way"), book(3, "Being Peace")];
    expect(titles(sortBooks(books, "title"))).toEqual([
      "Being Peace",
      "A Middle Way",
      "The Zen Book",
    ]);
  });

  it("orders numbers by value and ignores accents", () => {
    const books = [
      book(1, "Book 10"),
      book(2, "Eclipse"),
      book(3, "Book 9"),
      book(4, "éclair"),
      book(5, "Eagle"),
    ];
    expect(titles(sortBooks(books, "title"))).toEqual([
      "Book 9",
      "Book 10",
      "Eagle",
      "éclair",
      "Eclipse",
    ]);
  });

  it("puts untitled books last, and breaks ties by author then id", () => {
    const books = [book(1, null), book(2, "Same", "Zed"), book(3, "Same", "Abe"), book(4, null)];
    expect(sortBooks(books, "title").map((b) => b.id)).toEqual([3, 2, 1, 4]);
  });

  it("keeps the library's order when sorting by date added, without changing it", () => {
    const books = [book(1, "B"), book(2, "A")];
    const sorted = sortBooks(books, "added");
    expect(titles(sorted)).toEqual(["B", "A"]);
    expect(sorted).not.toBe(books);
  });
});
