import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fixtures } from "./test/mockBackend";
import { goTo, renderApp } from "./test/renderApp";

const TEST_BOOK = "Test Book of Research";
const FOLDER = fixtures.bookmark_folders[0];
const BACKUP = "/backups/old.pitaka";
const FIXTURE_COUNTS = "2 books, 1 bookmark folder, 2 bookmarks, 2 highlights and 2 notes";

function bookRow(title: string) {
  return screen.getByText(title).closest("li")!;
}

describe("backing up", () => {
  it("does nothing when the save dialog is cancelled", async () => {
    const { user, callsTo } = renderApp({ savePath: null });
    await goTo(user, "Books");
    await user.click(screen.getByRole("button", { name: "Back up" }));
    await waitFor(() => expect(callsTo("plugin:dialog|save")).toHaveLength(1));
    expect(callsTo("backup_library")).toEqual([]);
  });

  it("backs up to the chosen file and says what it holds", async () => {
    const { user, callsTo } = renderApp();
    await goTo(user, "Books");
    await user.click(screen.getByRole("button", { name: "Back up" }));
    expect(
      await screen.findByText(`Backed up ${FIXTURE_COUNTS} to /backups/pitaka-backup.pitaka`),
    ).toBeTruthy();
    expect(callsTo("backup_library")).toEqual([{ path: "/backups/pitaka-backup.pitaka" }]);
    const options = callsTo("plugin:dialog|save")[0].options as { defaultPath: string };
    expect(options.defaultPath).toMatch(/^pitaka-backup-\d{4}-\d{2}-\d{2}\.pitaka$/);
  });

  it("shows why a backup failed", async () => {
    const { user } = renderApp({ fail: { backup_library: "couldn't write /backups: disk full" } });
    await goTo(user, "Books");
    await user.click(screen.getByRole("button", { name: "Back up" }));
    expect(
      await screen.findByText("Backup failed: couldn't write /backups: disk full"),
    ).toBeTruthy();
  });
});

describe("restoring", () => {
  it("says what the backup holds before asking to restore it", async () => {
    const { user, callsTo } = renderApp({ openPath: BACKUP, confirm: false });
    await goTo(user, "Books");
    await user.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(callsTo("plugin:dialog|message")).toHaveLength(1));
    expect(callsTo("read_backup_manifest")).toEqual([{ path: BACKUP }]);
    const date = new Date("2026-01-01T00:00:00Z").toLocaleDateString(undefined, {
      dateStyle: "medium",
    });
    const { message, title } = callsTo("plugin:dialog|message")[0];
    expect(title).toBe("Restore backup?");
    expect(message).toBe(
      `old.pitaka was backed up on ${date} by Pitaka 0.0.0-fixture and holds ` +
        `${FIXTURE_COUNTS}. Restoring replaces every book, bookmark folder, highlight and ` +
        `note in Pitaka with these. Your current library is saved first as ` +
        `library-before-restore.pitaka in Pitaka's data folder.`,
    );
    // Declined, so nothing is restored.
    expect(callsTo("restore_library")).toEqual([]);
  });

  it("restores the backup and lists its books", async () => {
    const { user, callsTo } = renderApp({ openPath: BACKUP });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(within(bookRow(TEST_BOOK)).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText(TEST_BOOK)).toBeNull());

    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText(`Restored ${FIXTURE_COUNTS}`)).toBeTruthy();
    expect(callsTo("restore_library")).toEqual([{ path: BACKUP }]);
    expect(await screen.findByText(TEST_BOOK)).toBeTruthy();
  });

  it("refuses a backup from a newer Pitaka without asking", async () => {
    const error =
      "this backup is from a newer version of Pitaka (0.9.0); update the app, then restore it";
    const { user, callsTo } = renderApp({
      openPath: BACKUP,
      fail: { read_backup_manifest: error },
    });
    await goTo(user, "Books");
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText(`Restore failed: ${error}`)).toBeTruthy();
    expect(callsTo("plugin:dialog|message")).toEqual([]);
    expect(callsTo("restore_library")).toEqual([]);
  });

  it("shows the folder list afterwards, not a folder open before", async () => {
    const { user } = renderApp({ openPath: BACKUP });
    await goTo(user, "Bookmarks & notes");
    await user.click(await screen.findByText(FOLDER.name));
    await screen.findByRole("heading", { name: FOLDER.name });

    await goTo(user, "Books");
    await user.click(screen.getByRole("button", { name: "Restore" }));
    await screen.findByText(`Restored ${FIXTURE_COUNTS}`);
    await goTo(user, "Bookmarks & notes");
    expect(screen.queryByRole("heading", { name: FOLDER.name })).toBeNull();
    expect(await screen.findByText(FOLDER.name)).toBeTruthy();
  });

  it("can't restore while a book is queued for indexing", async () => {
    const { user } = renderApp({ semantic: { available: true } });
    await goTo(user, "Books");
    await screen.findByText(TEST_BOOK);
    await user.click(within(bookRow(TEST_BOOK)).getByRole("button", { name: "Index" }));
    await within(bookRow(TEST_BOOK)).findByRole("button", { name: "Queued" });
    const restore = screen.getByRole("button", { name: "Restore" }) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    expect(restore.title).toBe("Stop indexing to restore a backup");
  });

  it("offers Restore on a new install's empty library", async () => {
    const { user, callsTo } = renderApp({ openPath: BACKUP, books: [] });
    await goTo(user, "Books");
    await screen.findByRole("heading", { name: "Your library is empty" });
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText(`Restored ${FIXTURE_COUNTS}`)).toBeTruthy();
    expect(callsTo("restore_library")).toEqual([{ path: BACKUP }]);
    expect(await screen.findByText(TEST_BOOK)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Your library is empty" })).toBeNull();
  });
});
