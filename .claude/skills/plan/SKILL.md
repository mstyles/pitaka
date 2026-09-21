---
name: plan
description: Write an implementation plan for a Pitaka feature or fix in docs/plans/, in the project's house style. Use when asked to plan, design or scope a change before building it.
argument-hint: <feature or roadmap item>
---

Plan: $ARGUMENTS

## Research first

- Read README.md (limitations, roadmap) and the code the change touches.
  Name real files, functions, tables and columns — no placeholders.
- Check claims you'll rely on instead of assuming them: SQLite behaviour
  (cascades, triggers, FTS5) in `sqlite3` against the migrations, parser
  behaviour with a quick unit test or a real EPUB. Say in the plan what was
  checked and how.
- If a design choice is genuinely the user's call, ask before writing.

## Write `docs/plans/<kebab-name>.md`

Follow the shape of the existing plans (see `docs/plans/delete-book.md`):

- `# <Title>`
- `## Context` — the problem in user terms, which README limitation or
  roadmap item it addresses, what's out of scope, and alternatives ruled
  out with the reason.
- `## 1. <Area>: \`file.rs\`, \`other.rs\`` … one numbered section per
  layer, in build order: core (`epub.rs`/`db.rs`/migrations), Tauri
  command (`commands.rs`, `generate_handler!`), frontend (`types.ts`,
  views, `App.css`). Give signatures, SQL, error messages and UI copy.
- A final numbered tests section: which `#[cfg(test)]` unit tests and
  `tests/integration.rs` cases, with the exact assertions.
- A README section: which limitation/roadmap/"What's actually verified"
  lines change.

Keep it prose-dense and concrete; one line per decision.

## Finish

Show the user a short summary and ask for approval or changes. Once they
approve, commit only the plan file on `main` as "Add <feature> plan".
Don't start implementing until asked.
