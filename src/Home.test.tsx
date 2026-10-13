import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAVE_DELAY_MS } from "./readingPosition";
import { FEEDBACK_LINKS } from "./feedback";
import { fixtures } from "./test/mockBackend";
import { goTo, renderApp, scrollTo, scrollToEnd, type Section } from "./test/renderApp";

const LONG_BOOK = "A Long Book for Scrolling";
const SAMPLE = fixtures.reading_position_sample!;

/** Opens the long book from Home, reads into Part Two and comes back. */
async function readIntoPartTwo(user: ReturnType<typeof renderApp>["user"]) {
  const list = await screen.findByRole("region", { name: "Your library" });
  await user.click(within(list).getByRole("button", { name: new RegExp(`^${LONG_BOOK}`) }));
  await user.click(await screen.findByRole("button", { name: "Part Two" }));
  await screen.findByText(/^Part Two, paragraph 1:/);
  scrollTo(SAMPLE.content_block_id);
  act(() => {
    vi.advanceTimersByTime(SAVE_DELAY_MS);
  });
  await user.click(screen.getByRole("button", { name: "← Home" }));
  await screen.findByRole("heading", { level: 1, name: "Pitaka" });
}

function card(title: string) {
  return screen.getByRole("button", { name: new RegExp(`^${title}`) });
}

function detail(title: string) {
  return card(title).querySelector(".home-card-detail")!.textContent;
}

describe("home", () => {
  it("opens on home with a card per section and their counts", async () => {
    renderApp();
    await waitFor(() => expect(detail("Books")).toBe("2 books"));
    expect(detail("Bookmarks & notes")).toBe("1 folder · 2 passages · 2 highlights, 2 notes");
    expect(detail("Search")).toBe("Search across 2 books");
    expect(screen.getByRole("heading", { level: 1, name: "Pitaka" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Sections" })).toBeNull();
    expect(document.querySelector(".reader")).toBeNull();
  });

  it("lists the most recent books", async () => {
    renderApp();
    const list = await screen.findByRole("region", { name: "Your library" });
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.querySelector(".book-title")!.textContent)).toEqual([
      "A Long Book for Scrolling",
      "Test Book of Research",
    ]);
    expect(rows[0].querySelector(".book-meta")!.textContent).toBe("Fixture Author · 3 chapters");
    expect(within(list).queryByRole("button", { name: /^All \d+ books/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Continue reading" })).toBeNull();
  });

  it("continues reading where you left off", async () => {
    const { user } = renderApp({ fakeTimers: true });
    await readIntoPartTwo(user);

    const continuing = await screen.findByRole("region", { name: "Continue reading" });
    const row = within(continuing).getByRole("button", { name: new RegExp(`^${LONG_BOOK}`) });
    expect(row.querySelector(".book-meta")!.textContent).toBe(`Part Two · ${SAMPLE.percent}%`);
    const bar = within(row).getByRole("progressbar", { name: `${LONG_BOOK} progress` });
    expect(bar.getAttribute("aria-valuenow")).toBe(String(SAMPLE.percent));
    const library = screen.getByRole("region", { name: "Your library" });
    expect(within(library).queryByText(LONG_BOOK)).toBeNull();
    expect(within(library).getByText("Test Book of Research")).toBeTruthy();

    await user.click(row);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Part Two" }).className).toBe("active"),
    );
    expect(screen.getByRole("button", { name: "← Home" })).toBeTruthy();
  });

  it("a finished book isn't in Continue reading", async () => {
    const { user, callsTo } = renderApp({ fakeTimers: true });
    const list = await screen.findByRole("region", { name: "Your library" });
    await user.click(within(list).getByRole("button", { name: new RegExp(`^${LONG_BOOK}`) }));
    await user.click(await screen.findByRole("button", { name: "Part Three" }));
    await screen.findByText(/^Part Three, paragraph 1:/);
    scrollToEnd();
    act(() => {
      vi.advanceTimersByTime(SAVE_DELAY_MS);
    });
    await waitFor(() =>
      expect(callsTo("set_reading_position").slice(-1)[0]).toMatchObject({ finished: true }),
    );

    await user.click(screen.getByRole("button", { name: "← Home" }));
    const library = await screen.findByRole("region", { name: "Your library" });
    await waitFor(() => expect(callsTo("list_reading_positions")).toHaveLength(2));
    expect(screen.queryByRole("heading", { name: "Continue reading" })).toBeNull();
    expect(within(library).getByText(LONG_BOOK)).toBeTruthy();
  });

  it("removing a book drops it from Continue reading", async () => {
    const { user, callsTo } = renderApp({ fakeTimers: true });
    await readIntoPartTwo(user);
    await screen.findByRole("region", { name: "Continue reading" });

    await goTo(user, "Books");
    const row = (await screen.findByText(LONG_BOOK, { selector: ".book-title" })).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText(LONG_BOOK)).toBeNull());

    await goTo(user, "Home");
    await screen.findByRole("region", { name: "Your library" });
    await waitFor(() => expect(callsTo("list_reading_positions")).toHaveLength(3));
    expect(screen.queryByRole("heading", { name: "Continue reading" })).toBeNull();
  });

  it("links to the rest of the library when it has more than 3 books", async () => {
    // list_books is newest first, so the extra books go at the front.
    const extra = [7, 6, 5].map((id) => ({ ...fixtures.books[1], id, title: `Extra Book ${id}` }));
    const { user } = renderApp({ books: [...extra, ...fixtures.books] });
    const list = await screen.findByRole("region", { name: "Your library" });
    expect(Array.from(list.querySelectorAll(".book-title"), (t) => t.textContent)).toEqual([
      "Extra Book 7",
      "Extra Book 6",
      "Extra Book 5",
    ]);

    await user.click(within(list).getByRole("button", { name: "All 5 books →" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Books" })).toBeTruthy();
  });

  it("shows each recent book's cover, and still opens the book from its row", async () => {
    const { user, callsTo } = renderApp();
    const list = await screen.findByRole("region", { name: "Your library" });
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.querySelector(".cover-thumb")!.tagName)).toEqual(["IMG", "DIV"]);
    expect(rows[1].querySelector(".cover-generated")!.textContent).toBe("T");

    await user.click(rows[1]);
    await waitFor(() => expect(callsTo("get_book_chapters")).toEqual([{ bookId: 1 }]));
  });

  it("opens a book from home and comes back", async () => {
    const { user, callsTo } = renderApp();
    const list = await screen.findByRole("region", { name: "Your library" });
    await user.click(within(list).getByRole("button", { name: /^A Long Book for Scrolling/ }));
    await waitFor(() => expect(callsTo("get_book_chapters")).toEqual([{ bookId: 2 }]));

    await user.click(await screen.findByRole("button", { name: "← Home" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Pitaka" })).toBeTruthy();
    expect(document.querySelector(".reader")).toBeNull();
  });

  it.each<Section>(["Books", "Bookmarks & notes", "Search"])(
    "opens %s from its card and returns home from the header",
    async (section) => {
      const { user } = renderApp();
      await goTo(user, section);
      const nav = screen.getByRole("navigation", { name: "Sections" });
      expect(within(nav).getByRole("button", { name: section }).getAttribute("aria-current")).toBe(
        "page",
      );
      expect(within(nav).getByRole("button", { name: "Home" }).getAttribute("aria-current")).toBe(
        null,
      );

      await goTo(user, "Home");
      expect(await screen.findByRole("heading", { level: 1, name: "Pitaka" })).toBeTruthy();
      expect(screen.queryByRole("navigation", { name: "Sections" })).toBeNull();
    },
  );

  it("points an empty library at importing and disables search", async () => {
    const { user } = renderApp();
    await goTo(user, "Books");
    for (const title of ["Test Book of Research", "A Long Book for Scrolling"]) {
      const row = (await screen.findByText(title)).closest("li")!;
      await user.click(within(row).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(screen.queryByText(title)).toBeNull());
    }
    expect(screen.getByRole("heading", { name: "Your library is empty" })).toBeTruthy();

    await goTo(user, "Home");
    await waitFor(() => expect(detail("Books")).toBe("Import your first book"));
    expect(detail("Search")).toBe("Import a book to search");
    expect((card("Search") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Your library")).toBeNull();
    // The folder outlives its passages.
    expect(detail("Bookmarks & notes")).toBe("1 folder · 0 passages");

    expect(screen.getByRole("heading", { name: "Welcome to Pitaka" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Go to Books" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Books" })).toBeTruthy();
  });

  it("shows an error when the library can't be loaded", async () => {
    renderApp({ fail: { list_books: "database is locked" } });
    expect(await screen.findByText("Loading library failed: database is locked")).toBeTruthy();
    expect((card("Search") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("feedback links", () => {
  afterEach(() => {
    delete (globalThis as { isTauri?: boolean }).isTauri;
  });

  const links = [
    ["Report a bug", FEEDBACK_LINKS.bug],
    ["Suggest an idea", FEEDBACK_LINKS.idea],
    ["email me", FEEDBACK_LINKS.email],
  ] as const;

  function expectLinks() {
    for (const [name, href] of links) {
      const link = screen.getByRole("link", { name });
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noreferrer");
    }
  }

  it("shows them on home", async () => {
    renderApp();
    await waitFor(() => expect(detail("Books")).toBe("2 books"));
    expectLinks();
  });

  it("shows them with an empty library", async () => {
    renderApp({ data: { ...fixtures, books: [] } });
    await screen.findByText("Welcome to Pitaka");
    expectLinks();
  });

  it("hands the link to the system in the desktop app", async () => {
    (globalThis as { isTauri?: boolean }).isTauri = true;
    const { user, openedUrls } = renderApp();
    await waitFor(() => expect(detail("Books")).toBe("2 books"));
    const click = vi.fn();
    const link = screen.getByRole("link", { name: "Report a bug" });
    // React handles clicks at the root, so look once the event has bubbled past it.
    document.addEventListener("click", (e) => click(e.defaultPrevented), { once: true });
    await user.click(link);
    expect(openedUrls).toEqual([FEEDBACK_LINKS.bug]);
    expect(click).toHaveBeenCalledWith(true);
  });

  it("is a plain link in the browser", async () => {
    const { user, openedUrls } = renderApp();
    await waitFor(() => expect(detail("Books")).toBe("2 books"));
    await user.click(screen.getByRole("link", { name: "Suggest an idea" }));
    expect(openedUrls).toEqual([]);
  });
});
