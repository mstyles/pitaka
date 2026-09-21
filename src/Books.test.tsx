import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { goTo, renderApp } from "./test/renderApp";

const TEST_BOOK = "Test Book of Research";
const LONG_BOOK = "A Long Book for Scrolling";

function bookRow(title: string) {
  return screen.getByText(title).closest("li")!;
}

describe("books", () => {
  it("lists the books in the library", async () => {
    const { user } = renderApp();
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    expect(within(bookRow(TEST_BOOK)).getByText("A. Tester · 2 chapters")).toBeTruthy();
    expect(within(bookRow(LONG_BOOK)).getByText("Fixture Author · 3 chapters")).toBeTruthy();
  });

  it("says when an imported book is already in the library", async () => {
    const { user, callsTo } = renderApp();
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import EPUB…" }));
    await screen.findByText("Already in library as book #1");
    expect(callsTo("import_book")).toEqual([{ path: "/books/test.epub" }]);
  });

  it("imports a book that isn't in the library", async () => {
    const { user } = renderApp();
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(within(bookRow(TEST_BOOK)).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText(TEST_BOOK)).toBeNull());

    await user.click(screen.getByRole("button", { name: "Import EPUB…" }));
    await screen.findByText("Imported book #1");
    expect(await screen.findByText(TEST_BOOK)).toBeTruthy();
  });

  it("does nothing when the file picker is cancelled", async () => {
    const { user, callsTo } = renderApp({ openPath: null });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import EPUB…" }));
    await waitFor(() => expect(callsTo("plugin:dialog|open")).toHaveLength(1));
    expect(callsTo("import_book")).toEqual([]);
  });

  it("removes a book", async () => {
    const { user, callsTo } = renderApp();
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(within(bookRow(TEST_BOOK)).getByRole("button", { name: "Remove" }));
    await screen.findByText(`Removed "${TEST_BOOK}"`);
    expect(callsTo("delete_book")).toEqual([{ bookId: 1 }]);
    await waitFor(() => expect(screen.queryByText(TEST_BOOK)).toBeNull());
    expect(screen.getByText(LONG_BOOK)).toBeTruthy();
  });

  it("keeps the book when removal isn't confirmed", async () => {
    const { user, callsTo } = renderApp({ confirm: false });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(within(bookRow(TEST_BOOK)).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(callsTo("plugin:dialog|message")).toHaveLength(1));
    expect(callsTo("delete_book")).toEqual([]);
    expect(screen.getByText(TEST_BOOK)).toBeTruthy();
  });

  it("opens a book and comes back to Books", async () => {
    const { user } = renderApp();
    await goTo(user, "Books");
    await user.click(await screen.findByText(LONG_BOOK));
    await user.click(await screen.findByRole("button", { name: "← Books" }));
    expect(document.querySelector(".reader")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Books" })).toBeTruthy();
    expect(await screen.findByText(LONG_BOOK)).toBeTruthy();
  });

  it("shows an error when the library can't be loaded", async () => {
    const { user } = renderApp({ fail: { list_books: "database is locked" } });
    await goTo(user, "Books");
    expect(await screen.findByText("Loading library failed: database is locked")).toBeTruthy();
  });
});
