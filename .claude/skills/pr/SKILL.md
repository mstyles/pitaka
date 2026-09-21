---
name: pr
description: Push a shipped Pitaka feature/fix branch and open a GitHub pull request for the user to review, instead of merging it.
disable-model-invocation: true
argument-hint: [branch, defaults to current]
---

Open a PR for branch: $ARGUMENTS (default: the current branch).

1. Confirm the working tree is clean, the branch isn't `main`, and it has
   commits ahead of `main` (`git log main..<branch>`). If there are
   uncommitted changes, stop and suggest `/ship` first.
2. Run `cargo clippy --workspace --all-targets`, `cargo test -p
   ebook_research_core` and `npx tsc --noEmit` on the branch. Stop if any
   fail.
3. If `gh pr view <branch>` finds an open PR already, push any new commits
   and show its URL instead of opening a second one.
4. `git push -u origin <branch>` (never force-push).
5. Write the PR body to a file in the scratchpad:
   - **Title:** the commit title if the branch has one commit; otherwise
     an imperative, user-facing title for the whole change (≤ 72 chars).
   - **Body:**
     - A short prose summary: what was wrong or missing and what changed.
     - `Plan: docs/plans/<name>.md` if the work has a plan, and anything
       done differently from it.
     - `## Commits`: one `* <title>` line per commit, oldest first, from
       `git log --reverse --no-merges --format='* %s' main..<branch>`.
     - `## Verification`: which checks passed, and what wasn't verified
       (e.g. "UI not clicked through in the Tauri window").
6. `gh pr create --base main --head <branch> --title <title> --body-file
   <file>`.
7. Report the PR URL and `gh pr checks <branch>` (CI may still be
   running). Don't merge: once the user has reviewed it, they run
   `/merge`.
