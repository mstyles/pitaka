// Wires the mocked backend to the demo's one real book and its TypeScript
// search, for `npm run dev:demo` / `build:demo` and `Demo.test.tsx`.
import { installMockBackend, type Fixtures, type MockOptions } from "../test/mockBackend";
import type { ChapterContent } from "../types";
import data from "./library.json";
import { createSearch } from "./search";

export const DEMO_IMPORT_ERROR =
  "Importing your own EPUBs needs the desktop app. This demo has one book built in.";

/** Mock backend options that serve the demo book. */
export function demoOptions(): MockOptions {
  return {
    data: data as Fixtures,
    search: createSearch(Object.values(data.chapter_content) as ChapterContent[]),
    importError: DEMO_IMPORT_ERROR,
    // The file picker "succeeds" so the import error is shown, not a cancel.
    openPath: "/your-book.epub",
  };
}

export function installDemoBackend() {
  return installMockBackend(demoOptions());
}
