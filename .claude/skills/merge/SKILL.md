---
name: merge
description: Merge a reviewed Pitaka pull request into main with --no-ff and the house merge message (commit titles only), closing the PR.
disable-model-invocation: true
argument-hint: [branch or PR number, defaults to current branch]
---

Merge: $ARGUMENTS (default: the current branch). Only run this after the
user has reviewed the PR opened by `/pr`.

1. Find the PR with `gh pr view <arg> --json number,state,headRefName,url`.
   Stop if there's no open PR (suggest `/pr`). Use its `headRefName` as
   the branch.
2. Confirm the working tree is clean. `git fetch origin` and check the
   local branch matches `origin/<branch>`; if the PR has commits you
   don't have locally (e.g. from review fixes), pull them first.
3. Check CI with `gh pr checks <number>`. Stop if a check failed or is
   still pending, and say which.
4. Run `cargo clippy --workspace --all-targets`, `cargo test -p
   ebook_research_core`, `npx tsc --noEmit` and `npm test` on the branch.
   Stop if any fail.
5. Build the message — titles only, never commit bodies, oldest first:

   ```
   git log --reverse --no-merges --format='* %s' main..<branch>
   ```

   Subject: `Merge branch '<branch>'`, blank line, then that list.
6. `git switch main`, `git pull --ff-only`, then `git merge --no-ff
   <branch> -F <msgfile>`. If the merge conflicts, stop and show the
   conflicts rather than resolving them silently.
7. `git push origin main`. GitHub marks the PR as merged once the branch
   commits are on `main`; confirm with `gh pr view <number> --json state`.
8. Show `git log --oneline -3`. Ask before deleting the branch locally or
   on the remote.
