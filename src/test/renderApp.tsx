import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import App from "../App";
import { installMockBackend, type MockOptions } from "./mockBackend";

/** Renders the whole app against the mocked backend. */
export function renderApp(opts: MockOptions & { fakeTimers?: boolean } = {}) {
  if (opts.fakeTimers) vi.useFakeTimers({ shouldAdvanceTime: true });
  const { calls } = installMockBackend(opts);
  const user = userEvent.setup(
    opts.fakeTimers ? { advanceTimers: vi.advanceTimersByTime } : {},
  );
  render(<App />);
  const callsTo = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
  return { user, callsTo };
}

export async function search(user: ReturnType<typeof userEvent.setup>, query: string) {
  const input = screen.getByPlaceholderText("Search your library…");
  await user.type(input, query);
  // Scoped to the form: the header also has a "Search" button.
  await user.click(within(input.closest("form")!).getByRole("button", { name: "Search" }));
}

export function resultItems() {
  return Array.from(document.querySelectorAll<HTMLLIElement>(".results li"));
}

export type Section = "Home" | "Books" | "Bookmarks" | "Search";

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
