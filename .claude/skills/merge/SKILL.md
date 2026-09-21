---
name: merge
description: Merge a finished Pitaka feature/fix branch into main with --no-ff and the house merge message (commit titles only).
disable-model-invocation: true
argument-hint: [branch, defaults to current]
---

Merge branch: $ARGUMENTS (default: the current branch).

1. Confirm the working tree is clean and the branch isn't `main`.
2. Run `cargo clippy --workspace --all-targets`, `cargo test -p
   ebook_research_core` and `npx tsc --noEmit` on the branch. Stop if any
   fail.
3. Build the message — titles only, never commit bodies, oldest first:

   ```
   git log --reverse --no-merges --format='* %s' main..<branch>
   ```

   Subject: `Merge branch '<branch>'`, blank line, then that list.
4. `git switch main` and `git merge --no-ff <branch> -F <msgfile>`. If
   `main` has moved and the merge conflicts, stop and show the conflicts
   rather than resolving them silently.
5. Show `git log --oneline -3`. Ask before deleting the branch or pushing.
