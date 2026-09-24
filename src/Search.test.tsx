import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fixtures } from "./test/mockBackend";
import { goTo, renderApp, resultItems, search } from "./test/renderApp";

const TEST_BOOK = "Test Book of Research";

function searchBox() {
  return screen.getByPlaceholderText<HTMLInputElement>("Search your library…");
}

describe("search", () => {
  it("searches and highlights the matched words", async () => {
    const { user, callsTo } = renderApp();
    await goTo(user, "Search");
    await search(user, "neural networks");
    await waitFor(() => expect(resultItems()).toHaveLength(2));
    expect(callsTo("search_library")).toEqual([{ query: "neural networks", mode: "stemmed" }]);
    const marks = resultItems()[0].querySelectorAll("mark");
    expect(Array.from(marks, (m) => m.textContent)).toEqual(["Neural", "networks"]);
    expect(resultItems()[0].textContent).toContain(`${TEST_BOOK} · Chapter Two: Deeper Waters`);
    expect(screen.getByText("2 results")).toBeTruthy();
  });

  it("says when a search finds nothing", async () => {
    const { user } = renderApp();
    await goTo(user, "Search");
    expect(screen.queryByText("No results")).toBeNull();
    await search(user, "zzzz");
    expect(await screen.findByText("No results")).toBeTruthy();
  });

  it("re-runs the search in exact mode when Exact words is ticked", async () => {
    const { user, callsTo } = renderApp();
    await goTo(user, "Search");
    await search(user, "neural networks");
    await waitFor(() => expect(resultItems()).toHaveLength(2));
    await user.click(screen.getByLabelText("Exact words"));
    await waitFor(() => expect(callsTo("search_library")).toHaveLength(2));
    expect(callsTo("search_library")[1]).toEqual({ query: "neural networks", mode: "exact" });
  });

  it("focuses the search box when opened", async () => {
    const { user } = renderApp();
    await goTo(user, "Search");
    expect(document.activeElement).toBe(searchBox());
  });

  it("keeps the search when leaving and coming back", async () => {
    const { user, callsTo } = renderApp();
    await goTo(user, "Search");
    await search(user, "neural networks");
    await waitFor(() => expect(resultItems()).toHaveLength(2));
    await goTo(user, "Home");
    await goTo(user, "Search");
    expect(searchBox().value).toBe("neural networks");
    expect(resultItems()).toHaveLength(2);
    expect(callsTo("search_library")).toHaveLength(1);
  });

  it("re-runs the search after a book is removed", async () => {
    const { user, callsTo } = renderApp();
    await goTo(user, "Search");
    await search(user, "neural networks");
    await waitFor(() => expect(resultItems()).toHaveLength(2));

    await goTo(user, "Books");
    const row = (await screen.findByText(TEST_BOOK, { selector: ".book-title" })).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Remove" }));
    await screen.findByText(`Removed "${TEST_BOOK}"`);

    await goTo(user, "Search");
    await waitFor(() => expect(callsTo("search_library")).toHaveLength(2));
    expect(callsTo("search_library")[1]).toEqual({ query: "neural networks", mode: "stemmed" });
    await waitFor(() => expect(resultItems()).toHaveLength(0));
  });

  it("goes back from a hit to the results", async () => {
    const { user, callsTo } = renderApp();
    await goTo(user, "Search");
    await search(user, "quincunx");
    await waitFor(() => expect(resultItems()).toHaveLength(1));
    await user.click(resultItems()[0]);
    await user.click(await screen.findByRole("button", { name: "← Search results" }));

    expect(document.querySelector(".reader")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Search" })).toBeTruthy();
    expect(searchBox().value).toBe("quincunx");
    expect(resultItems()).toHaveLength(1);
    expect(callsTo("search_library")).toHaveLength(1);
  });

  it("shows an error when a search fails", async () => {
    const { user } = renderApp({ fail: { search_library: "fts5: syntax error" } });
    await goTo(user, "Search");
    await search(user, "neural");
    expect(await screen.findByText("Search failed: fts5: syntax error")).toBeTruthy();
  });

  it("shows markup in a book's text as text, not HTML", async () => {
    const { user } = renderApp({
      search: (books) => [
        {
          book_id: books[0].id,
          book_title: TEST_BOOK,
          chapter_id: 1,
          chapter_idx: 0,
          chapter_title: null,
          block_idx: 0,
          content_block_id: 1,
          snippet: 'if a < b then <img src=x onerror="alert(1)"> [neural] nets',
          rank: -1,
        },
      ],
    });
    await goTo(user, "Search");
    await search(user, "neural");
    await waitFor(() => expect(resultItems()).toHaveLength(1));
    const item = resultItems()[0];
    expect(item.querySelector("img")).toBeNull();
    expect(item.querySelector(".result-snippet")!.textContent).toBe(
      'if a < b then <img src=x onerror="alert(1)"> neural nets',
    );
    expect(Array.from(item.querySelectorAll("mark"), (m) => m.textContent)).toEqual(["neural"]);
  });
});

describe("chapter search", () => {
  const CHAPTERS = { available: true, indexed_books: 2, total_books: 2 };
  const QUERY = "trees planted in a pattern";
  const [BEST] = fixtures.chapter_matches![QUERY];

  function scopeButton(name: "Passages" | "Chapters") {
    return screen.getByRole("button", { name });
  }

  async function searchChapters(user: Parameters<typeof search>[0], query: string) {
    await user.click(await screen.findByRole("button", { name: "Chapters" }));
    await search(user, query);
  }

  it("isn't offered when the build has no semantic search", async () => {
    const { user, callsTo } = renderApp();
    await goTo(user, "Search");
    await waitFor(() => expect(callsTo("semantic_status")).toHaveLength(1));
    expect(screen.queryByRole("group", { name: "Search for" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Chapters" })).toBeNull();
    expect(screen.getByLabelText("Exact words")).toBeTruthy();
  });

  it("finds chapters by meaning, with the preview as plain text", async () => {
    const { user, callsTo } = renderApp({ semantic: CHAPTERS });
    await goTo(user, "Search");
    await searchChapters(user, QUERY);
    await waitFor(() => expect(resultItems()).toHaveLength(2));

    expect(callsTo("search_chapters")).toEqual([{ query: QUERY }]);
    expect(callsTo("search_library")).toEqual([]);
    expect(scopeButton("Chapters").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByLabelText("Exact words")).toBeNull();
    expect(screen.getByText("2 chapters")).toBeTruthy();
    const [first, second] = resultItems();
    expect(first.querySelector(".result-meta")!.textContent).toBe(
      "A Long Book for Scrolling · Part Two",
    );
    expect(first.querySelector(".result-snippet")!.textContent).toBe(BEST.preview);
    expect(first.querySelector("mark")).toBeNull();
    expect(second.querySelector(".result-meta")!.textContent).toContain("Part One");
  });

  it("re-runs the query when the scope changes", async () => {
    const { user, callsTo } = renderApp({ semantic: CHAPTERS });
    await goTo(user, "Search");
    await search(user, "quincunx");
    await waitFor(() => expect(resultItems()).toHaveLength(1));

    await user.click(scopeButton("Chapters"));
    await waitFor(() => expect(callsTo("search_chapters")).toEqual([{ query: "quincunx" }]));
    expect(await screen.findByText("No results")).toBeTruthy();

    await user.click(scopeButton("Passages"));
    await waitFor(() => expect(resultItems()).toHaveLength(1));
    expect(callsTo("search_library")).toHaveLength(2);
    expect(screen.getByLabelText("Exact words")).toBeTruthy();
  });

  it("opens a chapter at its best match and comes back to the results", async () => {
    const { user, callsTo } = renderApp({ semantic: CHAPTERS });
    await goTo(user, "Search");
    await searchChapters(user, QUERY);
    await waitFor(() => expect(resultItems()).toHaveLength(2));
    await user.click(resultItems()[0]);

    const target = await waitFor(() => {
      const el = document.getElementById(`block-${BEST.content_block_id}`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(callsTo("get_chapter_content")).toEqual([{ chapterId: BEST.chapter_id }]);
    expect(screen.getByRole("button", { name: "Part Two" }).className).toBe("active");
    expect(target.classList.contains("flash")).toBe(true);
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(target);

    await user.click(screen.getByRole("button", { name: "← Search results" }));
    expect(searchBox().value).toBe(QUERY);
    expect(scopeButton("Chapters").getAttribute("aria-pressed")).toBe("true");
    expect(resultItems()).toHaveLength(2);
    expect(callsTo("search_chapters")).toHaveLength(1);
  });

  it("says how many books are indexed only when some aren't", async () => {
    const line = /books indexed for chapter search/;
    const partly = renderApp({ semantic: { available: true } });
    await goTo(partly.user, "Search");
    await searchChapters(partly.user, QUERY);
    expect(
      await screen.findByText(
        "1 of 2 books indexed for chapter search. Remove and re-import a book to include it.",
      ),
    ).toBeTruthy();
    // Passage search covers every book, so the line is only for chapters.
    await partly.user.click(scopeButton("Passages"));
    expect(screen.queryByText(line)).toBeNull();
    cleanup();

    const fully = renderApp({ semantic: CHAPTERS });
    await goTo(fully.user, "Search");
    await searchChapters(fully.user, QUERY);
    await waitFor(() => expect(resultItems()).toHaveLength(2));
    expect(screen.queryByText(line)).toBeNull();
  });

  it("says when no chapter is close enough", async () => {
    const { user } = renderApp({ semantic: CHAPTERS });
    await goTo(user, "Search");
    await searchChapters(user, "quarterly earnings guidance");
    expect(await screen.findByText("No results")).toBeTruthy();
    expect(resultItems()).toHaveLength(0);
  });

  it("shows an error when a chapter search fails", async () => {
    const { user } = renderApp({
      semantic: CHAPTERS,
      fail: { search_chapters: "couldn't load the search model: offline" },
    });
    await goTo(user, "Search");
    await searchChapters(user, QUERY);
    expect(
      await screen.findByText("Search failed: couldn't load the search model: offline"),
    ).toBeTruthy();
  });
});
