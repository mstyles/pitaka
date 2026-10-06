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
    await user.click(screen.getByRole("button", { name: "Import book…" }));
    await screen.findByText("Already in library as book #1");
    expect(callsTo("import_book")).toEqual([{ path: "/books/test.epub" }]);
  });

  it("imports a book that isn't in the library", async () => {
    const { user } = renderApp();
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(within(bookRow(TEST_BOOK)).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText(TEST_BOOK)).toBeNull());

    await user.click(screen.getByRole("button", { name: "Import book…" }));
    await screen.findByText("Imported book #1");
    expect(await screen.findByText(TEST_BOOK)).toBeTruthy();
  });

  it("lets the file picker choose an EPUB or a PDF", async () => {
    const { user, callsTo } = renderApp({ openPath: null });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import book…" }));
    await waitFor(() => expect(callsTo("plugin:dialog|open")).toHaveLength(1));
    const { options } = callsTo("plugin:dialog|open")[0] as {
      options: { filters: { extensions: string[] }[] };
    };
    expect(options.filters.map((f) => f.extensions)).toEqual([["epub", "pdf"]]);
  });

  it("does nothing when the file picker is cancelled", async () => {
    const { user, callsTo } = renderApp({ openPath: null });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import book…" }));
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
    ["Import book…", "Import folder…"].map(
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
    expect(callsTo("find_books")).toEqual([{ dir: "/books/folder" }]);
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
    expect(callsTo("find_books")).toEqual([]);
    expect(callsTo("import_book")).toEqual([]);
  });

  it("says when the folder has no books", async () => {
    const { user } = renderApp({ scan: { paths: [], unreadable: [] } });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import folder…" }));
    expect(await screen.findByText("No EPUB or PDF files in /books/folder")).toBeTruthy();
  });

  it("stops after the book in flight", async () => {
    const { promise, release } = gate();
    const { user, callsTo } = renderApp({ scan, importErrors, books, importGate: promise });
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);
    await user.click(screen.getByRole("button", { name: "Import folder…" }));
    await screen.findByText("Importing 1 of 3…");
    expect(importButtons().every((b) => b.disabled)).toBe(true);

    await user.click(screen.getByRole("button", { name: "Stop import" }));
    await act(async () => release());
    await screen.findByText("Stopped after 1 of 3: Imported 1 book");
    expect(callsTo("import_book")).toHaveLength(1);
    expect(importButtons().every((b) => !b.disabled)).toBe(true);
    expect(screen.queryByRole("button", { name: "Stop import" })).toBeNull();
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
    const { user } = renderApp({ fail: { find_books: "couldn't read /books/folder: denied" } });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import folder…" }));
    expect(
      await screen.findByText("Import failed: couldn't read /books/folder: denied"),
    ).toBeTruthy();
  });
});

/** A build with chapter search, where indexing shows on the Books screen. */
const INDEXING = { semantic: { available: true } };
const PAUSED_NOTE = "New imports won't be indexed until you click Index or Index all books.";

describe("indexing for chapter search", () => {
  it("shows a book's progress, then that it's done", async () => {
    const { user } = renderApp(INDEXING);
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);

    await act(() => indexingEvents.progress({ book_id: 2, done: 1, total: 3, queued: 0 }));
    expect(
      screen.getByText(`Indexing ${LONG_BOOK} for chapter search… 1/3 chapters`),
    ).toBeTruthy();
    await act(() => indexingEvents.progress({ book_id: 2, done: 3, total: 3, queued: 0 }));
    expect(screen.getByText(`Indexed ${LONG_BOOK} for chapter search`)).toBeTruthy();
  });

  it("replaces the progress with the error when indexing fails", async () => {
    const { user } = renderApp(INDEXING);
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);

    await act(() => indexingEvents.progress({ book_id: 2, done: 1, total: 3, queued: 0 }));
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
    const { user } = renderApp(INDEXING);
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);
    await act(() => indexingEvents.progress({ book_id: 2, done: 1, total: 3, queued: 0 }));

    await goTo(user, "Search");
    await act(() => indexingEvents.progress({ book_id: 2, done: 2, total: 3, queued: 0 }));
    await goTo(user, "Books");
    expect(
      await screen.findByText(`Indexing ${LONG_BOOK} for chapter search… 2/3 chapters`),
    ).toBeTruthy();
  });

  it("shows a run that finished while away once, then drops it", async () => {
    const { user } = renderApp(INDEXING);
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);
    await act(() => indexingEvents.progress({ book_id: 2, done: 1, total: 3, queued: 0 }));

    await goTo(user, "Search");
    await act(() => indexingEvents.progress({ book_id: 2, done: 3, total: 3, queued: 0 }));
    await goTo(user, "Books");
    expect(await screen.findByText(`Indexed ${LONG_BOOK} for chapter search`)).toBeTruthy();

    await goTo(user, "Search");
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);
    expect(screen.queryByText(/for chapter search/)).toBeNull();
  });

  it("offers to index a book that isn't in chapter search", async () => {
    const { user, callsTo } = renderApp(INDEXING);
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    const row = bookRow(TEST_BOOK);
    expect(within(row).getByText("A. Tester · 2 chapters · not in chapter search")).toBeTruthy();
    // The long book is indexed, so it has no button.
    expect(within(bookRow(LONG_BOOK)).queryByRole("button", { name: "Index" })).toBeNull();

    await user.click(within(row).getByRole("button", { name: "Index" }));
    expect(callsTo("queue_index")).toEqual([{ bookId: 1 }]);
    const queued = await within(row).findByRole("button", { name: "Queued" });
    expect((queued as HTMLButtonElement).disabled).toBe(true);
    // Clicking the button doesn't open the book.
    expect(document.querySelector(".reader")).toBeNull();

    await act(() => indexingEvents.progress({ book_id: 1, done: 0, total: 2, queued: 0 }));
    expect(within(row).getByRole("button", { name: "Indexing…" })).toBeTruthy();
  });

  it("says when a book is partly indexed", async () => {
    const { user } = renderApp({ ...INDEXING, indexStates: { 1: "partial" } });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    expect(within(bookRow(TEST_BOOK)).getByText(/· partly indexed$/)).toBeTruthy();
    expect(within(bookRow(TEST_BOOK)).getByRole("button", { name: "Index" })).toBeTruthy();
  });

  it("indexes all books, and hides the button once every book is indexed", async () => {
    const { user, callsTo } = renderApp(INDEXING);
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Index all books" }));
    expect(callsTo("queue_index_all")).toEqual([{}]);
    await within(bookRow(TEST_BOOK)).findByRole("button", { name: "Queued" });
    expect(screen.queryByRole("button", { name: "Index all books" })).toBeNull();
  });

  it("has no Index all books when every book is indexed", async () => {
    const { user } = renderApp({ ...INDEXING, indexStates: { 1: "indexed" } });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    expect(screen.queryByRole("button", { name: "Index all books" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Index" })).toBeNull();
    expect(screen.queryByText(/not in chapter search/)).toBeNull();
  });

  it("shows how many books are queued, and stops them", async () => {
    const { user, callsTo } = renderApp(INDEXING);
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);
    await act(() => indexingEvents.progress({ book_id: 2, done: 1, total: 3, queued: 2 }));
    expect(
      screen.getByText(
        `Indexing ${LONG_BOOK} for chapter search… 1/3 chapters · 2 more books queued`,
      ),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Stop indexing" }));
    expect(callsTo("stop_indexing")).toEqual([{}]);
    expect(screen.queryByRole("button", { name: "Stop indexing" })).toBeNull();

    await act(() => indexingEvents.stopped({ book_id: 2, done: 2, total: 3 }));
    expect(
      screen.getByText(`Stopped indexing ${LONG_BOOK} at 2/3 chapters. ${PAUSED_NOTE}`),
    ).toBeTruthy();
  });

  it("says indexing is paused after a stopped run is dismissed, until Index all books", async () => {
    const { user } = renderApp(INDEXING);
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);
    await act(() => indexingEvents.progress({ book_id: 2, done: 1, total: 3, queued: 0 }));
    await user.click(screen.getByRole("button", { name: "Stop indexing" }));
    await act(() => indexingEvents.stopped({ book_id: 2, done: 1, total: 3 }));

    await goTo(user, "Search");
    await goTo(user, "Books");
    expect(await screen.findByText(`Stopped indexing. ${PAUSED_NOTE}`)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Index all books" }));
    await waitFor(() => expect(screen.queryByText(/Stopped indexing/)).toBeNull());
  });

  it("stops a folder import and indexing separately", async () => {
    let release!: () => void;
    const importGate = new Promise<void>((resolve) => (release = resolve));
    const scan = { paths: ["/books/folder/a.epub", "/books/folder/b.epub"], unreadable: [] };
    const { user, callsTo } = renderApp({ ...INDEXING, scan, importGate });
    await goTo(user, "Books");
    await screen.findByText(LONG_BOOK);
    await user.click(screen.getByRole("button", { name: "Import folder…" }));
    await screen.findByText("Importing 1 of 2…");
    await act(() => indexingEvents.progress({ book_id: 2, done: 1, total: 3, queued: 0 }));

    await user.click(screen.getByRole("button", { name: "Stop indexing" }));
    expect(callsTo("stop_indexing")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Stop import" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Stop import" }));
    expect(callsTo("stop_indexing")).toHaveLength(1);
    await act(async () => release());
    await screen.findByText(/^Stopped after 1 of 2/);
    expect(callsTo("import_book")).toHaveLength(1);
  });

  it("shows nothing about indexing in a build without chapter search", async () => {
    const { user } = renderApp();
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await act(() => indexingEvents.progress({ book_id: 2, done: 1, total: 3, queued: 2 }));
    expect(screen.queryByRole("button", { name: /^Index/ })).toBeNull();
    expect(screen.queryByText(/chapter search/)).toBeNull();
  });
});
