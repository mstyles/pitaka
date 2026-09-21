---
name: ship
description: Verify and commit the current Pitaka work on its feature branch — runs fmt, clippy, tests and tsc, updates the README, and writes the commit in house style.
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
3. **Plan check.** If `docs/plans/` has a plan for this work, compare the
   diff against it and list anything planned but missing, or done
   differently. Ask before committing if there's a gap.
4. **README.** Update in the same commit: "What's actually verified"
   (including whether the UI was clicked through — say it wasn't if you
   didn't do it), known limitations (renumber if one is removed), and tick
   the roadmap item.
5. **Commit.** Stage only files belonging to this change. Message:
   - imperative, user-facing title, ≤ 72 chars (use the argument if given)
   - blank line, then prose paragraphs wrapped at 72: what was wrong or
     missing and why it matters, then what changed. Mention real books or
     cases that exposed the problem when known.
   - no bullet lists unless enumerating genuinely separate items
6. Report: commit hash, check results, and anything unverified. Don't
   merge or push.
