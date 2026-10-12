import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fixtures } from "./test/mockBackend";
import { goTo, renderApp, resultItems, search } from "./test/renderApp";

const HIT = fixtures.search["stemmed:quincunx"][0];

function paragraphs() {
  return Array.from(document.querySelectorAll<HTMLParagraphElement>(".reader-paragraph"));
}

describe("reader", () => {
  it("opens a book at its first chapter", async () => {
    const { user, callsTo } = renderApp();
    await goTo(user, "Books");
    await user.click(await screen.findByText("A Long Book for Scrolling"));

    const partOne = await screen.findByRole("button", { name: "Part One" });
    expect(partOne.className).toBe("active");
    expect(screen.getByRole("button", { name: "Part Two" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Part Three" })).toBeTruthy();
    await waitFor(() => expect(paragraphs()).toHaveLength(40));
    expect(paragraphs()[0].textContent).toMatch(/^Part One, paragraph 1:/);
    expect(callsTo("get_book_chapters")).toEqual([{ bookId: 2 }]);
  });

  it("shows the book's title and author in the sidebar", async () => {
    const { user } = renderApp();
    await goTo(user, "Books");
    await user.click(await screen.findByText("A Long Book for Scrolling"));

    const sidebar = await screen.findByRole("navigation", { name: "Chapters" });
    expect(await within(sidebar).findByText("A Long Book for Scrolling")).toBeTruthy();
    expect(within(sidebar).getByText("Fixture Author")).toBeTruthy();
  });

  it("searches just this book from the sidebar", async () => {
    const { user, callsTo } = renderApp();
    await goTo(user, "Search");
    await search(user, "quincunx");
    await waitFor(() => expect(resultItems()).toHaveLength(1));
    await goTo(user, "Books");
    await user.click(
      await screen.findByText("A Long Book for Scrolling", { selector: ".book-title" }),
    );

    await user.click(await screen.findByRole("button", { name: "Search this book" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Search" })).toBeTruthy();
    await waitFor(() => expect(callsTo("search_library")).toHaveLength(2));
    expect(callsTo("search_library")[1]).toEqual({
      query: "quincunx",
      mode: "stemmed",
      bookId: 2,
    });
    const box = screen.getByPlaceholderText("Search A Long Book for Scrolling…");
    expect(document.activeElement).toBe(box);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Search in" }).value).toBe("2");

    await waitFor(() => expect(resultItems()).toHaveLength(1));
    await user.click(resultItems()[0]);
    await waitFor(() =>
      expect(document.getElementById(`block-${HIT.content_block_id}`)).not.toBeNull(),
    );
    expect(screen.getByRole("button", { name: "← Search results" })).toBeTruthy();
  });

  it("centres and briefly flashes a search hit", async () => {
    const { user, callsTo } = renderApp({ fakeTimers: true });
    await goTo(user, "Search");
    await search(user, "quincunx");
    await waitFor(() => expect(resultItems()).toHaveLength(1));
    await user.click(resultItems()[0]);

    const target = await waitFor(() => {
      const el = document.getElementById(`block-${HIT.content_block_id}`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(callsTo("get_chapter_content")).toEqual([{ chapterId: HIT.chapter_id }]);
    expect(screen.getByRole("button", { name: "Part Two" }).className).toBe("active");
    expect(target.textContent).toContain("quincunx");
    expect(target.classList.contains("flash")).toBe(true);
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
    expect(scroll.mock.contexts).toContain(target);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(target.classList.contains("flash")).toBe(false);
  });

  it("switches chapters from the sidebar without flashing", async () => {
    const { user } = renderApp();
    await goTo(user, "Search");
    await search(user, "quincunx");
    await waitFor(() => expect(resultItems()).toHaveLength(1));
    await user.click(resultItems()[0]);
    await screen.findByText(/quincunx/, { selector: ".reader-paragraph" });

    await user.click(screen.getByRole("button", { name: "Part Three" }));
    await waitFor(() => expect(paragraphs()[0].textContent).toMatch(/^Part Three, paragraph 1:/));
    expect(document.querySelector(".flash")).toBeNull();
  });

  it("shows an error when a chapter can't be loaded", async () => {
    const { user } = renderApp({ fail: { get_chapter_content: "chapter is gone" } });
    await goTo(user, "Books");
    await user.click(await screen.findByText("A Long Book for Scrolling"));
    expect(await screen.findByText("Loading chapter failed: chapter is gone")).toBeTruthy();
  });
});
