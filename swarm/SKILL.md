---
name: swarm
description: Router and delegation rules. Picks the model (Haiku, Sonnet, Opus) and effort per task type, sets the method (direct, A/B, ladder, council, devil's advocate, blind review), the parallelism limits and the prompt format, and drives large tasks with many agents (plan with owners, worktrees, integration, verification). Use before launching any subagent (Agent, delegate_task, Workflow), when parallelizing work, when orchestrating a migration, a broad refactor or a SPEC phase, when creating or editing an agent definition, and when the user runs /swarm <task> [; another task].
---

# Swarm

You are the **conductor** (the main conversation): you decide, integrate and verify. The main conversation runs on Opus at medium effort and does not switch model or effort mid-task, because that invalidates the cache. Only subagents, called **workers** below, change model and effort, as set by the table below. An **oracle** is a command whose result decides the next step, such as a test, a typecheck or a benchmark. When invoked as `/swarm`, the arguments carry one or more tasks, separated by `;` or in a list. To create or edit a file in `.claude/agents/`, read [`agents.md`](agents.md).

## The math that rules

Measured over the 3,103 subagents in the history (`node ~/.claude/hooks/telemetria.mjs --resumo`, API-price equivalent):

- **An Opus subagent costs 50 to 200 times as much as a Haiku one**: $2 to $14 per agent, versus about $0.06. Opus subagents were 95% of subagent cost. What drives the cost is the cache re-read on every turn of a long run (average 1 h to 2 h), not the output. Opus and Sonnet charge the same for cache reads ($0.20/M), so run length is what makes it expensive.
- So: **Opus or Sonnet subagents only with a short scope**, a ready input packet (the conductor or a Haiku gathers the facts first) and `maxTurns`. Long, exploratory work goes to Haiku. If the expensive model needs a lot of context, the conductor does it directly, because its cache is already warm, as long as the task fits in the current session.
- **The conductor is the biggest cost**: 72% over 30 days, in sessions of about 10 h that re-read the context on every turn. The session rule is in CLAUDE.md. Long reading work goes to a Haiku instead of entering your context.
- **Whoever integrates spends context.** Every report you read enters your context. The worker writes the result to a file and returns one line, in a fixed format with a word cap.
- **Delegate the reading.** If the answer requires reading more than about 3 files, a long page or a whole log, delegate the reading. Known file or symbol: read it yourself.
- **Fits in one pass?** Do it directly. The swarm is for breadth, volume and verification, not for ceremony.

## Router

Before launching, classify the task and write one line for the owner, without asking for confirmation: `→ type 8, medium difficulty · implementer · sonnet high · A/B`. Every launch carries explicit `model` and `effort`, except `fork`, which inherits the session's. `general-purpose` and `claude` without `model` inherit the session's Opus: that is how they became 22% of the cost in the history.

H = Haiku 5.5, S = Sonnet 5.5, O = Opus 5.5. Cond. = you (the conductor).

| # | Type | Signal | Start | Method |
|---|---|---|---|---|
| 1 | One-off lookup | Known target, up to ~3 files | Cond. | Direct |
| 2 | Repo sweep | "Where is X", "who uses Y"; output as `file:line` | `scout` H medium | Single variant; coverage `/ab` when the list decides something |
| 3 | External research | Docs, changelog, price, version, video | `researcher` H medium | Coverage with different sources when it weighs on the decision |
| 4 | Long document digestion | Transcript, log, spec | `researcher` H medium, one per document | Single variant; the conductor checks 3 quotes against the source |
| 5 | Run checks | Typecheck, lint, tests against a definition of done | `auditor` H medium | The command is the oracle; read the last lines |
| 6 | Triage | Label against a closed rubric | `general-purpose` H medium | Rubric + ~10% sample |
| 7 | Mechanical edit | Rename, codemod, fixture, config | `implementer` H medium | Single variant + oracle |
| 8 | Scoped implementation | Small feature or bug with a repro; a test proves it | By difficulty: simple `implementer` H high; medium S high; hard O high | `/ab` when there is more than one plausible way; `/ladder` above the starting point |
| 9 | Hard bug | No repro, intermittent, many layers | O high subagent in background, with a packet of what is already known; log reading and bisect with H medium | You move on to the next topic and integrate when it comes back; `/devils-advocate` against the hypothesis before editing |
| 10 | Performance | Latency, memory, FPS | Same as 9; the benchmark is the oracle | `/ab` with a guardrail |
| 11 | Broad refactor, migration, SPEC phase | Dozens of files | Cond. plans and integrates; each slice is type 7 when a codemod or fixed recipe covers all of its files, otherwise type 8 | `/premortem` on the plan; "Large task" section below |
| 12 | Plan, architecture, stack | Shapes a lot of code, expensive to undo | Cond. | `/devils-advocate`; `/council` if there are closed options and it is expensive to undo |
| 13 | Diff review | Before integrating or opening a PR | Mechanical: the oracle only. Scoped: `reviewer` S high, or O high if the diff came from Opus or from the conductor (the reviewer is never less capable than the author; rule in `/council`). Risk (auth, money, data migration, removal of code or data in use, concurrency): one `reviewer` O high, and `/devils-advocate` attacks the design of the change | `/blind-review` + `/devils-advocate` |
| 14 | Text for humans | PR, report, reply | Cond. | Direct, with `unslop` |
| 15 | Long unattended task | The owner has left; more than 30 min | Cond.; workers by the type of each subtask, in background | The request to leave already authorizes the plan: write the plan and one checkpoint per phase to a file; `delegate_task` if the owner wants to follow along on their phone |
| 16 | Subjective decision | Choice with no oracle | Trivial (name, text, format, team convention): cond. decides. Any other choice among 2 to 4 options with no oracle: `/council` on its own, without asking; full if it is expensive to undo, quick if not | Majority, or ask the owner |

**Expensive to undo:** defined in `/council`.

**Difficulty (type 8).** Simple: one file, one obvious way, an existing test. Medium: 2 to 5 files or a local design decision. Hard: shared state, concurrency, many layers, or the simple level already failed. When unsure between two levels, start at the lower one: the ladder goes up.

**Ladder (whenever it fails).** Failing means getting it wrong, getting stuck, or saying "done" without the requested evidence. If only evidence is missing: `SendMessage` asking for the command and its output. Otherwise, in this order, which is the only order (`/ladder` follows it): (1) fix the prompt and relaunch; (2) if it is Haiku medium, move up to Haiku high; (3) split the subtask; (4) move up a model (H high, S high, O high); (5) the conductor does it directly. Sonnet and Opus do not go up to xhigh on the ladder. With no oracle, the failure is whatever the conductor finds when checking; with an oracle, use `/ladder`. Record it in the scoreboard.

**Effort ceilings.** Never `max` without a request from the owner: in the history, Haiku max spent 3 times the output of high and fell over from compaction. `xhigh` only for a long unattended task. When the owner asks for a given effort, use that effort on the worker the router picks for the task's type, without changing the type or the method because of the request, and state the expected cost in one line. Haiku `low` is not allowed yet: it comes in after calibration.

**Check the scoreboard.** Before launching a type that has already failed, read the "Lessons" in [`scoreboard.md`](scoreboard.md). For numbers per model and effort: `node ~/.claude/hooks/telemetria.mjs --resumo --sem-condutor --desde YYYY-MM-DD`.

## Launching

- **Native Agent** by default: cheaper and cached. Use T3 Code's `delegate_task` only for a long task the owner wants to follow on their phone or that needs another provider.
- Launch all independent subtasks in the same message, in background, and carry on with other work until the notification arrives. Do not poll for progress.
- Whoever edits in parallel with another agent goes with `isolation: "worktree"`. Two subtasks never edit the same file.
- **Parallelism limits on this machine:**
  - readers (scout, researcher): up to 40-60;
  - editors in worktrees: start with 4, created in sequence, and go up to 16 after a batch of 2 without stalling;
  - heavy checks: start with 4-6, with `--maxWorkers=2`, and go up to 12 the same way;
  - dev server: only on request;
  - absolute limit: 100, summing all levels.
  - Before a large batch of editors or checks, measure free CPU and RAM (`Get-Counter '\Processor(_Total)\% Processor Time'`, `Get-CimInstance Win32_OperatingSystem | select FreePhysicalMemory`).
- If the scope is too large for one worker, slice it by area: one worker per slice, each well under 100K tokens of context.

| Work | Launch |
|---|---|
| Find and explain code | `scout` |
| Web, docs, changelogs, videos | `researcher` |
| Run checks against the definition of done | `auditor` |
| Another worker (screenshots, fixtures, edits with a recipe) | `general-purpose` with `model` and `effort` from the table |
| Parallel code | `implementer`, which already runs in a worktree; `model` and `effort` by difficulty |
| Independent review | a fresh `reviewer` each round, without inheriting the conversation |
| Short task that depends on the current context | `fork`, if it exists in the session (it inherits Opus and the whole context, so only for a short task); otherwise `general-purpose` with `model` and a briefing |
| Continue with an agent that finished | `SendMessage` to it |

## Prompt

The subagent does not see the conversation. Fill in this skeleton. The line that changes between the variants of an A/B goes last:

```
Goal: <one sentence>.
Context: <only what it cannot find on its own>.
May read: <...>. May edit: <files, or "nothing">.
Done when: <command or observation>.
Reply in: <format>, up to <N> words. Every claim with file:line, a URL you read, or command output; mark everything else [unverified].
Approach: <angle of this variant>.
```

Add as the work requires:
- **Web research:** "Today is YYYY-MM-DD. Versions, prices and 'the latest' may have changed since your training: search before stating anything. If the premise of the question is false, say so."
- **Verifiable edit:** "Before saying done, run a real check that exercises the change (tests, typecheck, build or the command itself). A syntax-only check does not count. If no check can run, say which one did not run and why."
- **Haiku on a long task:** "Write the result as you go, one section per Edit. What fills your context is your own reasoning."

## Large task (refactor, migration, SPEC phase)

1. **Is it worth it?** If one agent can do it in one pass, do it directly and say so.
2. **Reconnaissance.** 2 to 5 `scout`s in parallel, one per area. External dependency: `researcher`.
3. **Plan with file owners.** Show the plan before executing, unless authorized beforehand. The plan has:
   - independent tasks, each with the files it owns (no overlap), an acceptance criterion and a verification command;
   - what is sequential and what is parallel;
   - the type and model of each task;
   - the stop condition.

   With many steps or an infrastructure change, run `/premortem` on the plan and turn the most likely failures into criteria.
4. **Execution.** One `implementer` per parallel task, all in the same message, each prompt complete and self-contained. Do not change the scope of an agent that is still running: wait, or stop it and relaunch.
5. **Integration.** Bring each worktree into the working branch (merge or cherry-pick) and resolve the conflicts yourself. A conflict means the file-ownership split failed: record it in the scoreboard. After integrating or discarding the diff, remove the worktree (`git worktree remove`).
6. **Verification.** Run in parallel the `auditor` against the criteria and the review per type 13. Fix the blockers, verify again and repeat until clean or until the stop condition.
7. **Report.** What was done; which agents ran, on which model and effort; the commands with their real results; the review findings and what was done with each; and what was not verified. Commit and PR only on request.

## A/B

Write the rubric before launching. Details are in `/ab`.
- **Coverage** (sweep, research, inventory): two or more variants with different angles, in the same list format. Keep the union. Check against the source whatever diverges or weighs on the decision.
- **Selection** (an edit with more than one plausible way): only with an oracle, each variant in its own worktree. The oracle picks and you read only the winner's diff. On a tie, the smaller diff stays.
- **Single variant** for everything else. An LLM judge without verification gains little and has position bias and self-preference bias. For an expensive subjective decision, use `/council`.

## Workflow, for large fan-out

When the user asked explicitly (`/swarm`, "ultracode", "use a workflow") and the task has more than ~10 independent pieces or several phases, prefer the `Workflow` tool, loading the `workflow-authoring` skill first. `agent()` accepts `model` and `effort` per call. Use `schema` for compact returns. Intermediate results stay out of your context. Saved workflows live in `~/.claude/workflows/` (for example, `council`).

## Verify and close

- No worker's output goes in until you have checked the diff and the last lines of the output of the done command. A subagent saying "finished" is not evidence.
- The task ends when the **definition of done** is observed.
- **Telemetry:** the `SubagentStop` hook writes the model, effort and tokens of every subagent to `~/.claude/telemetria.jsonl`. No need to note it by hand.
- **Scoreboard:** only the integrator writes. One line per A/B, split, escalation or method: `YYYY-MM-DD | subtask | type# | method | model effort | result (passed, failed or escalated to X) | reason`. Once the scoreboard has more than 60 lines, condense it into at most 10 lessons at the top and delete the old lines.
- **Promoting or demoting** the default for a type requires n ≥ 5 on the same type and a 20-point difference in pass rate, with cost per pass at most 2 times the default's. You propose and the owner approves. The change becomes a lesson.
