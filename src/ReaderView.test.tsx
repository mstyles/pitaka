import { afterEach, describe, expect, it, vi } from "vitest";
import { SAVE_DELAY_MS } from "./readingPosition";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { fixtures } from "./test/mockBackend";
import { goTo, renderApp, resultItems, scrollTo, scrollToEnd, search } from "./test/renderApp";

// As the Tauri window: `isTauri()` when a test says so, and the close
// handler the reader registers, for the test to call.
const win = vi.hoisted(() => ({
  tauri: false,
  onClose: null as (() => Promise<void>) | null,
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  isTauri: () => win.tauri,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: (event: unknown) => Promise<void>) => {
      win.onClose = () => handler({});
      return () => {
        win.onClose = null;
      };
    },
  }),
}));

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

const LONG = fixtures.books.find((b) => b.title === "A Long Book for Scrolling")!;
const LONG_CHAPTERS = fixtures.chapters[String(LONG.id)];
const SAMPLE = fixtures.reading_position_sample!;

/** The paragraphs of one of the long book's chapters, by its title. */
function blocksOf(title: string) {
  const chapter = LONG_CHAPTERS.find((c) => c.title === title)!;
  return fixtures.chapter_content[String(chapter.id)].blocks;
}

function progressLabel() {
  return document.querySelector(".reader-progress-label")?.textContent;
}

function progressValue() {
  return screen
    .getByRole("progressbar", { name: "Reading progress" })
    .getAttribute("aria-valuenow");
}

function waitSaveDelay() {
  act(() => {
    vi.advanceTimersByTime(SAVE_DELAY_MS);
  });
}

type User = ReturnType<typeof renderApp>["user"];

async function openLongBook(user: User) {
  await goTo(user, "Books");
  await user.click(await screen.findByText(LONG.title!, { selector: ".book-title" }));
  await waitFor(() => expect(paragraphs()).toHaveLength(40));
}

async function openChapter(user: User, title: string) {
  await user.click(await screen.findByRole("button", { name: title }));
  await waitFor(() => expect(paragraphs()[0].textContent).toMatch(new RegExp(`^${title},`)));
}

describe("reading position", () => {
  afterEach(() => {
    win.tauri = false;
    win.onClose = null;
  });

  it("remembers where you were and reopens there", async () => {
    const { user, callsTo } = renderApp({ fakeTimers: true });
    await openLongBook(user);
    await openChapter(user, "Part Two");
    const block = blocksOf("Part Two")[9];
    scrollTo(block.id);
    waitSaveDelay();
    await waitFor(() =>
      expect(callsTo("set_reading_position").slice(-1)[0]).toEqual({
        contentBlockId: block.id,
        finished: false,
      }),
    );

    await user.click(screen.getByRole("button", { name: "← Books" }));
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    scroll.mockClear();
    await user.click(await screen.findByText(LONG.title!, { selector: ".book-title" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Part Two" }).className).toBe("active"),
    );
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.contexts.slice(-1)[0]).toBe(document.getElementById(`block-${block.id}`));
    expect(scroll.mock.calls.slice(-1)[0]).toEqual([{ block: "start" }]);
    expect(document.querySelector(".flash")).toBeNull();
  });

  it("opening without reading saves nothing", async () => {
    const { user, callsTo } = renderApp({ fakeTimers: true });
    await openLongBook(user);
    await user.click(screen.getByRole("button", { name: "← Books" }));

    await goTo(user, "Search");
    await search(user, "quincunx");
    await waitFor(() => expect(resultItems()).toHaveLength(1));
    await user.click(resultItems()[0]);
    await waitFor(() =>
      expect(document.getElementById(`block-${HIT.content_block_id}`)).not.toBeNull(),
    );
    // What the hit's scrollIntoView does in a real window.
    scrollTo(HIT.content_block_id, { byHand: false });
    waitSaveDelay();
    await user.click(screen.getByRole("button", { name: "← Search results" }));
    await screen.findByRole("heading", { level: 1, name: "Search" });
    expect(callsTo("set_reading_position")).toEqual([]);
  });

  it("saves once per paragraph", async () => {
    const { user, callsTo } = renderApp({ fakeTimers: true });
    await openLongBook(user);
    const block = blocksOf("Part One")[5];
    scrollTo(block.id);
    waitSaveDelay();
    scrollTo(block.id);
    waitSaveDelay();
    await waitFor(() => expect(callsTo("set_reading_position")).toHaveLength(1));
    expect(callsTo("set_reading_position")[0]).toEqual({
      contentBlockId: block.id,
      finished: false,
    });
  });

  it("saves straight away when leaving", async () => {
    const { user, callsTo } = renderApp({ fakeTimers: true });
    await openLongBook(user);
    const block = blocksOf("Part One")[7];
    scrollTo(block.id);
    await user.click(screen.getByRole("button", { name: "← Books" }));
    await screen.findByRole("heading", { level: 1, name: "Books" });
    waitSaveDelay();
    expect(callsTo("set_reading_position")).toEqual([
      { contentBlockId: block.id, finished: false },
    ]);
  });

  it("saves when the window closes", async () => {
    win.tauri = true;
    const { user, callsTo } = renderApp({ fakeTimers: true });
    await openLongBook(user);
    await waitFor(() => expect(win.onClose).not.toBeNull());
    const block = blocksOf("Part One")[3];
    scrollTo(block.id);

    await win.onClose!();
    expect(callsTo("set_reading_position")).toEqual([
      { contentBlockId: block.id, finished: false },
    ]);
    // Nothing is pending once saved, so a second close doesn't save again.
    await win.onClose!();
    expect(callsTo("set_reading_position")).toHaveLength(1);
  });

  it("closes the window even if the save never finishes", async () => {
    win.tauri = true;
    const { user, callsTo } = renderApp({
      fakeTimers: true,
      gates: { set_reading_position: new Promise(() => {}) },
    });
    await openLongBook(user);
    await waitFor(() => expect(win.onClose).not.toBeNull());
    scrollTo(blocksOf("Part One")[3].id);

    let closed = false;
    const closing = win.onClose!().then(() => {
      closed = true;
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(closed).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    await closing;
    expect(closed).toBe(true);
    expect(callsTo("set_reading_position")).toHaveLength(1);
  });

  it("the end of the book reads Finished", async () => {
    const { user, callsTo } = renderApp({ fakeTimers: true });
    await openLongBook(user);
    await openChapter(user, "Part Three");
    scrollToEnd();
    await waitFor(() => expect(progressLabel()).toBe("Chapter 3 of 3 · Finished"));
    expect(progressValue()).toBe("100");
    waitSaveDelay();
    await waitFor(() =>
      expect(callsTo("set_reading_position").slice(-1)[0]).toMatchObject({ finished: true }),
    );
  });

  it("a search hit wins over the saved position", async () => {
    const { user, callsTo } = renderApp({ fakeTimers: true });
    await openLongBook(user);
    await openChapter(user, "Part Three");
    scrollTo(blocksOf("Part Three")[4].id);
    await user.click(screen.getByRole("button", { name: "← Books" }));
    await waitFor(() => expect(callsTo("set_reading_position")).toHaveLength(1));
    const lookups = callsTo("get_reading_position").length;

    await goTo(user, "Search");
    await search(user, "quincunx");
    await waitFor(() => expect(resultItems()).toHaveLength(1));
    await user.click(resultItems()[0]);
    await waitFor(() =>
      expect(document.getElementById(`block-${HIT.content_block_id}`)).not.toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Part Two" }).className).toBe("active");
    expect(callsTo("get_reading_position")).toHaveLength(lookups);
  });

  it("shows progress", async () => {
    const { user } = renderApp({ fakeTimers: true });
    await openLongBook(user);
    await waitFor(() => expect(progressLabel()).toBe("Chapter 1 of 3 · 0%"));
    expect(progressValue()).toBe("0");

    await openChapter(user, "Part Two");
    scrollTo(SAMPLE.content_block_id);
    await waitFor(() => expect(progressLabel()).toBe(`Chapter 2 of 3 · ${SAMPLE.percent}%`));
    expect(progressValue()).toBe(String(SAMPLE.percent));
  });

  it("a failed save doesn't interrupt reading", async () => {
    const { user, callsTo } = renderApp({
      fakeTimers: true,
      fail: { set_reading_position: "database is locked" },
    });
    await openLongBook(user);
    scrollTo(blocksOf("Part One")[5].id);
    waitSaveDelay();
    await waitFor(() => expect(callsTo("set_reading_position")).toHaveLength(1));
    expect(document.querySelector(".reader-error")).toBeNull();
    expect(paragraphs()).toHaveLength(40);
  });
});

async function openBook(user: ReturnType<typeof renderApp>["user"], title: string) {
  await goTo(user, "Books");
  await user.click(await screen.findByText(title, { selector: ".book-title" }));
  await waitFor(() => expect(paragraphs().length).toBeGreaterThan(0));
}

function readerStyle(name: string) {
  return document.querySelector<HTMLElement>(".reader")!.style.getPropertyValue(name);
}

function pressed(name: string) {
  return screen.getByRole("button", { name }).getAttribute("aria-pressed");
}

describe("chapter openings", () => {
  it("sets a title block as a heading, and a first paragraph of prose in small caps", async () => {
    const { user } = renderApp();
    await openBook(user, "Test Book of Research");
    expect(screen.getByRole("button", { name: "Chapter One: Beginnings" }).className).toBe(
      "active",
    );
    expect(document.getElementById("block-1")!.classList).toContain("reader-chapter-heading");
    // Its paragraphs are all shorter than prose.
    expect(document.querySelector(".reader-opening")).toBeNull();

    await user.click(screen.getByRole("button", { name: /^← Books/ }));
    await openBook(user, "A Long Book for Scrolling");
    await waitFor(() => expect(document.getElementById("block-8")).not.toBeNull());
    expect(document.getElementById("block-8")!.classList).toContain("reader-opening");
    expect(document.querySelector(".reader-chapter-heading")).toBeNull();
  });
});

describe("display settings", () => {
  it("changes the text and theme, and remembers them", async () => {
    let { user } = renderApp();
    await openBook(user, "Test Book of Research");
    const display = screen.getByRole("button", { name: "Display" });
    expect(display.getAttribute("aria-expanded")).toBe("false");
    await user.click(display);
    const panel = screen.getByRole("dialog", { name: "Display settings" });
    expect(display.getAttribute("aria-expanded")).toBe("true");
    expect(within(panel).getByText("19")).toBeTruthy();

    await user.click(within(panel).getByRole("button", { name: "Larger text" }));
    expect(readerStyle("--reader-size")).toBe("21px");
    expect(within(panel).getByText("21")).toBeTruthy();
    await user.click(within(panel).getByRole("button", { name: "Loose" }));
    expect(readerStyle("--reader-leading")).toBe("1.95");
    await user.click(within(panel).getByRole("button", { name: "Wide" }));
    expect(readerStyle("--reader-measure")).toBe("40em");
    expect(pressed("System")).toBe("true");
    await user.click(within(panel).getByRole("button", { name: "Sepia" }));
    expect(document.documentElement.dataset.theme).toBe("sepia");
    expect(pressed("Sepia")).toBe("true");
    expect(pressed("System")).toBe("false");

    // A new window reads them back.
    cleanup();
    ({ user } = renderApp());
    await openBook(user, "Test Book of Research");
    expect(readerStyle("--reader-size")).toBe("21px");
    expect(document.documentElement.dataset.theme).toBe("sepia");
    await user.click(screen.getByRole("button", { name: "Display" }));
    expect(screen.getByText("21")).toBeTruthy();
    expect(pressed("Sepia")).toBe("true");
    expect(pressed("Loose")).toBe("true");
    expect(pressed("Wide")).toBe("true");

    const reset = screen.getByRole<HTMLButtonElement>("button", { name: "Default text settings" });
    await user.click(reset);
    expect(screen.getByText("19")).toBeTruthy();
    expect(pressed("Normal")).toBe("true");
    expect(pressed("Medium")).toBe("true");
    expect(pressed("Sepia")).toBe("true");
    expect(readerStyle("--reader-size")).toBe("19px");
    expect(reset.disabled).toBe(true);
  });

  it("stops at the largest size", async () => {
    const { user } = renderApp();
    await openBook(user, "Test Book of Research");
    await user.click(screen.getByRole("button", { name: "Display" }));
    const larger = screen.getByRole<HTMLButtonElement>("button", { name: "Larger text" });
    for (let i = 0; i < 3; i++) await user.click(larger);
    expect(screen.getByText("26")).toBeTruthy();
    expect(larger.disabled).toBe(true);
    const smaller = screen.getByRole<HTMLButtonElement>("button", { name: "Smaller text" });
    expect(smaller.disabled).toBe(false);
  });

  it("closes on Escape or a click in the text, changing nothing", async () => {
    const { user } = renderApp();
    await openBook(user, "Test Book of Research");
    const display = screen.getByRole("button", { name: "Display" });
    await user.click(display);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Display settings" })).toBeNull();

    await user.click(display);
    fireEvent.mouseDown(paragraphs()[1]);
    expect(screen.queryByRole("dialog", { name: "Display settings" })).toBeNull();
    expect(readerStyle("--reader-size")).toBe("19px");
    expect(document.documentElement.dataset.theme).toBeUndefined();

    // The button itself still toggles it.
    await user.click(display);
    await user.click(display);
    expect(screen.queryByRole("dialog", { name: "Display settings" })).toBeNull();
  });

  it("puts the selection toolbar away when the text reflows", async () => {
    const { user } = renderApp();
    await openBook(user, "Test Book of Research");
    await user.click(screen.getByRole("button", { name: "Display" }));
    const text = paragraphs()[1].firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 4);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(paragraphs()[1]);
    expect(await screen.findByRole("toolbar", { name: "Highlight selection" })).toBeTruthy();

    // A click with no mousedown first, as a keyboard shortcut would change it.
    fireEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(readerStyle("--reader-size")).toBe("21px");
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});
