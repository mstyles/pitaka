import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom doesn't lay out pages, so it has no scrollIntoView; ReaderView calls
// it to centre a search hit.
Element.prototype.scrollIntoView = vi.fn();

afterEach(async () => {
  cleanup();
  // Unmounting stops event listeners through a promise, which needs the
  // mocked IPC still in place when it settles.
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
  vi.useRealTimers();
  vi.clearAllMocks();
});
