import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { describe, expect, it } from "vitest";
import { fixtures } from "./test/mockBackend";
import { goTo, renderApp } from "./test/renderApp";

const TEST_BOOK = "Test Book of Research";
const LONG_BOOK = "A Long Book for Scrolling";
const CHAPTER_ONE = "Chapter One: Beginnings";
const CHAPTER_TWO = "Chapter Two: Deeper Waters";
const PART_ONE_BLOCKS = fixtures.chapter_content[String(fixtures.chapters["2"][0].id)].blocks;

type User = ReturnType<typeof renderApp>["user"];

function searchBox() {
  return screen.getByPlaceholderText(/^Search .*…$/);
}

function chapterButton(title: string) {
  const sidebar = screen.getByRole("navigation", { name: "Chapters" });
  return within(sidebar).getByRole("button", { name: title });
}

async function openBook(user: User, title: string) {
  await goTo(user, "Books");
  await user.click(await screen.findByText(title));
  await screen.findByRole("navigation", { name: "Chapters" });
}

async function openTestBook(user: User) {
  await openBook(user, TEST_BOOK);
  await waitFor(() => expect(chapterButton(CHAPTER_ONE).className).toBe("active"));
}

async function openLongBook(user: User) {
  await openBook(user, LONG_BOOK);
  await screen.findByText(/^Part One, paragraph 1:/);
}

function readerOpen() {
  return screen.queryByRole("navigation", { name: "Chapters" }) != null;
}

/** Selects the start of a paragraph of the long book, as a drag does. */
function selectInParagraph(n: number) {
  const p = document.getElementById(`block-${PART_ONE_BLOCKS[n - 1].id}`)!;
  const text = p.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 8);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent.mouseUp(p);
}

/** An `importGate` that stays pending until `release` is called. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

describe("keyboard shortcuts", () => {
  it("focuses the search box with Ctrl+F, again when it's already showing", async () => {
    const { user } = renderApp();
    await screen.findByText("2 books");
    await user.keyboard("{Control>}f{/Control}");
    await screen.findByRole("heading", { level: 1, name: "Search" });
    await waitFor(() => expect(document.activeElement).toBe(searchBox()));

    await user.click(screen.getByRole("heading", { level: 1, name: "Search" }));
    expect(document.activeElement).not.toBe(searchBox());
    await user.keyboard("{Control>}f{/Control}");
    await waitFor(() => expect(document.activeElement).toBe(searchBox()));
  });

  it("switches sections with Ctrl+2 and Ctrl+3", async () => {
    const { user } = renderApp();
    await user.keyboard("{Control>}2{/Control}");
    expect(await screen.findByRole("heading", { level: 1, name: "Books" })).toBeTruthy();
    await user.keyboard("{Control>}3{/Control}");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Bookmarks & notes" }),
    ).toBeTruthy();
    await user.keyboard("{Control>}1{/Control}");
    expect(await screen.findByRole("heading", { level: 1, name: "Pitaka" })).toBeTruthy();
  });

  it("imports a book with Ctrl+O from Home", async () => {
    const { user, callsTo } = renderApp();
    await screen.findByText("2 books");
    await user.keyboard("{Control>}o{/Control}");
    await screen.findByRole("heading", { level: 1, name: "Books" });
    expect(await screen.findByText("Already in library as book #1")).toBeTruthy();
    expect(callsTo("plugin:dialog|open")).toHaveLength(1);
    expect(callsTo("import_book")).toEqual([{ path: "/books/test.epub" }]);
  });

  it("imports a folder with Ctrl+Shift+O", async () => {
    const { user, callsTo } = renderApp({ scan: { paths: [], unreadable: [] } });
    await user.keyboard("{Control>}{Shift>}O{/Shift}{/Control}");
    expect(await screen.findByText("No EPUB or PDF files in /books/folder")).toBeTruthy();
    expect(callsTo("find_books")).toEqual([{ dir: "/books/folder" }]);
  });

  it("says to wait while a folder import is running", async () => {
    const { promise, release } = gate();
    const scan = { paths: ["/books/folder/a.epub"], unreadable: [] };
    const { user, callsTo } = renderApp({ scan, importGate: promise });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(screen.getByRole("button", { name: "Import folder" }));
    await screen.findByText("Importing 1 of 1…");

    await user.keyboard("{Control>}o{/Control}");
    expect(await screen.findByText("Wait for the folder import to finish")).toBeTruthy();
    expect(callsTo("plugin:dialog|open")).toHaveLength(1); // the folder picker's
    await act(async () => release());
  });
});

describe("the app menu", () => {
  it("backs up from File → Back up library…", async () => {
    const { callsTo } = renderApp();
    await screen.findByText("2 books");
    await act(() => emit("menu", "back-up"));
    await screen.findByRole("heading", { level: 1, name: "Books" });
    await waitFor(() =>
      expect(callsTo("backup_library")).toEqual([{ path: "/backups/pitaka-backup.pitaka" }]),
    );
  });

  it("won't restore while a book is queued for indexing", async () => {
    const { user, callsTo } = renderApp({ semantic: { available: true } });
    await goTo(user, "Books");
    const row = (await screen.findByText(TEST_BOOK)).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Index" }));
    await within(row).findByRole("button", { name: "Queued" });

    await act(() => emit("menu", "restore"));
    expect(await screen.findByText("Stop indexing to restore a backup")).toBeTruthy();
    expect(callsTo("plugin:dialog|open")).toEqual([]);
    expect(callsTo("read_backup_manifest")).toEqual([]);
  });

  it("opens the shortcuts from Help → Keyboard shortcuts", async () => {
    renderApp();
    await act(() => emit("menu", "shortcuts"));
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });

  it("closes the shortcuts before running another item", async () => {
    renderApp();
    await act(() => emit("menu", "shortcuts"));
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await act(() => emit("menu", "go-books"));
    await screen.findByRole("heading", { level: 1, name: "Books" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });
});

describe("keys in the reader", () => {
  it("changes chapter with the arrow keys, stopping at the ends", async () => {
    const { user } = renderApp();
    await openTestBook(user);
    await user.keyboard("{ArrowLeft}");
    expect(chapterButton(CHAPTER_ONE).className).toBe("active");
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(chapterButton(CHAPTER_TWO).className).toBe("active"));
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(chapterButton(CHAPTER_ONE).className).toBe("active"));
  });

  it("goes back with Escape", async () => {
    const { user } = renderApp();
    await openTestBook(user);
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("heading", { level: 1, name: "Books" })).toBeTruthy();
  });

  it("puts the selection toolbar away before leaving", async () => {
    const { user } = renderApp();
    await openLongBook(user);
    selectInParagraph(1);
    await screen.findByRole("toolbar", { name: "Highlight selection" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(readerOpen()).toBe(true);
    await user.keyboard("{Escape}");
    await screen.findByRole("heading", { level: 1, name: "Books" });
  });

  it("closes the highlight popover before leaving", async () => {
    const { user } = renderApp();
    await openLongBook(user);
    const mark = await waitFor(() => document.querySelector<HTMLElement>("mark.hl-yellow")!);
    await user.click(mark);
    await screen.findByRole("dialog", { name: "Highlight" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Highlight" })).toBeNull();
    expect(readerOpen()).toBe(true);
    await user.keyboard("{Escape}");
    await screen.findByRole("heading", { level: 1, name: "Books" });
  });

  it("closes the bookmark popover before leaving", async () => {
    const { user } = renderApp();
    await openLongBook(user);
    await user.click(screen.getAllByRole("button", { name: "Bookmark this passage" })[0]);
    await screen.findByRole("dialog", { name: "Bookmark folders" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Bookmark folders" })).toBeNull();
    expect(readerOpen()).toBe(true);
    await user.keyboard("{Escape}");
    await screen.findByRole("heading", { level: 1, name: "Books" });
  });

  it("doesn't change chapter for an arrow typed in the new-folder box", async () => {
    const { user } = renderApp();
    await openTestBook(user);
    await user.click(screen.getAllByRole("button", { name: "Bookmark this passage" })[0]);
    const input = await screen.findByRole("textbox", { name: "New folder name" });
    expect(document.activeElement).toBe(input);
    await user.keyboard("ab{ArrowLeft}{ArrowRight}");
    expect(chapterButton(CHAPTER_ONE).className).toBe("active");
  });

  it("leaves a note being written alone", async () => {
    const { user } = renderApp();
    await openTestBook(user);
    await user.click(screen.getAllByRole("button", { name: "Note on this passage" })[0]);
    const textarea = await screen.findByRole("textbox", { name: "Note" });
    await user.type(textarea, "half a thought");
    (document.activeElement as HTMLElement).blur();
    await user.keyboard("{Escape}{ArrowRight}");
    expect(readerOpen()).toBe(true);
    expect(chapterButton(CHAPTER_ONE).className).toBe("active");
    expect((screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe(
      "half a thought",
    );
  });

  it("searches the open book with Ctrl+F", async () => {
    const { user } = renderApp();
    await openTestBook(user);
    await user.keyboard("{Control>}f{/Control}");
    await screen.findByRole("heading", { level: 1, name: "Search" });
    const picker = screen.getByRole<HTMLSelectElement>("combobox", { name: "Search in" });
    await waitFor(() => expect(picker.value).toBe("1"));
    expect(document.activeElement).toBe(searchBox());
  });
});

describe("the shortcuts sheet", () => {
  it("opens with ?, with Close focused", async () => {
    const { user } = renderApp();
    await screen.findByText("2 books");
    await user.keyboard("?");
    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet).getByText("Ctrl+Shift+O")).toBeTruthy();
    expect(within(sheet).getByText("Previous / next chapter")).toBeTruthy();
    expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Close" }));
  });

  it("closes with Escape and leaves the screen as it was", async () => {
    const { user } = renderApp();
    await openTestBook(user);
    await user.keyboard("?");
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(readerOpen()).toBe(true);
  });

  it("closes with Close or a click on the backdrop", async () => {
    const { user } = renderApp();
    await user.keyboard("?");
    await user.click(await screen.findByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.keyboard("?");
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await user.click(document.querySelector(".sheet-backdrop")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Tab inside the sheet", async () => {
    const { user } = renderApp();
    await user.keyboard("?");
    const close = await screen.findByRole("button", { name: "Close" });
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(close);
  });

  it("types ? into the search box rather than opening", async () => {
    const { user } = renderApp();
    await goTo(user, "Search");
    await user.type(searchBox(), "why?");
    expect((searchBox() as HTMLInputElement).value).toBe("why?");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores shortcuts while it's open", async () => {
    const { user } = renderApp();
    await screen.findByText("2 books");
    await user.keyboard("?");
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await user.keyboard("{Control>}2{/Control}");
    expect(screen.queryByRole("heading", { level: 1, name: "Books" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });

  it("is hinted at on Home", async () => {
    renderApp();
    const hint = document.querySelector(".home-hint")!;
    expect(hint.textContent).toBe("Press ? for keyboard shortcuts");
  });
});
