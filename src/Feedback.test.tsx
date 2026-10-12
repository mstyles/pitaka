import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fixtures, indexingEvents } from "./test/mockBackend";
import { goTo, renderApp } from "./test/renderApp";

const TEST_BOOK = "Test Book of Research";
const LONG_BOOK = "A Long Book for Scrolling";
const FOLDER = fixtures.bookmark_folders[0];

/** A promise for `gates` that stays pending until `release` is called. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

function notifications() {
  return screen.queryByRole("region", { name: "Notifications" });
}

describe("status lines", () => {
  it("show busy, then done", async () => {
    const backup = gate();
    const { user } = renderApp({ gates: { backup_library: backup.promise } });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Back up" }));

    const line = (await screen.findByText("Backing up…")).closest(".status-line")!;
    expect(line.getAttribute("role")).toBe("status");
    expect(line.querySelector(".spinner")).not.toBeNull();

    await act(async () => backup.release());
    await waitFor(() => expect(line.textContent).toMatch(/^Backed up 2 books, /));
    expect(line.querySelector(".spinner")).toBeNull();
    expect(line.querySelector("svg.icon")).not.toBeNull();
  });

  it("make a failure an alert", async () => {
    const { user } = renderApp({ fail: { delete_book: "database is locked" } });
    await goTo(user, "Books");
    const row = (await screen.findByText(TEST_BOOK)).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Remove" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Remove failed: database is locked");
    expect(alert.classList).toContain("status-error");
  });

  it("render the live region before any message", async () => {
    const { user } = renderApp();
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    const empty = screen.getAllByRole("status").filter((el) => el.textContent === "");
    expect(empty.length).toBeGreaterThan(0);
    expect(empty[0].classList).toContain("status-line");
  });
});

describe("loading", () => {
  it("shows a skeleton only after 200ms", async () => {
    const books = gate();
    const { user } = renderApp({ fakeTimers: true, gates: { list_books: books.promise } });
    await goTo(user, "Books");
    act(() => vi.advanceTimersByTime(100));
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();

    act(() => vi.advanceTimersByTime(150));
    const skeleton = screen.getByLabelText("Loading books");
    expect(skeleton.querySelectorAll(".skeleton-row")).toHaveLength(3);

    await act(async () => books.release());
    await screen.findByText(TEST_BOOK);
    expect(screen.queryByLabelText("Loading books")).toBeNull();
  });

  it("doesn't say a folder is empty before its passages load", async () => {
    const passages = gate();
    const { user } = renderApp({ gates: { list_folder_bookmarks: passages.promise } });
    await goTo(user, "Bookmarks & notes");
    await user.click(await screen.findByText(FOLDER.name));
    await screen.findByRole("heading", { name: FOLDER.name });
    expect(screen.queryByText("This folder is empty")).toBeNull();

    await act(async () => passages.release());
    await waitFor(() => expect(document.querySelectorAll(".folder-passage")).toHaveLength(2));
    expect(screen.queryByText("This folder is empty")).toBeNull();
  });

  it("shows skeleton paragraphs while a chapter loads", async () => {
    const chapter = gate();
    const { user } = renderApp({
      fakeTimers: true,
      gates: { get_chapter_content: chapter.promise },
    });
    await goTo(user, "Books");
    await user.click(await screen.findByText(LONG_BOOK));
    await screen.findByRole("button", { name: "Part Two" });
    act(() => vi.advanceTimersByTime(250));

    const text = document.querySelector(".reader-text")!;
    expect(text.getAttribute("aria-busy")).toBe("true");
    expect(text.querySelectorAll(".skeleton-paragraph")).toHaveLength(4);

    await act(async () => chapter.release());
    await waitFor(() => expect(text.querySelector(".reader-paragraph")).not.toBeNull());
    expect(text.querySelector(".skeleton-paragraph")).toBeNull();
    expect(text.getAttribute("aria-busy")).toBeNull();
  });
});

describe("toasts", () => {
  const scan = { paths: ["/books/folder/a.epub", "/books/folder/b.epub"], unreadable: [] };

  async function importFolderThenLeave(opts: Parameters<typeof renderApp>[0] = {}) {
    const imports = gate();
    const rendered = renderApp({ fakeTimers: true, scan, importGate: imports.promise, ...opts });
    const { user } = rendered;
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import folder" }));
    await screen.findByText("Importing 1 of 2…");
    await goTo(user, "Search");
    await act(async () => imports.release());
    return rendered;
  }

  it("report a folder import that finishes on another screen", async () => {
    const { user } = await importFolderThenLeave();
    const region = await screen.findByRole("region", { name: "Notifications" });
    expect(within(region).getByText("Nothing new: 2 already in library")).toBeTruthy();

    await user.click(within(region).getByRole("button", { name: "Show" }));
    await screen.findByRole("heading", { level: 1, name: "Books" });
    expect(notifications()).toBeNull();
    // The full summary is still on Books.
    expect(screen.getByText("Nothing new: 2 already in library")).toBeTruthy();
  });

  it("go by themselves after 6 s", async () => {
    await importFolderThenLeave();
    await screen.findByRole("region", { name: "Notifications" });
    act(() => vi.advanceTimersByTime(6100));
    expect(notifications()).toBeNull();
  });

  it("aren't raised for a scan that fails while Books is showing", async () => {
    const { user } = renderApp({ fail: { find_books: "permission denied" } });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import folder" }));
    await screen.findByText("Import failed: permission denied");
    expect(notifications()).toBeNull();
  });

  it("show a scan failure on another screen as an alert that stays", async () => {
    const scanning = gate();
    const { user } = renderApp({
      fakeTimers: true,
      fail: { find_books: "permission denied" },
      gates: { find_books: scanning.promise },
    });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import folder" }));
    await screen.findByText(/^Looking for books in/);
    await goTo(user, "Home");
    await act(async () => scanning.release());

    const region = await screen.findByRole("region", { name: "Notifications" });
    expect(within(region).getByRole("alert").textContent).toBe("Import failed: permission denied");
    act(() => vi.advanceTimersByTime(10_000));
    expect(notifications()).not.toBeNull();
    await user.click(within(region).getByRole("button", { name: "Dismiss" }));
    expect(notifications()).toBeNull();
  });

  it("aren't shown while Books is showing", async () => {
    const imports = gate();
    const { user } = renderApp({ scan, importGate: imports.promise });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import folder" }));
    await screen.findByText("Importing 1 of 2…");
    await act(async () => imports.release());
    await screen.findByText("Nothing new: 2 already in library");
    expect(notifications()).toBeNull();
  });

  it("report indexing that fails or finishes on another screen", async () => {
    const { user } = renderApp({ semantic: { available: true } });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await act(() => indexingEvents.progress({ book_id: 1, done: 1, total: 2, queued: 1 }));
    await goTo(user, "Search");

    await act(() => indexingEvents.failed({ book_id: 1, error: "model missing" }));
    const region = await screen.findByRole("region", { name: "Notifications" });
    expect(
      await within(region).findByText(`Indexing "${TEST_BOOK}" failed: model missing`),
    ).toBeTruthy();

    await act(() => indexingEvents.progress({ book_id: 2, done: 3, total: 3, queued: 0 }));
    expect(await within(region).findByText("Chapter search is ready for 1 book")).toBeTruthy();
  });

  it("report a failure followed at once by the next book finishing", async () => {
    const { user } = renderApp({ semantic: { available: true } });
    await goTo(user, "Search");
    await act(async () => {
      await indexingEvents.failed({ book_id: 1, error: "model missing" });
      await indexingEvents.progress({ book_id: 2, done: 3, total: 3, queued: 0 });
    });
    const region = await screen.findByRole("region", { name: "Notifications" });
    expect(
      await within(region).findByText(`Indexing "${TEST_BOOK}" failed: model missing`),
    ).toBeTruthy();
    expect(within(region).getByText("Chapter search is ready for 1 book")).toBeTruthy();
  });
});
