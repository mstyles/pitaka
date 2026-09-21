import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { goTo, renderApp, type Section } from "./test/renderApp";

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
    expect(detail("Bookmarks")).toBe("1 folder · 2 passages");
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

  it.each<Section>(["Books", "Bookmarks", "Search"])(
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
    expect(screen.getByText("No books yet. Import an EPUB to start.")).toBeTruthy();

    await goTo(user, "Home");
    await waitFor(() => expect(detail("Books")).toBe("Import your first EPUB"));
    expect(detail("Search")).toBe("Import a book to search");
    expect((card("Search") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Your library")).toBeNull();
    // The folder outlives its passages.
    expect(detail("Bookmarks")).toBe("1 folder · 0 passages");
  });

  it("shows an error when the library can't be loaded", async () => {
    renderApp({ fail: { list_books: "database is locked" } });
    expect(await screen.findByText("Loading library failed: database is locked")).toBeTruthy();
    expect((card("Search") as HTMLButtonElement).disabled).toBe(false);
  });
});
