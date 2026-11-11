# Creating or editing an agent definition

Reference for the `swarm` skill, for files in `~/.claude/agents/` or `.claude/agents/` (Claude Code format). Source: https://code.claude.com/docs/en/sub-agents (sections "Supported frontmatter fields", "Available tools" and "Choose a model").

## When a new agent is worth it

A new agent is worth it when the same briefing has already repeated, or will repeat, across 3 or more launches (a recurring task counts): the file body then carries what you would otherwise write every time, and a prompt written by the conductor is the most expensive token on the bill. For a one-off case, use a type that already exists and put the detail in the prompt. The file goes in `~/.claude/agents/` when it serves several repos, and in the repo's `.claude/agents/` when it depends on that repo.

## Frontmatter

```yaml
---
name: short-name
description: <what it does> (<model>). Use for <trigger 1>, <trigger 2>. <what it never does>.
model: haiku            # explicit (haiku, sonnet or opus, per the router table), so it does not inherit the session's model
effort: medium         # explicit; the router passes another at launch when the task calls for it; never max
tools: Read, Grep, Glob, Bash   # allowlist; if omitted, inherits everything
isolation: worktree     # only for agents that edit code in parallel
maxTurns: 40            # optional safety cap; output that hits it is marked as partial
---
```

- **`tools` in background:** a background subagent (the default) keeps only `Read`, `Grep`, `Glob`, `LSP`, `Bash`, `PowerShell`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`, `TodoWrite`, `Skill`, `ToolSearch`, `EnterWorktree`, `ExitWorktree`, `Monitor`, `TaskStop`, `SendMessage` and `Artifact`, plus MCP tools. A tool outside this list disappears without an error. If the list resolves to nothing, the launch fails.
- **`omitClaudeMd: true`** removes CLAUDE.md from the initial context, and with it the user's safety rules (processes, files outside the repo, git). Use it only on an agent that has none of `Bash`, `Edit` or `Write` and receives everything through the prompt. Don't use it to save money: on a Haiku the saving is negligible.
- **`background: true`** forces background even when the conductor asks for foreground.
- **`skills`** injects the full content of each listed skill. List only what the agent uses on every run.
- **`autoCompactWindow`** is an integer (`200000`, not `200k`). **`cacheTtl`** goes inside `experimental:`.
- An unknown field is ignored without an error: check the spelling.

## Body

The body is the agent's system prompt. Write the role in one line, then only the rules that hold on every run:
- the return format and the evidence rule (`file:line`, a URL you read, command output; `[unverified]` on the rest);
- for an agent that edits code, the real-check paragraph from the "Prompt" section of `SKILL.md`;
- the scope limit, stated in the positive.

What changes per run (today's date, files, definition of done) goes in the launch prompt, not in the body.

## After creating it

- A new agents directory is only read after Claude Code restarts. A new file in an existing directory shows up without a restart.
- Launch the agent once with a trivial task and check in `/tasks` that it ran on the expected model: a model blocked by the organization is swapped for another, and the warning only appears in an interactive session.
- A user agent named `Explore` replaces the built-in one and keeps its own `model`. This is how to make Claude Code's automatic exploration run on Haiku.
