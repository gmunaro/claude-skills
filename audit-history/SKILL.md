---
name: audit-history
description: Audit the Claude Code session history to find recurring agent failures and propose rules for CLAUDE.md. Use when the user asks to improve/update CLAUDE.md or AGENTS.md, review the history, find the "mistakes the agent always makes" or evolve its instructions.
---

# Audit history → CLAUDE.md rules

Theo's method: a good CLAUDE.md comes from **your own** real failures, not from templates.

1. Sessions live in `C:/Users/MunaroPC/.claude/projects/<project>/*.jsonl` (one file per session; they are large). List them with date and size and limit the scope (e.g. last 2 weeks, project X).
2. Split the files among `researcher` agents (Haiku), in parallel, 3 to 6 sessions per agent. Each one looks for:
   - corrections from the owner ("no", "stop", "wrong", "I didn't ask for that", "again");
   - killed processes, dev servers, unrequested edits and scope creep;
   - "done" without verification, draft PRs, stopping early and wrong use of tools.
   Each finding comes with the session, a short excerpt and a category. The `.jsonl` files are read in chunks and **never** edited.
3. Consolidate (you, Opus): a table of category → frequency → example → proposed rule (one sentence, actionable). Discard anything that happens only once.
4. Show the proposed diff for `C:/Users/MunaroPC/.t3/projects/setupt3code/claude/CLAUDE.md` (the versioned source; then run `scripts/install.ps1`) or for the project's CLAUDE.md, if the rule is specific to it. **Apply only with approval.**
5. A rule that must always hold (e.g. never kill a given process) works better as a permission/hook in `settings.json`. Suggest that instead of more text.
