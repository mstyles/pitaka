import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DemoBanner from "./DemoBanner";
import { DEMO_BACKUP_ERROR, DEMO_IMPORT_ERROR, demoOptions } from "./demo/installDemo";
import { goTo, renderApp, resultItems, search } from "./test/renderApp";

const BOOK = "Verses of the Senior Nuns";

describe("browser demo", () => {
  it("starts with the Therīgāthā and its seeded folder", async () => {
    renderApp(demoOptions());
    expect(await screen.findByText("1 book")).toBeTruthy();
    expect(screen.getByText("1 folder · 2 passages")).toBeTruthy();
    expect(screen.getByText(BOOK)).toBeTruthy();
  });

  it("links to bug reports from home", async () => {
    renderApp(demoOptions());
    expect(await screen.findByRole("link", { name: "Report a bug" })).toBeTruthy();
  });

  it("searches the book, ignoring diacritics, and opens a hit in the reader", async () => {
    const { user } = renderApp(demoOptions());
    await goTo(user, "Search");
    await search(user, "patacara");
    await waitFor(() => expect(resultItems().length).toBeGreaterThan(0));
    const marks = resultItems()[0].querySelectorAll("mark");
    expect(Array.from(marks, (m) => m.textContent)).toEqual(["Paṭācārā"]);

    await user.click(resultItems()[0]);
    const sidebar = await screen.findByRole("navigation", { name: "Chapters" });
    expect(within(sidebar).getByRole("button", { name: "The Book of the Fives" }).className).toBe(
      "active",
    );
    expect(document.querySelector(".flash")?.textContent).toContain("Paṭācārā");
  });

  it("explains that importing needs the desktop app", async () => {
    const { user } = renderApp(demoOptions());
    await goTo(user, "Books");
    await user.click(screen.getByRole("button", { name: "Import book" }));
    expect(await screen.findByText(`Import failed: ${DEMO_IMPORT_ERROR}`)).toBeTruthy();
  });

  it("explains that backups need the desktop app", async () => {
    const { user } = renderApp(demoOptions());
    await goTo(user, "Books");
    await user.click(screen.getByRole("button", { name: "Back up" }));
    expect(await screen.findByText(`Backup failed: ${DEMO_BACKUP_ERROR}`)).toBeTruthy();
  });

  it("has no chapter search, and says so", async () => {
    const { user, callsTo } = renderApp(demoOptions());
    await goTo(user, "Search");
    await waitFor(() => expect(callsTo("semantic_status")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Chapters" })).toBeNull();
    render(<DemoBanner />);
    expect(screen.getByText(/Chapter search by meaning needs the desktop app/)).toBeTruthy();
  });

  describe("keys", () => {
    beforeEach(() => {
      vi.stubEnv("MODE", "demo");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("lists the shortcuts without the browser's Find and Open", async () => {
      const { user } = renderApp(demoOptions());
      await screen.findByText("1 book");
      await user.keyboard("?");
      const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
      expect(within(sheet).queryByText("Ctrl+F")).toBeNull();
      expect(within(sheet).queryByText("Ctrl+O")).toBeNull();
      expect(within(sheet).queryByText("Ctrl+Shift+O")).toBeNull();
      expect(within(sheet).getByText("Ctrl+1")).toBeTruthy();
    });

    it("leaves Ctrl+F and Ctrl+O to the browser", async () => {
      const { callsTo } = renderApp(demoOptions());
      await screen.findByText("1 book");
      for (const key of ["f", "o"]) {
        const e = new KeyboardEvent("keydown", {
          key,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        });
        document.body.dispatchEvent(e);
        expect(e.defaultPrevented).toBe(false);
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.getByRole("heading", { level: 1, name: "Pitaka" })).toBeTruthy();
      expect(callsTo("plugin:dialog|open")).toEqual([]);
    });
  });

  it("links the banner to the install instructions", () => {
    render(<DemoBanner />);
    const link = screen.getByRole("link", { name: "Get the desktop app →" });
    expect(link.getAttribute("href")).toBe("https://github.com/mstyles/pitaka#install");
  });
});
