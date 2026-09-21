import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
    expect(resultItems()[0].textContent).toContain(`${TEST_BOOK} · chapter 1`);
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
});
