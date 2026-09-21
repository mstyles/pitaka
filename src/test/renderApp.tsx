import { render, screen } from "@testing-library/react";
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
  await user.type(screen.getByPlaceholderText("Search your library…"), query);
  await user.click(screen.getByRole("button", { name: "Search" }));
}

export function resultItems() {
  return Array.from(document.querySelectorAll<HTMLLIElement>(".results li"));
}
