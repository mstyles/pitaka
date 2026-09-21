import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom doesn't lay out pages, so it has no scrollIntoView; ReaderView calls
// it to centre a search hit.
Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  cleanup();
  clearMocks();
  vi.useRealTimers();
  vi.clearAllMocks();
});
