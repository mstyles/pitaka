import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fixtures } from "./test/mockBackend";
import { renderApp } from "./test/renderApp";

const FOLDER = fixtures.bookmark_folders[0];
const [TEST_PASSAGE, LONG_PASSAGE] = fixtures.folder_bookmarks[String(FOLDER.id)];
const LONG_BOOK = "A Long Book for Scrolling";

function folderRow(name: string) {
  return screen.getByText(name, { selector: ".folder-row-name" }).closest("li")!;
}

function passages() {
  return Array.from(document.querySelectorAll<HTMLLIElement>(".folder-passage"));
}

/** The bookmark button beside a paragraph in the reader. */
function toggleFor(blockId: number) {
  const block = document.getElementById(`block-${blockId}`)!.closest(".reader-block")!;
  return within(block as HTMLElement).getByRole("button", { name: "Bookmark this passage" });
}

async function openLongBook(user: ReturnType<typeof renderApp>["user"]) {
  await user.click(await screen.findByText(LONG_BOOK));
  await screen.findByText(/^Part One, paragraph 1:/);
}

/** The id of the n-th paragraph (1-based) of the long book's first chapter. */
function partOneBlock(n: number) {
  const chapterId = fixtures.chapters["2"][0].id;
  return fixtures.chapter_content[String(chapterId)].blocks[n - 1].id;
}

describe("bookmark folders in the library", () => {
  it("lists folders with their passage counts", async () => {
    renderApp();
    await screen.findByText(FOLDER.name);
    expect(within(folderRow(FOLDER.name)).getByText("2 passages")).toBeTruthy();
  });

  it("says so when there are no folders", async () => {
    const { user } = renderApp();
    await user.click(await screen.findByText(FOLDER.name));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(
      await screen.findByText(
        "No bookmark folders yet. Create one here, or bookmark a passage while reading.",
      ),
    ).toBeTruthy();
  });

  it("creates a folder, and rejects a name that differs only in case", async () => {
    const { user, callsTo } = renderApp();
    await screen.findByText(FOLDER.name);
    const input = screen.getByPlaceholderText("New folder name");
    await user.type(input, "  Talk notes  ");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText("Talk notes");
    expect(within(folderRow("Talk notes")).getByText("0 passages")).toBeTruthy();
    // Newest first.
    const names = Array.from(document.querySelectorAll(".folder-row-name"), (e) => e.textContent);
    expect(names).toEqual(["Talk notes", FOLDER.name]);

    await user.type(input, "TALK NOTES");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(
      await screen.findByText('Creating folder failed: a folder named "TALK NOTES" already exists'),
    ).toBeTruthy();
    expect(callsTo("create_bookmark_folder")).toHaveLength(2);
  });

  it("shows a folder's passages in the order they were added", async () => {
    const { user, callsTo } = renderApp();
    await user.click(await screen.findByText(FOLDER.name));
    await waitFor(() => expect(passages()).toHaveLength(2));
    expect(callsTo("list_folder_bookmarks")).toEqual([{ folderId: FOLDER.id }]);
    expect(screen.getByRole("heading", { name: FOLDER.name })).toBeTruthy();
    expect(passages()[0].textContent).toContain(
      `${TEST_PASSAGE.book_title} — ${TEST_PASSAGE.chapter_title}`,
    );
    expect(passages()[0].textContent).toContain(TEST_PASSAGE.text);
    expect(passages()[1].textContent).toContain(LONG_PASSAGE.text);
  });

  it("opens a passage in the reader and comes back to the folder", async () => {
    const { user, callsTo } = renderApp();
    await user.click(await screen.findByText(FOLDER.name));
    await waitFor(() => expect(passages()).toHaveLength(2));
    await user.click(passages()[1]);

    const target = await waitFor(() => {
      const el = document.getElementById(`block-${LONG_PASSAGE.content_block_id}`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(target.classList.contains("flash")).toBe(true);
    expect(callsTo("get_chapter_content")).toEqual([{ chapterId: LONG_PASSAGE.chapter_id }]);

    await user.click(screen.getByRole("button", { name: "← Library" }));
    expect(screen.getByRole("heading", { name: FOLDER.name })).toBeTruthy();
    await waitFor(() => expect(callsTo("list_folder_bookmarks")).toHaveLength(2));
  });

  it("renames a folder, allowing a change of case only", async () => {
    const { user, callsTo } = renderApp();
    await user.click(await screen.findByText(FOLDER.name));
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText<HTMLInputElement>("Folder name");
    expect(input.value).toBe(FOLDER.name);
    await user.clear(input);
    await user.type(input, "KNOW YOUR LIMIT");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { name: "KNOW YOUR LIMIT" })).toBeTruthy();
    expect(callsTo("rename_bookmark_folder")).toEqual([
      { folderId: FOLDER.id, name: "KNOW YOUR LIMIT" },
    ]);

    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.clear(screen.getByLabelText("Folder name"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Rename failed: folder name can't be empty")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "KNOW YOUR LIMIT" })).toBeTruthy();
  });

  it("removes a passage from the folder", async () => {
    const { user, callsTo } = renderApp();
    await user.click(await screen.findByText(FOLDER.name));
    await waitFor(() => expect(passages()).toHaveLength(2));
    await user.click(within(passages()[0]).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(passages()).toHaveLength(1));
    expect(callsTo("remove_bookmark")).toEqual([
      { folderId: FOLDER.id, contentBlockId: TEST_PASSAGE.content_block_id },
    ]);
    expect(screen.getByText("1 passage")).toBeTruthy();
    // Remove doesn't open the reader.
    expect(document.querySelector(".reader")).toBeNull();
  });

  it("deletes a folder after confirmation", async () => {
    const { user, callsTo } = renderApp();
    await user.click(await screen.findByText(FOLDER.name));
    await waitFor(() => expect(passages()).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(callsTo("delete_bookmark_folder")).toEqual([{ folderId: FOLDER.id }]));
    expect(callsTo("plugin:dialog|message")[0].message).toBe(
      `Delete the folder "${FOLDER.name}" and its 2 bookmarks? The passages stay in their books.`,
    );
    await screen.findByPlaceholderText("New folder name");
    expect(screen.queryByText(FOLDER.name)).toBeNull();
  });

  it("keeps a folder when deletion isn't confirmed", async () => {
    const { user, callsTo } = renderApp({ confirm: false });
    await user.click(await screen.findByText(FOLDER.name));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(callsTo("plugin:dialog|message")).toHaveLength(1));
    expect(callsTo("delete_bookmark_folder")).toEqual([]);
    expect(screen.getByRole("heading", { name: FOLDER.name })).toBeTruthy();
  });

  it("warns that removing a book deletes its bookmarks", async () => {
    const { user, callsTo } = renderApp();
    await screen.findByText(FOLDER.name);
    const bookRow = screen.getByText(LONG_BOOK).closest("li")!;
    await user.click(within(bookRow).getByRole("button", { name: "Remove" }));
    await screen.findByText(`Removed "${LONG_BOOK}"`);
    expect(callsTo("plugin:dialog|message")[0].message).toBe(
      `Remove "${LONG_BOOK}" from the library? Its 1 bookmark will be deleted too. The EPUB file won't be deleted.`,
    );
    await waitFor(() =>
      expect(within(folderRow(FOLDER.name)).getByText("1 passage")).toBeTruthy(),
    );
  });
});

describe("bookmarking in the reader", () => {
  it("marks paragraphs that are already bookmarked", async () => {
    const { user, callsTo } = renderApp();
    await openLongBook(user);
    await waitFor(() =>
      expect(toggleFor(LONG_PASSAGE.content_block_id).classList.contains("bookmarked")).toBe(true),
    );
    expect(toggleFor(partOneBlock(1)).classList.contains("bookmarked")).toBe(false);
    expect(callsTo("get_chapter_bookmarks")).toEqual([{ chapterId: LONG_PASSAGE.chapter_id }]);
  });

  it("adds and removes a paragraph from a folder", async () => {
    const { user, callsTo } = renderApp();
    await openLongBook(user);
    const block = partOneBlock(5);
    await user.click(toggleFor(block));
    const popover = screen.getByRole("dialog", { name: "Bookmark folders" });
    expect(within(popover).getByText("Add to folder")).toBeTruthy();
    const box = within(popover).getByLabelText<HTMLInputElement>(FOLDER.name);
    expect(box.checked).toBe(false);

    await user.click(box);
    await waitFor(() => expect(toggleFor(block).classList.contains("bookmarked")).toBe(true));
    expect(box.checked).toBe(true);
    expect(callsTo("add_bookmark")).toEqual([{ folderId: FOLDER.id, contentBlockId: block }]);

    await user.click(box);
    await waitFor(() => expect(toggleFor(block).classList.contains("bookmarked")).toBe(false));
    expect(callsTo("remove_bookmark")).toEqual([{ folderId: FOLDER.id, contentBlockId: block }]);
  });

  it("bookmarks into a new folder and updates the library counts", async () => {
    const { user, callsTo } = renderApp();
    await openLongBook(user);
    const block = partOneBlock(3);
    await user.click(toggleFor(block));
    await user.type(screen.getByLabelText("New folder name"), "Second talk{Enter}");

    const popover = screen.getByRole("dialog", { name: "Bookmark folders" });
    const box = await within(popover).findByLabelText<HTMLInputElement>("Second talk");
    expect(box.checked).toBe(true);
    const names = within(popover).getAllByRole("checkbox").map((c) => c.parentElement!.textContent);
    expect(names).toEqual(["Second talk", FOLDER.name]);
    expect(callsTo("add_bookmark")).toEqual([
      { folderId: FOLDER.id + 1, contentBlockId: block },
    ]);

    await user.click(screen.getByRole("button", { name: "← Library" }));
    await waitFor(() =>
      expect(within(folderRow("Second talk")).getByText("1 passage")).toBeTruthy(),
    );
  });

  it("shows folder errors inside the popover", async () => {
    const { user } = renderApp();
    await openLongBook(user);
    await user.click(toggleFor(partOneBlock(3)));
    await user.type(screen.getByLabelText("New folder name"), `${FOLDER.name.toUpperCase()}{Enter}`);
    const popover = screen.getByRole("dialog", { name: "Bookmark folders" });
    expect(
      await within(popover).findByText(
        `a folder named "${FOLDER.name.toUpperCase()}" already exists`,
      ),
    ).toBeTruthy();
  });

  it("offers only a new folder when there are none", async () => {
    const { user } = renderApp();
    await user.click(await screen.findByText(FOLDER.name));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await screen.findByPlaceholderText("New folder name");
    await openLongBook(user);
    await user.click(toggleFor(partOneBlock(3)));
    const popover = screen.getByRole("dialog", { name: "Bookmark folders" });
    expect(within(popover).queryByText("Add to folder")).toBeNull();
    expect(within(popover).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(popover).getByLabelText("New folder name")).toBeTruthy();
  });

  it("closes the popover with Escape, a click outside, the icon, or a chapter switch", async () => {
    const { user } = renderApp();
    await openLongBook(user);
    const dialog = () => screen.queryByRole("dialog", { name: "Bookmark folders" });

    await user.click(toggleFor(partOneBlock(3)));
    expect(dialog()).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(dialog()).toBeNull();

    await user.click(toggleFor(partOneBlock(3)));
    await user.click(document.getElementById(`block-${partOneBlock(10)}`)!);
    expect(dialog()).toBeNull();

    await user.click(toggleFor(partOneBlock(3)));
    await user.click(toggleFor(partOneBlock(3)));
    expect(dialog()).toBeNull();

    await user.click(toggleFor(partOneBlock(3)));
    await user.click(toggleFor(partOneBlock(4)));
    expect(dialog()).not.toBeNull();
    expect(toggleFor(partOneBlock(4)).getAttribute("aria-expanded")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Part Two" }));
    await screen.findByText(/^Part Two, paragraph 1:/);
    expect(dialog()).toBeNull();
  });
});
