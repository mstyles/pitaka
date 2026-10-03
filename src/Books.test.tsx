import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fixtures, indexingEvents } from "./test/mockBackend";
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

describe("importing a folder", () => {
  const scan = {
    paths: ["/books/folder/a/test.epub", "/books/folder/b/copy.epub", "/books/folder/bad.epub"],
    unreadable: [],
  };
  const importErrors = { "/books/folder/bad.epub": "invalid Zip archive" };
  // Without the test book, so the first copy of it is new.
  const books = fixtures.books.filter((b) => b.title !== TEST_BOOK);
  const importButtons = () =>
    ["Import EPUB…", "Import folder…"].map(
      (name) => screen.getByRole("button", { name }) as HTMLButtonElement,
    );

  /** An `importGate` that stays pending until `release` is called. */
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    return { promise, release };
  }

  it("imports every book found, then sums up", async () => {
    const { user, callsTo } = renderApp({ scan, importErrors, books });
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);
    await user.click(screen.getByRole("button", { name: "Import folder…" }));

    await screen.findByText("Imported 1 book, 1 already in library, 1 failed");
    expect(callsTo("find_epubs")).toEqual([{ dir: "/books/folder" }]);
    expect(callsTo("import_book")).toEqual(scan.paths.map((path) => ({ path })));
    const failures = document.querySelector(".import-failures")!;
    expect(failures.textContent).toBe("bad.epub: invalid Zip archive");
    expect(await screen.findByText(TEST_BOOK)).toBeTruthy();
  });

  it("does nothing when the folder picker is cancelled", async () => {
    const { user, callsTo } = renderApp({ openDir: null });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import folder…" }));
    await waitFor(() => expect(callsTo("plugin:dialog|open")).toHaveLength(1));
    expect(callsTo("find_epubs")).toEqual([]);
    expect(callsTo("import_book")).toEqual([]);
  });

  it("says when the folder has no books", async () => {
    const { user } = renderApp({ scan: { paths: [], unreadable: [] } });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import folder…" }));
    expect(await screen.findByText("No EPUB files in /books/folder")).toBeTruthy();
  });

  it("stops after the book in flight", async () => {
    const { promise, release } = gate();
    const { user, callsTo } = renderApp({ scan, importErrors, books, importGate: promise });
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);
    await user.click(screen.getByRole("button", { name: "Import folder…" }));
    await screen.findByText("Importing 1 of 3…");
    expect(importButtons().every((b) => b.disabled)).toBe(true);

    await user.click(screen.getByRole("button", { name: "Stop" }));
    await act(async () => release());
    await screen.findByText("Stopped after 1 of 3: Imported 1 book");
    expect(callsTo("import_book")).toHaveLength(1);
    expect(importButtons().every((b) => !b.disabled)).toBe(true);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("keeps going while you're on another screen", async () => {
    const { promise, release } = gate();
    const { user, callsTo } = renderApp({ scan, importErrors, books, importGate: promise });
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);
    await user.click(screen.getByRole("button", { name: "Import folder…" }));
    await screen.findByText("Importing 1 of 3…");

    await goTo(user, "Bookmarks & notes");
    await act(async () => release());
    await waitFor(() => expect(callsTo("import_book")).toHaveLength(3));
    await goTo(user, "Books");
    expect(await screen.findByText("Imported 1 book, 1 already in library, 1 failed")).toBeTruthy();
    expect(document.querySelector(".import-failures")!.textContent).toBe(
      "bad.epub: invalid Zip archive",
    );
    expect(await screen.findByText(TEST_BOOK)).toBeTruthy();
  });

  it("reports a folder that can't be read", async () => {
    const { user } = renderApp({ fail: { find_epubs: "couldn't read /books/folder: denied" } });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import folder…" }));
    expect(
      await screen.findByText("Import failed: couldn't read /books/folder: denied"),
    ).toBeTruthy();
  });
});

describe("indexing for chapter search", () => {
  it("shows a book's progress, then that it's done", async () => {
    const { user } = renderApp();
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);

    await act(() => indexingEvents.progress({ book_id: 2, done: 1, total: 3 }));
    expect(
      screen.getByText(`Indexing ${LONG_BOOK} for chapter search… 1/3 chapters`),
    ).toBeTruthy();
    await act(() => indexingEvents.progress({ book_id: 2, done: 3, total: 3 }));
    expect(screen.getByText(`Indexed ${LONG_BOOK} for chapter search`)).toBeTruthy();
  });

  it("replaces the progress with the error when indexing fails", async () => {
    const { user } = renderApp();
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);

    await act(() => indexingEvents.progress({ book_id: 2, done: 1, total: 3 }));
    await act(() =>
      indexingEvents.failed({ book_id: 2, error: "couldn't load the search model: offline" }),
    );
    expect(
      screen.getByText(
        `Indexing ${LONG_BOOK} for chapter search failed: couldn't load the search model: offline`,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/1\/3 chapters/)).toBeNull();
  });

  it("still shows a run's progress after leaving and coming back", async () => {
    const { user } = renderApp();
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);
    await act(() => indexingEvents.progress({ book_id: 2, done: 1, total: 3 }));

    await goTo(user, "Search");
    await act(() => indexingEvents.progress({ book_id: 2, done: 2, total: 3 }));
    await goTo(user, "Books");
    expect(
      await screen.findByText(`Indexing ${LONG_BOOK} for chapter search… 2/3 chapters`),
    ).toBeTruthy();
  });

  it("shows a run that finished while away once, then drops it", async () => {
    const { user } = renderApp();
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);
    await act(() => indexingEvents.progress({ book_id: 2, done: 1, total: 3 }));

    await goTo(user, "Search");
    await act(() => indexingEvents.progress({ book_id: 2, done: 3, total: 3 }));
    await goTo(user, "Books");
    expect(await screen.findByText(`Indexed ${LONG_BOOK} for chapter search`)).toBeTruthy();

    await goTo(user, "Search");
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);
    expect(screen.queryByText(/for chapter search/)).toBeNull();
  });
});
