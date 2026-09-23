---
name: ship
description: Verify and commit the current Pitaka work on its feature branch — runs fmt, clippy, tests and tsc, checks the UI in the browser, updates the README, and writes the commit in house style.
disable-model-invocation: true
argument-hint: [optional commit title]
---

Ship the current changes. $ARGUMENTS

1. **Branch.** If on `main`, stop and propose a `feat/<name>` or
   `fix/<name>` branch (matching the plan file name if there is one).
2. **Checks** — run all of these and fix failures before going on:
   - `cargo fmt --all --check`
   - `cargo clippy --workspace --all-targets` (zero warnings)
   - `cargo test -p ebook_research_core`
   - `npx tsc --noEmit`
   - `npm test`
3. **UI check.** If the diff touches `src/`, or a type the frontend
   reads (`src/types.ts`, the structs in `db/`), click through the UI in
   the browser against the mocked backend:
   - Start `npm run dev:mock` in the background (serves on :1430 with the
     fixtures in `src/test/fixtures/library.json` instead of Rust).
   - With the claude-in-chrome tools, open `http://localhost:1430` in a
     new tab and screenshot each step: the library lists 2 books; search
     "quincunx" and open the hit — the paragraph is centred and flashes;
     pick another chapter in the sidebar; "← Library" keeps the query and
     results; tick "Exact words"; remove a book (the mock confirms it).
     Then exercise whatever UI this change adds or alters.
   - Stop the dev server and close the tab.
   - If Chrome isn't connected, say so and treat the UI check as not
     done; don't block the commit on it.
4. **Plan check.** If `docs/plans/` has a plan for this work, compare the
   diff against it and list anything planned but missing, or done
   differently. Ask before committing if there's a gap.
5. **README.** Update in the same commit: "What's actually verified"
   (whether the UI was checked in the browser against the mocked backend,
   and separately whether it was clicked through in the Tauri window —
   say so when either wasn't done), known limitations (renumber if one
   is removed), and tick the roadmap item.
6. **Commit.** Stage only files belonging to this change. Message:
   - imperative, user-facing title, ≤ 72 chars (use the argument if given)
   - blank line, then prose paragraphs wrapped at 72: what was wrong or
     missing and why it matters, then what changed. Mention real books or
     cases that exposed the problem when known.
   - no bullet lists unless enumerating genuinely separate items
7. Report: commit hash, check results, and anything unverified. Don't
   merge or push — the next step is `/pr`.
