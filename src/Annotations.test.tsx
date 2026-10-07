import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import { fixtures, installMockBackend } from "./test/mockBackend";
import { goTo, renderApp } from "./test/renderApp";

const LONG_BOOK = "A Long Book for Scrolling";
const PART_ONE = fixtures.chapters["2"][0];
const BLOCKS = fixtures.chapter_content[String(PART_ONE.id)].blocks;
const ANNOTATIONS = fixtures.chapter_annotations![String(PART_ONE.id)];
const [NOTED, PLAIN] = ANNOTATIONS.highlights; // yellow with a note, green without
const HIGHLIGHT_NOTE = ANNOTATIONS.notes.find((n) => n.highlight_id === NOTED.id)!;
const PARAGRAPH_NOTE = ANNOTATIONS.notes.find((n) => n.highlight_id == null)!;

type User = ReturnType<typeof renderApp>["user"];

async function openLongBook(user: User) {
  await goTo(user, "Books");
  await user.click(await screen.findByText(LONG_BOOK));
  await screen.findByText(/^Part One, paragraph 1:/);
}

/** The n-th paragraph (1-based) of Part One, and its block in the reader. */
function paragraph(n: number) {
  return document.getElementById(`block-${BLOCKS[n - 1].id}`)!;
}
function block(n: number) {
  return paragraph(n).closest(".reader-block") as HTMLElement;
}

/** Selects text the way a drag does, then lets go of the mouse. */
function select(start: Node, startOffset: number, end: Node, endOffset: number) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent.mouseUp(end.parentElement!);
}

function textNodeOf(n: number) {
  return paragraph(n).firstChild as Text;
}

describe("highlights in the reader", () => {
  it("renders the chapter's highlights", async () => {
    const { user, callsTo } = renderApp();
    await openLongBook(user);
    const yellow = await waitFor(() => paragraph(3).querySelector("mark.hl-yellow")!);
    expect(yellow.textContent).toBe("filler text");
    expect(paragraph(3).querySelector("mark.hl-green")!.textContent).toBe("wrap");
    expect(paragraph(3).textContent).toBe(BLOCKS[2].text);
    expect(callsTo("get_chapter_annotations")).toEqual([{ chapterId: PART_ONE.id }]);
  });

  it("highlights a selection with code-point offsets", async () => {
    const { user, callsTo } = renderApp();
    await openLongBook(user);
    // "Part One" is the first 8 characters.
    select(textNodeOf(1), 0, textNodeOf(1), 8);
    const toolbar = await screen.findByRole("toolbar", { name: "Highlight selection" });
    await user.click(within(toolbar).getByRole("button", { name: "Highlight blue" }));

    expect(callsTo("add_highlight")).toEqual([
      { contentBlockId: BLOCKS[0].id, start: 0, end: 8, color: "blue" },
    ]);
    await waitFor(() =>
      expect(paragraph(1).querySelector("mark.hl-blue")?.textContent).toBe("Part One"),
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("shows the core's error, such as an overlap, in the toolbar", async () => {
    const { user } = renderApp();
    await openLongBook(user);
    await waitFor(() => expect(paragraph(3).querySelector("mark")).not.toBeNull());
    // From the start of the paragraph into the yellow highlight.
    const mark = paragraph(3).querySelector("mark.hl-yellow")!.firstChild!;
    select(textNodeOf(3), 0, mark, 3);
    const toolbar = await screen.findByRole("toolbar");
    await user.click(within(toolbar).getByRole("button", { name: "Highlight pink" }));
    expect(await within(toolbar).findByText("that overlaps an existing highlight")).toBeTruthy();
  });

  it("won't highlight across paragraphs", async () => {
    const { user, callsTo } = renderApp();
    await openLongBook(user);
    select(textNodeOf(1), 5, textNodeOf(2), 5);
    const toolbar = await screen.findByRole("toolbar");
    expect(within(toolbar).getByText("Highlights stay within one paragraph")).toBeTruthy();
    expect(within(toolbar).queryByRole("button", { name: /^Highlight/ })).toBeNull();
    expect(callsTo("add_highlight")).toEqual([]);
  });

  it("measures offsets after a note marker by the text alone", async () => {
    const { user, callsTo } = renderApp();
    await openLongBook(user);
    await waitFor(() => expect(paragraph(3).querySelector(".note-hint")).not.toBeNull());
    // The text node after the noted highlight starts " that is long…".
    const after = paragraph(3).querySelector("mark.hl-yellow")!.parentElement!.nextSibling!;
    expect(after.textContent!.startsWith(" that")).toBe(true);
    select(after, 1, after, 5);
    await user.click(await screen.findByRole("button", { name: "Highlight green" }));

    const start = BLOCKS[2].text.indexOf("that is long");
    expect(callsTo("add_highlight")).toEqual([
      { contentBlockId: BLOCKS[2].id, start, end: start + 4, color: "green" },
    ]);
  });

  it("recolours a highlight from its popover", async () => {
    const { user, callsTo } = renderApp();
    await openLongBook(user);
    await user.click(await waitFor(() => paragraph(3).querySelector("mark.hl-green")!));
    const popover = await screen.findByRole("dialog", { name: "Highlight" });
    expect(
      within(popover).getByRole("button", { name: "Green" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(within(popover).getByRole("button", { name: "Pink" }));
    expect(callsTo("set_highlight_color")).toEqual([{ highlightId: PLAIN.id, color: "pink" }]);
    await waitFor(() => expect(paragraph(3).querySelector("mark.hl-pink")).not.toBeNull());

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Highlight" })).toBeNull();
  });

  it("removes a highlight without a note straight away", async () => {
    const { user, callsTo } = renderApp();
    await openLongBook(user);
    await user.click(await waitFor(() => paragraph(3).querySelector("mark.hl-green")!));
    const popover = await screen.findByRole("dialog", { name: "Highlight" });
    await user.click(within(popover).getByRole("button", { name: "Remove" }));
    expect(callsTo("delete_highlight")).toEqual([{ highlightId: PLAIN.id }]);
    expect(callsTo("plugin:dialog|message")).toEqual([]);
    await waitFor(() => expect(paragraph(3).querySelector("mark.hl-green")).toBeNull());
  });

  it("asks before removing a highlight that has a note, and keeps it on cancel", async () => {
    const { user, callsTo } = renderApp({ confirm: false });
    await openLongBook(user);
    await user.click(await waitFor(() => paragraph(3).querySelector("mark.hl-yellow")!));
    const popover = await screen.findByRole("dialog", { name: "Highlight" });
    expect(within(popover).queryByRole("button", { name: "Add note" })).toBeNull();
    await user.click(within(popover).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(callsTo("plugin:dialog|message")[0]?.message).toBe(
        "Remove this highlight and its note?",
      ),
    );
    expect(callsTo("delete_highlight")).toEqual([]);
    expect(paragraph(3).querySelector("mark.hl-yellow")).not.toBeNull();
  });
});

describe("notes in the reader", () => {
  it("keeps notes hidden until their marker is clicked", async () => {
    const { user } = renderApp();
    await openLongBook(user);
    const marker = await waitFor(() =>
      within(paragraph(3)).getByRole("button", { name: "Show note" }),
    );
    expect(screen.queryByText(HIGHLIGHT_NOTE.body)).toBeNull();
    expect(marker.getAttribute("aria-expanded")).toBe("false");

    await user.click(marker);
    const card = screen.getByRole("group", { name: "Note on highlight" });
    expect(within(card).getByText(HIGHLIGHT_NOTE.body)).toBeTruthy();
    expect(marker.getAttribute("aria-expanded")).toBe("true");
    expect(marker.getAttribute("aria-label")).toBe("Hide note");
    expect(block(3).querySelector(".note-margin")!.contains(card)).toBe(true);

    await user.click(within(card).getByRole("button", { name: "Hide" }));
    expect(screen.queryByText(HIGHLIGHT_NOTE.body)).toBeNull();
    expect(marker.getAttribute("aria-expanded")).toBe("false");
  });

  it("puts a paragraph note's marker at the end of its paragraph", async () => {
    const { user } = renderApp();
    await openLongBook(user);
    const marker = await waitFor(() =>
      within(paragraph(5)).getByRole("button", { name: "Show note" }),
    );
    expect(paragraph(5).lastElementChild!.contains(marker)).toBe(true);
    expect(paragraph(5).lastChild).toBe(paragraph(5).lastElementChild);

    // The paragraph's note icon toggles the same card.
    await user.click(within(block(5)).getByRole("button", { name: "Note on this passage" }));
    expect(screen.getByText(PARAGRAPH_NOTE.body)).toBeTruthy();
    expect(marker.getAttribute("aria-expanded")).toBe("true");
  });

  it("highlights a selection and starts its note", async () => {
    const { user, callsTo } = renderApp();
    await openLongBook(user);
    select(textNodeOf(1), 0, textNodeOf(1), 8);
    await user.click(await screen.findByRole("button", { name: "Add note" }));
    expect(callsTo("add_highlight")).toEqual([
      { contentBlockId: BLOCKS[0].id, start: 0, end: 8, color: "yellow" },
    ]);
    const textarea = await screen.findByRole("textbox", { name: "Note" });
    expect((textarea as HTMLTextAreaElement).value).toBe("");

    await user.type(textarea, "The heroine");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const [highlightId] = callsTo("add_highlight_note").map((a) => a.highlightId);
    expect(callsTo("add_highlight_note")).toEqual([{ highlightId, body: "The heroine" }]);
    // The card stays open on the saved note, and its marker appears.
    expect(await screen.findByText("The heroine")).toBeTruthy();
    const marker = within(paragraph(1)).getByRole("button", { name: "Hide note" });
    expect(marker.getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves the highlight when a new note is cancelled", async () => {
    const { user, callsTo } = renderApp();
    await openLongBook(user);
    select(textNodeOf(1), 0, textNodeOf(1), 8);
    await user.click(await screen.findByRole("button", { name: "Add note" }));
    await screen.findByRole("textbox", { name: "Note" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    await waitFor(() => expect(paragraph(1).querySelector("mark.hl-yellow")).not.toBeNull());
    expect(within(paragraph(1)).queryByRole("button", { name: "Show note" })).toBeNull();
    expect(callsTo("add_highlight_note")).toEqual([]);
  });

  it("edits a note, and deletes it when saved empty", async () => {
    const { user, callsTo } = renderApp();
    await openLongBook(user);
    await user.click(
      await waitFor(() => within(paragraph(3)).getByRole("button", { name: "Show note" })),
    );
    const card = screen.getByRole("group", { name: "Note on highlight" });
    await user.click(within(card).getByRole("button", { name: "Edit" }));
    const textarea = within(card).getByRole("textbox", { name: "Note" });
    await user.clear(textarea);
    await user.type(textarea, "Not filler at all");
    await user.click(within(card).getByRole("button", { name: "Save" }));
    expect(callsTo("update_note")).toEqual([
      { noteId: HIGHLIGHT_NOTE.id, body: "Not filler at all" },
    ]);
    expect(await within(card).findByText("Not filler at all")).toBeTruthy();

    await user.click(within(card).getByRole("button", { name: "Edit" }));
    await user.clear(within(card).getByRole("textbox", { name: "Note" }));
    await user.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo("delete_note")).toEqual([{ noteId: HIGHLIGHT_NOTE.id }]));
    expect(callsTo("plugin:dialog|message")[0].message).toBe("Delete this note?");
    await waitFor(() =>
      expect(within(paragraph(3)).queryByRole("button", { name: /note$/ })).toBeNull(),
    );
    // The highlight itself stays.
    expect(paragraph(3).querySelector("mark.hl-yellow")).not.toBeNull();
  });

  it("adds a note on a whole paragraph", async () => {
    const { user, callsTo } = renderApp();
    await openLongBook(user);
    const toggle = within(block(1)).getByRole("button", { name: "Note on this passage" });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const card = screen.getByRole("group", { name: "Note on paragraph" });
    await user.type(within(card).getByRole("textbox", { name: "Note" }), "Opening line");
    await user.click(within(card).getByRole("button", { name: "Save" }));

    expect(callsTo("add_paragraph_note")).toEqual([
      { contentBlockId: BLOCKS[0].id, body: "Opening line" },
    ]);
    await waitFor(() =>
      expect(within(paragraph(1)).getByRole("button", { name: "Hide note" })).toBeTruthy(),
    );
  });
});

describe("Bookmarks & notes screen", () => {
  it("lists annotated books and opens one's entries in reading order", async () => {
    const { user } = renderApp();
    await goTo(user, "Bookmarks & notes");
    const section = screen.getByRole("region", { name: "Highlights & notes" });
    const row = await within(section).findByText(LONG_BOOK);
    expect(within(row.closest("li")!).getByText("2 highlights, 2 notes")).toBeTruthy();

    await user.click(row);
    await screen.findByRole("heading", { name: LONG_BOOK });
    expect(screen.getByRole("heading", { name: "Part One" })).toBeTruthy();
    const quotes = Array.from(document.querySelectorAll(".annotation-quote"), (q) => q.textContent);
    expect(quotes).toEqual(["filler text", "wrap", BLOCKS[4].text]);
    const notes = Array.from(document.querySelectorAll(".annotation-note"), (n) => n.textContent);
    expect(notes).toEqual([HIGHLIGHT_NOTE.body, PARAGRAPH_NOTE.body]);
  });

  it("opens an entry in the reader with its note showing, and comes back", async () => {
    const { user } = renderApp();
    await goTo(user, "Bookmarks & notes");
    await user.click(await screen.findByText(LONG_BOOK, { selector: ".folder-row-name" }));
    await user.click(await screen.findByText("filler text", { selector: ".annotation-quote" }));

    const back = await screen.findByRole("button", { name: `← ${LONG_BOOK}` });
    await waitFor(() => expect(paragraph(3).classList.contains("flash")).toBe(true));
    expect(
      await screen.findByText(HIGHLIGHT_NOTE.body, { selector: ".note-card-body" }),
    ).toBeTruthy();

    await user.click(back);
    expect(await screen.findByRole("heading", { name: LONG_BOOK })).toBeTruthy();
  });
});

describe("mock backend", () => {
  it("answers annotation queries as the core recorded them", async () => {
    installMockBackend();
    expect(await invoke("list_annotated_books")).toEqual(fixtures.annotated_books);
    expect(await invoke("list_book_annotations", { bookId: 2 })).toEqual(
      fixtures.book_annotations!["2"],
    );
    expect(await invoke("get_chapter_annotations", { chapterId: PART_ONE.id })).toEqual(
      ANNOTATIONS,
    );
  });
});
