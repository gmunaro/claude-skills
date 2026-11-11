---
name: open-pr
description: Open a concise pull request. Use when the user asks to open, create, push up, send or "queue" a PR / pull request.
---

# Open PR

Prerequisite: `gh auth status` must show a logged-in account. If it doesn't, ask the owner to run `gh auth login`.

1. Check the branch. If you are on the default branch (main/master), create a descriptively named branch first.
2. Review the whole diff (`git diff <base>...HEAD` plus whatever is not committed yet). If there are changes outside the goal, ask before including them.
3. Verify narrowly: typecheck, lint and tests for the files touched. Write down the real results.
4. Title in the repo's style (see `git log`). If the repo uses conventional commits, follow them: `fix(web): ...`. The title explains **why**, not which files changed.
5. Description:
   - **Problem**: what the user was experiencing, in 1 to 3 sentences.
   - **Solution**: the idea behind the fix, without an inventory of the implementation.
   - **Verification**: the commands that were run with their results, and what was not verified.
   - Last line: model and harness (e.g. "Made with Claude Opus 5.5 via Claude Code").
6. `gh pr create` as a **regular PR, never a draft** (drafts don't trigger the review bots), unless the owner asks for a draft.
7. Return the URL. If the harness has a tool for linking PRs to the thread, link it.
