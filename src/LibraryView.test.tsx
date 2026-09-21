import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, resultItems, search } from "./test/renderApp";

const TEST_BOOK = "Test Book of Research";
const LONG_BOOK = "A Long Book for Scrolling";

function bookRow(title: string) {
  return screen.getByText(title).closest("li")!;
}

describe("library", () => {
  it("lists the books in the library", async () => {
    renderApp();
    await screen.findByText(TEST_BOOK);
    expect(within(bookRow(TEST_BOOK)).getByText("A. Tester · 2 chapters")).toBeTruthy();
    expect(within(bookRow(LONG_BOOK)).getByText("Fixture Author · 3 chapters")).toBeTruthy();
  });

  it("says when an imported book is already in the library", async () => {
    const { user, callsTo } = renderApp();
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import EPUB…" }));
    await screen.findByText("Already in library as book #1");
    expect(callsTo("import_book")).toEqual([{ path: "/books/test.epub" }]);
  });

  it("imports a book that isn't in the library", async () => {
    const { user } = renderApp();
    await screen.findByText(TEST_BOOK);
    await user.click(within(bookRow(TEST_BOOK)).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText(TEST_BOOK)).toBeNull());

    await user.click(screen.getByRole("button", { name: "Import EPUB…" }));
    await screen.findByText("Imported book #1");
    expect(await screen.findByText(TEST_BOOK)).toBeTruthy();
  });

  it("does nothing when the file picker is cancelled", async () => {
    const { user, callsTo } = renderApp({ openPath: null });
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import EPUB…" }));
    await waitFor(() => expect(callsTo("plugin:dialog|open")).toHaveLength(1));
    expect(callsTo("import_book")).toEqual([]);
  });

  it("searches and highlights the matched words", async () => {
    const { user, callsTo } = renderApp();
    await search(user, "neural networks");
    await waitFor(() => expect(resultItems()).toHaveLength(2));
    expect(callsTo("search_library")).toEqual([{ query: "neural networks", mode: "stemmed" }]);
    const marks = resultItems()[0].querySelectorAll("mark");
    expect(Array.from(marks, (m) => m.textContent)).toEqual(["Neural", "networks"]);
    expect(resultItems()[0].textContent).toContain(`${TEST_BOOK} — chapter 1`);
  });

  it("re-runs the search in exact mode when Exact words is ticked", async () => {
    const { user, callsTo } = renderApp();
    await search(user, "neural networks");
    await waitFor(() => expect(resultItems()).toHaveLength(2));
    await user.click(screen.getByLabelText("Exact words"));
    await waitFor(() => expect(callsTo("search_library")).toHaveLength(2));
    expect(callsTo("search_library")[1]).toEqual({ query: "neural networks", mode: "exact" });
  });

  it("removes a book and drops its search results", async () => {
    const { user, callsTo } = renderApp();
    await screen.findByText(TEST_BOOK);
    await search(user, "neural networks");
    await waitFor(() => expect(resultItems()).toHaveLength(2));

    await user.click(within(bookRow(TEST_BOOK)).getByRole("button", { name: "Remove" }));
    await screen.findByText(`Removed "${TEST_BOOK}"`);
    expect(callsTo("delete_book")).toEqual([{ bookId: 1 }]);
    expect(screen.queryByText(TEST_BOOK)).toBeNull();
    expect(screen.getByText(LONG_BOOK)).toBeTruthy();
    expect(resultItems()).toHaveLength(0);
  });

  it("keeps the book when removal isn't confirmed", async () => {
    const { user, callsTo } = renderApp({ confirm: false });
    await screen.findByText(TEST_BOOK);
    await user.click(within(bookRow(TEST_BOOK)).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(callsTo("plugin:dialog|message")).toHaveLength(1));
    expect(callsTo("delete_book")).toEqual([]);
    expect(screen.getByText(TEST_BOOK)).toBeTruthy();
  });

  it("shows an error when the library can't be loaded", async () => {
    renderApp({ fail: { list_books: "database is locked" } });
    expect(await screen.findByText("Loading library failed: database is locked")).toBeTruthy();
  });

  it("shows an error when a search fails", async () => {
    const { user } = renderApp({ fail: { search_library: "fts5: syntax error" } });
    await search(user, "neural");
    expect(await screen.findByText("Search failed: fts5: syntax error")).toBeTruthy();
  });
});
