import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import App from "../App";
import { installMockBackend, type MockOptions } from "./mockBackend";

/** Renders the whole app against the mocked backend. */
export function renderApp(opts: MockOptions & { fakeTimers?: boolean } = {}) {
  if (opts.fakeTimers) vi.useFakeTimers({ shouldAdvanceTime: true });
  const { calls } = installMockBackend(opts);
  const user = userEvent.setup(opts.fakeTimers ? { advanceTimers: vi.advanceTimersByTime } : {});
  render(<App />);
  const callsTo = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
  return { user, callsTo };
}

export async function search(user: ReturnType<typeof userEvent.setup>, query: string) {
  // "Search your library…", or "Search <title>…" when limited to one book.
  const input = screen.getByPlaceholderText(/^Search .*…$/);
  await user.type(input, query);
  // Scoped to the form: the header also has a "Search" button.
  await user.click(within(input.closest("form")!).getByRole("button", { name: "Search" }));
}

export function resultItems() {
  return Array.from(document.querySelectorAll<HTMLLIElement>(".results li"));
}

export type Section = "Home" | "Books" | "Bookmarks & notes" | "Search";

/** Opens a section from the header, or from its home card when on home. */
export async function goTo(user: ReturnType<typeof userEvent.setup>, section: Section) {
  const nav = screen.queryByRole("navigation", { name: "Sections" });
  if (nav) {
    await user.click(within(nav).getByRole("button", { name: section }));
  } else {
    await user.click(await screen.findByRole("button", { name: new RegExp(`^${section}`) }));
  }
  if (section !== "Home") await screen.findByRole("heading", { level: 1, name: section });
}

function rect(top: number, bottom: number) {
  return {
    top,
    bottom,
    left: 0,
    right: 0,
    width: 0,
    height: bottom - top,
    x: 0,
    y: top,
  } as DOMRect;
}

/** Fakes the layout jsdom lacks: the reader's text area, scrolled as given. */
function layOut(scroll: { top: number; height: number }) {
  const content = document.querySelector<HTMLElement>(".reader-content")!;
  for (const [prop, value] of [
    ["clientHeight", 600],
    ["scrollHeight", scroll.height],
    ["scrollTop", scroll.top],
  ] as const) {
    Object.defineProperty(content, prop, { value, configurable: true, writable: true });
  }
  content.getBoundingClientRect = () => rect(100, 700);
  return content;
}

/**
 * Scrolls the reader so the paragraph `blockId` is at the top of the
 * screen. By hand (the default) it fires `wheel` first, as reading does;
 * otherwise only `scroll`, as the reader's own scrollIntoView does.
 */
export function scrollTo(blockId: number, { byHand = true } = {}) {
  const content = layOut({ top: 1000, height: 100000 });
  const paragraphs = Array.from(content.querySelectorAll<HTMLElement>(".reader-paragraph"));
  const at = paragraphs.findIndex((p) => p.dataset.blockId === String(blockId));
  if (at < 0) throw new Error(`paragraph ${blockId} isn't showing`);
  paragraphs.forEach((p, i) => {
    const top = i < at ? 0 : 100 + (i - at) * 60;
    p.getBoundingClientRect = () => rect(top, top + 50);
  });
  if (byHand) fireEvent.wheel(content);
  fireEvent.scroll(content);
}

/** Scrolls the reader by hand to the end of the chapter showing. */
export function scrollToEnd() {
  const content = layOut({ top: 9400, height: 10000 });
  const paragraphs = Array.from(content.querySelectorAll<HTMLElement>(".reader-paragraph"));
  paragraphs.forEach((p, i) => {
    const top = i < paragraphs.length - 3 ? 0 : 100 + i * 10;
    p.getBoundingClientRect = () => rect(top, top + 50);
  });
  fireEvent.wheel(content);
  fireEvent.scroll(content);
}
