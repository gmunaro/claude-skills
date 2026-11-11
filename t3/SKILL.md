---
name: t3
description: Diagnose which phase the current project is in using Theo's (t3.gg) methodology and suggest the next step, how to split the work between Opus and Haiku, what to adjust in the structure, and ready-to-paste prompts. Read-only. Use when the user asks for /t3, "next step", "what do I do now", "where do I go from here", "how should I structure this project", "how should I use the models here", "give me the prompts", or when a phase just finished and what comes next must be decided.
---

# /t3: next step by Theo's methodology

Read-only: **don't edit, don't install, don't commit.** The output is a diagnosis with prompts; a new thread does the executing.

## 1. Read the state (quickly)
Read these yourself, in parallel:
- `CLAUDE.md` / `AGENTS.md` / `CLAUDE.local.md`, `README`, `docs/SPEC.md` (or equivalent), `package.json` (scripts and `packageManager`), CI config (`.github/workflows/`).
- `git status`, `git log --oneline -15`, branches and worktrees (`git worktree list`).
- Open PRs: `gh pr list` (if there is a GitHub remote).

Large or unfamiliar repo: one `scout` (Haiku) per area to build the folder map. Don't read all the code.

## 2. Classify the phase
Pick **the first** row that applies. It is a ladder: don't skip rungs.

| # | Signal | Phase | Next step |
|---|---|---|---|
| 1 | There is no SPEC and no clear idea of the MVP | Idea | Interview and SPEC (`new-project`; `grilling` to stress-test the plan) |
| 2 | There is a SPEC but no code, or the scaffold doesn't run | Scaffold | Generate the project with the default stack and get install/typecheck/lint/test/build passing |
| 3 | There are no verification commands (typecheck, lint, test), or they fail, or there is no CI | Verification loop | Build the loop before any feature: scripts in `package.json`, one real test, CI that fails on regression, an app that runs locally |
| 4 | There is no project `CLAUDE.md`, or it is bloated (behavior rules, history, things the model already does well) | Context | Short CLAUDE.md: identity, non-negotiables, glossary, commands, verification, folder map, "things the model gets wrong", taste |
| 5 | There is an open PR with red CI or pending comments | PR | `babysit-pr` before starting anything else |
| 6 | Large uncommitted changes, or several tasks mixed in the tree | Hygiene | Split into commits/PRs per task; one task per thread from here on |
| 7 | The loop works and the SPEC has pending slices | Build | Next SPEC slice, the smallest one that delivers verifiable value |
| 8 | The slice touches many independent areas | Parallel build | `swarm` ("Large task" section) with a file owner per task, one worktree per task |
| 9 | The agent repeats the same mistakes across threads | Tuning | `audit-history`, and move the failures into CLAUDE.md |

If nothing applies, the project is up to date: say so and suggest the next SPEC slice.

## 3. Principles that guide the recommendation
- **Verification over review.** The agent proves by running (tests, app, screenshot), not by reading code. Every gain becomes a CI guardrail.
- **Loop before parallelizing.** Only parallelize after a single thread delivers with verification.
- **One task per thread.** Each thread is a new dev with no history: the repo has to explain itself. Instead of pasting context, say where it is.
- **Minimal context that grows by failure.** Start with little and add to CLAUDE.md only what actually broke.
- **Simple first.** No machinery that looks like architecture.

## 4. Models
Use the routing table in the `swarm` skill: it sets model, effort and method per task type. For this diagnosis, cite the table's type and the agent for each step. The main conversation stays on Opus medium; an Opus or Sonnet subagent only with a short scope, because its cost comes from context re-read over long runs.

## 5. Response format (pt-BR)
1. **Phase:** one line, with the evidence that defines it (file, command, absence).
2. **Next step:** just one, and why. If there is a blocker only the owner can resolve (account, product decision), say so.
3. **Structure:** only what is missing for this step, in short items. Nothing if nothing is missing.
4. **Models:** who does what in this step (short table or 2–3 lines).
5. **Prompts:** 1 to 3 ready-to-paste blocks, **one per new thread**, in the format below.
6. **After that:** in one line, what the following step will probably be.

### Format of each prompt
Short, problem and not solution, with a verifiable "done". In pt-BR, the way the owner dictates:

```
<Goal in 1–2 sentences: the problem and for whom.>

Context: <where the information is: files, SPEC section X, issue/PR #N. Don't paste content.>

Done when:
- <observable criterion 1>
- <observable criterion 2>

Verification: <exact commands and/or how to prove it by running the app>.
Out of scope: <what not to touch>.
<Optional: "Use scouts (Haiku) to map X before planning." / "Use /effort xhigh.">
Give me short updates and a final summary with what was verified and what wasn't.
```

Don't execute the next step. End by asking whether the owner wants you to start it here or in a new thread.
