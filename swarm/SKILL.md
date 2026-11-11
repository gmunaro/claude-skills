---
name: swarm
description: Router and delegation rules. Picks the model (Haiku, Sonnet, Opus, Fable) and effort per task type, sets the method (direct, A/B, ladder, council, devil's advocate, blind review), the parallelism the PC can take and the prompt format, and drives large tasks with many agents (plan with owners, worktrees, integration, verification) and workstreams in threads. Use before launching any subagent (Agent, delegate_task, Workflow), when parallelizing work, when orchestrating a migration, a broad refactor or a SPEC phase, when creating or editing an agent definition, and when the user runs /swarm <task> [; another task].
---

# Swarm

You are the **conductor**: you decide, integrate and verify. The general conductor runs on Fable 5.2 and each workstream on Opus (owner's decision, 2026-11-10). The conversation stays on the model and effort it started on, because switching mid-way invalidates the cache. Only subagents, called **workers** below, change model and effort, as set by the table below. An **oracle** is a command whose result decides the next step, such as a test, a typecheck or a benchmark. When invoked as `/swarm`, the arguments carry one or more tasks, separated by `;` or in a list. To create or edit a file in `.claude/agents/`, read [`agents.md`](agents.md).

## The math that rules

Measured with `node ~/.claude/hooks/telemetria.mjs --resumo` (API-price equivalent):

- **Cost is execution time.** Each turn re-reads the whole context, so a long agent costs more than an agent on an expensive model. On 2026-11-09 and 10 ($597 in subagents): Fable high of 64 min, $15.41 each; `implementer` Sonnet high of 100 min, $3.99; Opus high of 26 min, $3.45; `reviewer` of 6 to 10 min, $0.50 to $0.77; Haiku, $0.02 to $0.06. Fable costs twice Opus on input and output ($8 and $40 per million) and the same on cache reads.
- So: **Sonnet, Opus or Fable subagents only with a short scope**, a ready input packet (the conductor or a Haiku gathers the facts first) and `maxTurns`. Long, exploratory work stays with Haiku. If the expensive model needs a lot of context, the conductor does it directly, because its cache is already warm, as long as the task fits in the current session.
- **The conductor is the biggest cost**: 72% over 30 days (measured on 2026-11-04), in sessions of about 10 h. The session rule is in CLAUDE.md.
- **Whoever integrates spends context.** The worker writes the result to a file and returns one line, in a fixed format with a word cap.
- **Delegate the reading.** More than about 3 files, a long page or a whole log go to a Haiku. Known file or symbol: read it yourself.

## Router

Before launching, classify the task and write one line for the owner, without asking for confirmation: `→ type 8, medium difficulty · implementer · sonnet high · A/B`. Every launch carries explicit `model` and `effort`, except `fork`, which inherits the session's. `general-purpose` and `claude` without `model` inherit the session's model, the most expensive: that is how they became 22% of the cost in the history.

H = Haiku 5.5, S = Sonnet 5.5, O = Opus 5.5, F = Fable 5.2. Cond. = you (the conductor).

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
| 9 | Hard bug | No repro, intermittent, many layers | O high subagent in background, with a packet of what is already known; log reading and bisect with H medium. If Opus fails, F high with the same packet and the rejected output | You move on to the next topic and integrate when it comes back; `/devils-advocate` against the hypothesis before editing |
| 10 | Performance | Latency, memory, FPS | Same as 9; the benchmark is the oracle | `/ab` with a guardrail |
| 11 | Broad refactor, migration, SPEC phase | Dozens of files | Cond. plans and integrates; each slice is type 7 when a codemod or fixed recipe covers all of its files, otherwise type 8 | `/premortem` on the plan; [`conducting.md`](conducting.md) |
| 12 | Plan, architecture, stack | Shapes a lot of code, expensive to undo | Cond. | `/devils-advocate`; `/council` if there are closed options and it is expensive to undo |
| 13 | Diff review | Before integrating or opening a PR | Mechanical: the oracle only. Scoped: `reviewer` S high; O high if the diff came from Opus, from Fable or from the general conductor (the reviewer is never less capable than the author; to judge and review, Opus is enough as a peer of Fable; rule in `/council`). Risk (auth, money, data migration, removal of code or data in use, concurrency): one `reviewer` O high, and `/devils-advocate` attacks the design of the change | `/blind-review` + `/devils-advocate` |
| 14 | Text for humans | PR, report, reply | Cond. | Direct, with `unslop` |
| 15 | Long unattended task | The owner has left; more than 30 min | Cond.; workers by the type of each subtask, in background | The request to leave already authorizes the plan: write the plan and one checkpoint per phase to a file; `delegate_task` if the owner wants to follow along on their phone |
| 16 | Subjective decision | Choice with no oracle | Trivial (name, text, format, team convention): cond. decides. Any other choice among 2 to 4 options with no oracle: `/council` on its own, without asking; full if it is expensive to undo, quick if not | Majority, or ask the owner |
| 17 | SVG art | Create or edit any `.svg` | `svg-artist` (F high), always (owner's decision, 2026-11-10). A session opened before 2026-11-10 does not list this agent: use `general-purpose` with `model: "fable"`, `effort: "high"` | Start from a base (vectorized version, rig or similar piece) and refine: drawing from scratch lost 2 of 2. Local fix with the piece's structure fixed. Accept by blind vote in `/curation` |
| 18 | Skill, CLAUDE.md, agent definition | Create or edit an instruction that other agents will read | F high (owner request, 2026-11-10) | `writing-for-agents`; cheap replay of the old version against the new one before switching; atomic swap with a copy |

**Expensive to undo:** defined in `/council`.

**Difficulty (type 8).** Simple: one file, one obvious way, an existing test. Medium: 2 to 5 files or a local design decision. Hard: shared state, concurrency, many layers, or the simple level already failed. When unsure between two levels, start at the lower one: the ladder goes up.

**Ladder (whenever it fails).** Failing means getting it wrong, getting stuck, or saying "done" without the requested evidence. If only evidence is missing: `SendMessage` asking for the command and its output. Otherwise, in this order, which is the only order (`/ladder` follows it): (1) fix the prompt and relaunch; (2) if it is Haiku medium, move up to Haiku high; (3) split the subtask; (4) move up a model (H high, S high, O high, F high); (5) the conductor does it directly. Nobody goes up to xhigh on the ladder. With no oracle, the failure is whatever the conductor finds when checking; with an oracle, use `/ladder`.

**Effort ceilings.** Never `max` without a request from the owner: in the history, Haiku max spent 3 times the output of high and fell over from compaction. `xhigh` only for a long unattended task. When the owner asks for a given effort, use that effort on the worker the router picks for the task's type, without changing the type or the method because of the request, and state the expected cost in one line.

**Fable x Opus** (Theo's video "Nobody Is Competing With Anthropic", https://youtu.be/yh5IAUow4Hc). Opus is the working default, as Anthropic recommends (https://youtu.be/yh5IAUow4Hc?t=412). Fable comes in where it wins: visual production (SVG, UI), text and instructions for models, hard problems in long runs, and conducting. In analysis, review and judgment it does not beat Opus (https://youtu.be/yh5IAUow4Hc?t=593), costs twice as much per token and spends the subscription limit twice as fast (https://youtu.be/yh5IAUow4Hc?t=1421), so reviewer, advocate and juror stay on Opus. It has more capability, not more autonomy: it decides small things badly and keeps going on them (https://youtu.be/yh5IAUow4Hc?t=2007), hence a closed packet and decisions in the council. On UI, without a design skill it falls back to the generic look (https://youtu.be/yh5IAUow4Hc?t=1971).

**Fable effort.** A starting point, to be calibrated by the scoreboard (only high was measured): `medium` to conduct; `high` for SVG, skill and ladder step, always with a short scope and a ready packet. `xhigh` only with a measured gain. `max` never on code: in Anthropic's benchmarks it scores worse than high on most code tasks (https://youtu.be/yh5IAUow4Hc?t=724); if the owner asks for it, warn about this first. Fable high costs almost the same as Opus xhigh (https://youtu.be/yh5IAUow4Hc?t=773).

**Check the scoreboard.** Before launching a type that has already failed, read the "Lessons" in [`scoreboard.md`](scoreboard.md) with `Read` and `limit: 30`; the log below them is searched with `Grep`. For numbers per model and effort: `node ~/.claude/hooks/telemetria.mjs --resumo --sem-condutor --desde YYYY-MM-DD`.

## Launching

- **Native Agent** by default: cheaper and cached. Use T3 Code's `delegate_task` only for a long task the owner wants to follow on their phone or that needs another provider.
- Launch all independent subtasks in the same message, in background, and carry on with other work until the notification arrives. Do not poll for progress.
- Whoever edits in parallel with another agent goes with `isolation: "worktree"`. Each file has a single owner.
- **The parallelism is the bottleneck's** (owner's rule, 2026-11-09). An agent parked waiting for the PC re-reads the whole context on every waiting turn. Before launching, count what the agents will compete for:
  - **A resource with a counted slot** (Godot, GPU, emulator or device, export): queue. The agent takes its turn with a single call, which blocks until the resource is free (the project's lock script; in Dawnbringer, `godot_slot.sh`), runs in a batch everything that needs that ownership and releases it on exit. A project without a lock script: launch one agent at a time for that resource. Every ownership has a registered owner and a time cap, and the process dies with the turn that launched it. A script that other processes are executing is replaced by atomic substitution (write beside it and `mv`): bash reads the file bit by bit, and editing in place breaks whoever is in the middle.
  - **A dependent track** is only launched after the previous one delivers. Launched together, the ones behind sit waiting.
  - **CPU and RAM:** readers (scout, researcher) up to 40-60; editors in worktrees start at 4, created in sequence, and go up to 16 after a batch of 2 without stalling; heavy checks start at 4-6, with `--maxWorkers=2`, and go up to 12 the same way; 100 in total, summing all levels. Before a large batch of editors or checks, measure (`Get-Counter '\Processor(_Total)\% Processor Time'`, `Get-CimInstance Win32_OperatingSystem | select FreePhysicalMemory`).
  - A timing test that fails on a loaded machine is load until proven otherwise: rerun it with no external load before touching the code.
- **A batch of dozens of identical agents:** first run a wave of 2 or 3, read the tokens in the telemetry and multiply. The measured cost goes into the plan.
- Scope larger than one worker: slice it by area, one worker per slice, each well under 100K of context.
- `general-purpose` carries `model` and `effort` from the table. `reviewer` is always fresh each round, without inheriting the conversation. `fork`, if it exists in the session, inherits the model and the whole context: only for a short task that depends on the current context. To continue with an agent that finished, `SendMessage` to it.

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
- **Verifiable edit:** "Before saying done, run a real check that exercises the change (tests, typecheck, build or the command itself). A syntax-only check does not count. If no check can run, say which one did not run and why. Prove each new test by mutation: undo the fix, watch the test fail, restore, and show both outputs."
- **Haiku on a long task:** "Write the result as you go, one section per Edit. What fills your context is your own reasoning."

## Large task and workstreams in threads

Broad refactor, migration, SPEC phase, or work split across several threads: read [`conducting.md`](conducting.md) before planning. It has the plan with owners, the integration, the verification, the report and what every workstream brief carries.

## A/B and Workflow

- A/B: write the rubric before launching and follow `/ab` (coverage for lists, selection only with an oracle). Everything else, single variant: an LLM judge without verification gains little and has position bias and self-preference bias. For an expensive subjective decision, use `/council`.
- Workflow: when the user asked explicitly (`/swarm`, "ultracode", "use a workflow") and the task has more than ~10 independent pieces or several phases, prefer the `Workflow` tool, loading the `workflow-authoring` skill first. `agent()` accepts `model` and `effort` per call. Use `schema` for compact returns. Intermediate results stay out of your context. Saved workflows live in `~/.claude/workflows/`.

## Verify and close

- No worker's output goes in until you have checked the diff and the last lines of the output of the done command. A subagent saying "finished" is not evidence.
- The fix for a review finding is checked again, by a fresh reviewer or, at the round cap, by you with the finding's command: "resolved" said by the author does not close it (`/blind-review`).
- The task ends when the **definition of done** is observed.
- **Telemetry:** the `SubagentStop` hook writes the model, effort and tokens of every subagent to `~/.claude/telemetria.jsonl`. No need to note it by hand.
- **Scoreboard:** only the integrator writes. One line per A/B, split, escalation or method: `YYYY-MM-DD | subtask | type# | method | model effort | result (passed, failed or escalated to X) | reason`, appended by the shell (`printf '%s\n' '<line>' >> ~/.claude/skills/swarm/scoreboard.md`), without opening the file. A pattern that shows up in 2 or more lines becomes a lesson at the top; with more than 60 lines in the log, the old ones go to `scoreboard-archive.md`.
- **Promoting or demoting** the default for a type requires n ≥ 5 on the same type and a 20-point difference in pass rate, with cost per pass at most 2 times the default's. The change goes to `/council` and becomes a lesson.
