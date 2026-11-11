---
name: council
description: Council for decisions between 2 and 4 options with no oracle, and for hill-climb refinement. Checks whether the request defines a scoreable loop; if it doesn't, agrees on a measurable hill climb with the owner before working on the actual problem. Uses free models plus Claude models whose access is proven, with verified indexes and subagents visible in T3. Use on /council, council free, score-based evaluation, non-trivial subjective choices with no oracle, or to find out whether an outsider understands an artifact (cold reader).
---

# Council

The council judges one shared packet with isolated reviews. The conductor (the main conversation) gathers evidence, verifies the findings and integrates the fixes. The main conversation keeps the model the owner chose, paid or not. For council participants, use only free models and Claude models with access proven by a real call: a subscription, or organization credit the owner authorized.

## 1. Triage before running

Every run of the skill starts here, before any packet, plan or dispatch. Classify the request into one of four routes and record the route with the reason:

- **Decision**: a one-off choice between 2 and 4 options with no oracle (a command whose result decides the answer). Goes to "Decision council".
- **Fact or oracle**: a verifiable fact goes to the source; a change with a decisive test uses the test. The council does not run.
- **Comprehension**: the question is whether an outsider understands the artifact or can act on it (post, store listing, screen, tutorial). Read [cold-reader.md](cold-reader.md) and follow it; the council and the hill climb do not run. A juror's score does not measure this, and a juror that received the project context is no longer an outsider.
- **Hill climb**: improve an artifact through scored rounds. Follow the triage below.

Read [hill-climb.md](hill-climb.md) before any score-based refinement. Record: observable goal, editable artifact, input and scope, rubric with anchors, repeatable evaluation, oracles, budget/stop, and comparison/history.

- All defined and consistent with the request: `HILLCLIMB_CLEAR`. Freeze the protocol and go to `RUN_HC`.
- Any of them missing: `HILLCLIMB_UNDEFINED`. Go to `REFINE_DEFINITION`. The artifact to improve is now the hill-climb protocol, not the original problem.
- A required fact, access, or authorization for an external action is missing, or the scope contains an unresolvable contradiction: `BLOCKED`. Name the blocker without inventing information.

The lineup (the models that take part), weights, quorum and scale that the request doesn't mention follow the defaults in sections 4 and 5. Omitting them is not a gap. A gap is something the skill cannot fill in itself: goal, artifact, cases, rubric, oracle, budget or comparison.

This triage `BLOCKED` is about the request. Lacking the infrastructure to dispatch the council right now (proxy, credential, execution tool) does not change the triage state. Record the triage state (`REFINE_DEFINITION` or `RUN_HC`) and, separately, the operational blocker and the next step.

`BLOCKED` also applies in the decision council, under the rules of that section. A request with a directly verifiable answer stays on the fact-or-oracle route.

Record where each field came from. If the request was undefined and the conductor just proposed the goal, metrics or criteria, that first complete proposal still belongs to `REFINE_DEFINITION`. Don't reclassify it as approved just because the fields are filled in; the proposed definition needs approval (section 2) before the main loop.

Run `node <skill-folder>/scripts/hill-climb-gate.mjs triage.json` to record the gate. It checks the origin, completeness, depth, budget and, when there is a proposal, approval tied to the current hash plus the definition checks. The gate checks the evidence the conductor declares; it does not replace the council's quality evaluation.

## Visible progress

Every message to the owner while the skill runs opens with the progress panel (owner request, 2026-11-07):

1. **Steps.** A table with the route's steps and the state of each: `done`, `in progress` (in bold) or `pending`. Decision: triage, packet, round, count, report. Hill climb: triage, definition with the owner, feasibility, round N, reverification, validation.
2. **Plan.** The next step and what remains until the exit point.
3. **Results.** The numbers measured so far: valid and discarded reviews, weight, scores, oracles, winner.
4. **Changes.** What changed in the artifact, the plan or the lineup since the previous message, with the reason.

Each item cites the number or file that backs it. A step becomes `done` only with evidence for its done criterion.

## Decision council

### When

- **Runs on its own:** when the 2 to 4 options each fit in one sentence, no command decides which is right, and the choice is not trivial. Don't ask the owner whether you may run it: run it and show the result.
- **Don't wait on the owner (2026-11-05).** The only question the skill allows to the owner is the definition of an undefined hill climb (section 2). A "for the owner to decide" point returned by a plan or a subagent is not an exception: every point with options goes to the council, a fact goes to the source, and whatever the process already settles is stated and moved on. When you ask a subagent to list doubts, ask for "open decisions, each with 2 to 4 options". The owner is awaited only for a credential, a captcha, an irreversible external action outside the plan, or `divergence`.
- **Outside the council:** a verifiable fact goes to the source or a command; a question with an oracle uses the oracle (`/ab`, `/ladder`); an open question gets its options closed first; a trivial choice (name, text, format) the conductor decides.
- **Mode:** `full` when the decision is expensive to undo; `quick` otherwise. Both use the same lineup; `quick` only shortens the packet and the review. The owner can ask for either.
- **Expensive to undo:** touches production data, a public contract or a paid vendor, or reverting costs more than ~1 day of rework.
- **Conflict:** if the conductor authored one of the options, a Haiku builds the evidence from the facts, without knowing which option is the conductor's.

### Steps

1. **Packet.** Write `input.json` with `{ question, options: [{ id: "A", text }], categories, evidence, mode }`. The evidence holds the facts and excerpts everyone will read; if facts are missing, a Haiku `scout` or `researcher` gathers them first. Run `node <skill-folder>/scripts/council-t3.mjs decision-packet --input input.json --out packet.txt`. It writes one rotation per option (`packet.txt`, `packet.r1.txt`, ...): the same list starting at a different option, so the first position isn't favored. The `prompt` field of the output is the list for `prepare`.
   **Check the packet.** Run `node <skill-folder>/scripts/lint-packet.mjs --packet <file> --sections "## Options,## Evidence,## How to respond" --no-rubric` on every rotation and read the packet for contradictions: the same number, cap, deadline or fact with two values, or a cited field that doesn't exist. If the lint fails or there is a contradiction, the packet doesn't go out: fix the input and generate again.
   **Packet that arrived ready-made.** To close a round whose packet was not generated and checked in this session, do the same check before counting. An evaluation packet (with `## User requirements`) uses the lint's default sections, without `--no-rubric`. If the packet has a defect, the whole round is invalid, because every review judged an ambiguous question. Don't count the votes and don't report a count as a result. End in `BLOCKED`, name the defect, and say the packet and the round must be redone.
   **No way to dispatch.** If there is no proxy, credential or execution tool and no review was collected, end in `BLOCKED` and list each blocker with its evidence. `insufficient` is reserved for a round that actually collected reviews.
2. **Run.** `prepare --phase decision --prompt packet.txt,packet.r1.txt,... --output new-folder` (the rotations are used round-robin across the calls), then `pending`, `delegate_task` in parallel, and `register`, with the lineup, deadline and concurrency from section 4. Collect with `collect --plan new-folder/plan-t3.json --options A,B --categories ...`; on each notification, run `register` and then `cycle` (it takes the same flags as `collect`), which collects and lists the next wave, and dispatch what it returns, until `ready_for_analysis`. Once the reviews that matter have arrived (all the Claude ones and the wave in progress), close with `close` instead of waiting for the free-model waves.
3. **Count.** `node <skill-folder>/scripts/tally.mjs --plan new-folder/plan-t3.json --options A,B` writes `decision.json`. Each vote's weight follows the three levels in section 5, and `tally.mjs` already applies them: a model with no published index and no estimate votes at floor weight. It does not stay advisory, and it does not make the round `insufficient` by itself. Quorum (owner rule, 2026-11-07): anyone who didn't answer, timed out, failed or was canceled is left out of the count entirely. An answer that didn't follow the format is not counted as a vote, but its weight stays in the quorum denominator. The round passes with at least two distinct models with a published index among the valid votes, and with the valid weight at least two thirds of the weight of everyone who answered (valid plus out-of-format). No fraction of the planned participants is required. The output lists in `discarded` how many were left out and why (`off_format`, `timeout`, `failed`, `canceled`, `not_dispatched`), for the record only. With quorum, an option with two thirds of the valid weight decides; if the `X` option ("a fact is missing") gets one third, the result is `missing_fact`; anything else is `divergence`.
4. **Read the result.** Only `decision` has a `choice`. In `divergence`, `missing_fact` and `insufficient`, the choice stays empty and `top_voted` is a recommendation, not a decision:
   - `decision`: proceed with the `choice`. Show the count in one line and the minority's reasons that bring verifiable evidence.
   - `divergence`: ask the owner, with each side's `best_argument` and the `top_voted` as the recommended option.
   - `missing_fact`: look up the fact in `best_argument.X.missing` and run again, once.
   - `insufficient`: say how many reviews came back and the `reasons`, and decide with the owner.
5. **Record.** Show the round table (section 6), with vote, weight and weight level. Add a line to the `swarm` scoreboard with method `council-<mode>`, the count and the result, written by the shell as `swarm` describes, without opening the file.

After an expensive `decision`, run `/devils-advocate` against the chosen option.

### The judge is no less capable than the producer

Every model's work is judged by at least one model of the same level or above (Haiku < Sonnet < Opus; for judging and reviewing, Fable counts as Opus); the conductor counts as the model it runs on. For judging and reviewing, Opus is enough as Fable's peer: Fable produces better on ambitious and visual tasks, but in analysis and review it came out below Opus and Sonnet on Theo's benchmark (https://youtu.be/yh5IAUow4Hc?t=593). The default Claude lineup already includes Opus, so a piece from Fable (the general conductor's proposal, SVG, a rewrite in a hill climb) needs no Fable juror. In a hand-built council, include a voter at the level of the judged piece's author or above (a Fable piece: an Opus). In a hill climb, whoever rewrites doesn't use a model above the strongest juror. In code review, the `reviewer` has the author's model or above. Cheaper jurors join in, but they don't close the decision alone on a stronger model's work. Free models don't earn level equivalence by name.

## 2. When the definition needs a hill climb

In `REFINE_DEFINITION`, the conductor and the owner define together a measurable hill climb that solves the proposed problem (owner request, 2026-11-07). Follow the steps in order:

1. **Draft.** Fill in the eight triage fields with what the request, the repository and the commands already show. Mark each field `given` (came from the owner), `derived` (came from a fact, with the evidence) or `proposed` (the conductor's suggestion). The **measurement** can be anything that gives the same kind of number for every version: a test, a script, a benchmark, a count, or the council's judgment with an anchored rubric over text or image. Prefer what runs by itself; for comprehension, the cold reader; use the council when quality can only be judged by reading or seeing. Done when no field is empty without a mark.
2. **Ask.** Use `AskUserQuestion` for every `proposed` field that fixes the target: observable goal, metric or oracle, and budget or stop. Each question carries 2 to 4 concrete, measurable options taken from the draft, with the recommended one first and marked "(Recommended)". Group up to four questions in one call. Routine fields (lineup, weights, quorum, scale) follow the defaults in sections 4 and 5 and don't become questions. Done when every field that fixes the target is `given` or `derived`.
3. **Confirm.** Write `protocol.json` with the eight fields, the approval criterion and the condition for returning to the problem, compute the SHA-256, and show the owner a summary of up to 8 lines in one last question: approve, or adjust a named field. An adjustment goes back to step 2 at the same meta level 1. Approval becomes `approval: { by: "owner", accepted: true, protocolHash }` in `triage.json`.
4. **Feasibility.** The hill climb starts only if it has everything it needs to work. Measure the current artifact (baseline) with the protocol's measurement and check each item:
   - the measurement ran and produced a number; a council-based measurement has a packet whose lint passes and a cheap Haiku dry run that points out no missing material;
   - the baseline has at least one category with a gap pointed out, so there is something to attack;
   - the editable artifact is accessible and each round fits the budget;
   - the exit point (cap of 3 rounds or on cost, section 6) and the checkpoint after round 2 are written in the protocol.
   If all pass: set `definitionChecksPassed: true`, run `hill-climb-gate.mjs`, and go to `RUN_HC` only with `main_loop_allowed: true`. If any fails: go back to step 2 with the failed item, still at meta level 1.
5. **Run.** Run the section 3 loop until the exit point or the reverification point. At the reverification point, compare with the previous checkpoint and then continue, adjust the method or stop, recording the decision.

Image judging: the packet cites the absolute path of each image and the task says to open it with the read tool. Prepare with `prepare --image-input`, which leaves in the lineup only the free models with image input in the catalog; Claude reads images.

With no human in the conversation (the skill runs inside a subagent or a scheduled task), the council approves the definition in place of step 3: it evaluates only the protocol, using the root rubric (clarity, measurability, fidelity to the request, executability and closure), takes the corrections to the agreement vote, and applies the approved ones (7 to 10). The approval is recorded as `by: "council"`.

While the definition isn't approved, keep `main_loop_allowed=false`: you may research and refine the protocol, but not run the original problem's loop. Use a single meta level (a hill climb on the protocol, not on the original problem) and up to three definition rounds (questions or reviews). A definition that is still incomplete goes back to `REFINE_DEFINITION`, with no meta-meta hill climb. If the cap is reached without approval, or the owner can't supply the missing fact, end `BLOCKED` with the draft and the gaps. A definition that doesn't close in three rounds means a score doesn't measure that goal (it happened in 3 of 3 blocked definitions): swap the measurement for an oracle, a cold reader or a blind decision between versions, instead of asking for more rounds.

## 3. Loop over the artifact

1. Freeze baseline, inputs, sources, rubric, lineup and execution controls before any scores.
2. Send everyone the same packet, with no conductor preference, no authorship of the proposals, no earlier results and no cutoff from the current round.
3. Validate each review. A category score is 1 to 10; `gap` holds text and uses `nothing` only with 10. Preserve the raw response. Invalid JSON, truncation and unavailability are failures, not a zero score.
4. Before fixing, consolidate the correction points into a list of items and take it to an agreement vote (section "Agreement vote"). Only items with weighted agreement of 7 to 10 enter the fix. Check those items against the contract, the source and the tests; record false premises and the reasons for disagreement. Don't discard a low score just because you disagree with it.
5. Whoever owns the revision receives the problems found, not the score needed to pass. Each round attacks the lowest-scoring category with a local fix, keeping the artifact's structure: changing the structure to answer a critique lost 2 of 2 in the blind vote. Return `resolved` for each point: a fix, evidence, a reasoned not-applicable, or a pending item.
6. Run the narrow oracles and the regression. A high score never makes up for a failing mandatory test.
7. Accept the new version by a blind decision against the previous one, only the two, with fresh jurors and no score history (decision council; media through `/curation`). If it wins, it becomes the base of the next round. If it loses or ties, the round is rejected and the next one starts from the previous version. Stay in `FIX_ARTIFACT` while a mandatory defect is demonstrated and the round is within the cap.
8. Declare approval only when the protocol's full set of conditions is met and coverage is reported. Keep the previous version for rollback.

States, limits, outputs and the handling of improvement, feature or workflow proposals made by the jurors are in [hill-climb.md](hill-climb.md). Read [weighted-execution.md](weighted-execution.md) before calling models or execution tools.

## Agreement vote

Owner request: the council changes the artifact only with what it itself approves.

1. The conductor gathers the correction points from the valid reviews into a list `items.json` (`[{ id, section, problem, fix }]`). It merges duplicates without changing the meaning and adds no opinion, authorship or count of how many jurors asked for it.
2. `council-t3.mjs vote-packet --items items.json --artifact current.txt --out packet.txt` generates the packet: current artifact, items, and the format `{"votes":[{"id","agreement","reason"}]}`, with integer agreement from 1 to 10.
3. Dispatch with `prepare --phase vote`, the same lineup and the same concurrency and deadline rules as the evaluation. Collect with `collect --items items.json`.
4. `agreement --plan ... --items items.json` computes, per item, the mean weighted by the Intelligence Index over the valid votes with a verified index. An item with 7 to 10 becomes `apply`; below 7, `reject`. Each vote weighs by its level (published, estimated or floor), and the result reports how many votes of each level there were.
5. The vote follows the same per-answer quorum as the decision council (section "Decision council", step 3): two valid indexed models and the valid weight at least two thirds of the weight of everyone who answered. With quorum, the rule above decides.
6. Without quorum, the vote is advisory (owner request, 2026-11-06): each item comes out as `conductor_decides`, with the mean and the indication `favorable` (7 to 10) or `unfavorable`. The conductor decides item by item with those scores and records in `conductor-decision.json` the decision (`apply` or `reject`), the mean and the reason, which cites the artifact field. Following the indication is the default; going against it requires a reason with evidence. The missing quorum goes in the report and the flow does not stop at `BLOCKED` because of the vote.

An approved item still goes through the conductor's check. If the premise is false or the fix breaks an oracle, it becomes `not applicable` with the evidence. A rejected item doesn't go in, even if the conductor agrees with it. A failing mandatory test or oracle doesn't depend on a vote: it is always fixed. Record `agreement.json` in the round folder.

## 4. Lineup, cost and execution in T3

Find the free models from the current OpenRouter catalog, with every applicable price equal to zero, and cross-check them against the proxy and the T3 catalog. Include every effort level actually advertised, and record exclusions and levels whose effect is unconfirmed. If the owner asks for free models only, don't probe Claude.

Add Claude when access is proven by a real call through the same route the participants use, whether a subscription or organization credit the owner authorized. A listed model or an existing credential doesn't prove credit. Fix a cost cap for the Claude participants before the round and measure usage in the proxy afterwards. The failure of a free model or of Claude does not authorize another paid model.

Use `scripts/council-t3.mjs` from this skill: `prepare` freezes the plan with free models and Claude, `pending` lists the calls to dispatch now, and `register` stores each taskId, dispatch error or failure. The conductor runs in parallel the calls that `pending` returns, and repeats only the pending ones with the same `clientRequestId`.

Free models go in waves: `pending` returns at most one in-flight call per model, because efforts of the same model in parallel exhaust the provider's per-minute limit; Claude goes entirely in the first wave. On each notification, run `register` (with `--failure "<notification text>"` when the task failed, because the T3 CLI doesn't keep the error), then `cycle`, and dispatch the next wave. A dispatch that fails twice (ECONNRESET, for example) is recorded with `--error` and left out.

Each finished round goes into `~/.cache/council/history.json`; `prepare` removes from the lineup any free model with at least 3 attempts in the last 14 days and fewer than one third valid reviews, and lists the cut in `excluded_by_history`. It comes back on its own after 14 days without an attempt; `--no-history` turns the cut off. `history` shows the table and imports old collections with `--collections`.

The free pool (eligible pairs from the OpenRouter catalog that are present in the proxy) is refreshed once a day in `~/.cache/council/free-pool.json`, by the 06:00 scheduled task and by the first `prepare` with a snapshot older than 24 hours. The `prepare` summary carries `pool` with `entered`, `left` and `last_change`; show the owner who came in or left. `pool --force` refreshes immediately.

Don't create top-level threads to simulate participants, and don't silently fall back to direct HTTP. Record taskIds and wait for the native notifications, without polling tasks in progress. Analyze the round only when `collect` reports `ready_for_analysis`: everyone answered, expired, or the round was closed.

To close before the deadline, run `close` with the same flags as `collect`. It writes `closed.json`, collects one last time, marks those in flight as `canceled` and those waiting in the queue as `not dispatched: round closed`, and returns the taskIds in `cancel` for `task_cancel`. If `close` comes back with `ready_for_analysis` false (some task wasn't read within the 2 min cap), run `close` again: it is idempotent, and each call lists in `cancel` everything that is canceled. After that, `pending` returns nothing and `tally.mjs` runs normally.

Don't spend effort on a free model that fails: it gets at most one resend (429) and, if it fails again or doesn't follow the format, it is left out.

Each participant's deadline is fixed: 10 minutes from the start of the task, always, with or without Claude in the lineup. For one that was never dispatched (dispatch error, model unavailable), the clock starts at the first dispatch attempt, or at plan creation. A participant that expires without returning anything becomes `timeout`. A failure recorded with `--failure` keeps its cause (`failed: 429 ...`) even after the deadline. Neither a timeout nor a failure recorded with `--failure` enters the quorum denominator. A `delegate_task` that returns `model_unavailable` proves the inventory was wrong: record it with `--error`; the model leaves the denominator and is listed in `excluded_after_freeze` in the collection, with the reason.

Child tasks start with the protection marker described in the operational reference. The marker doesn't go in the orchestrator's message. Confirm the free-only protection and free models for titles, summaries and compaction before the batch. All participant tokens go through CLIProxyAPI; an unknown price, an invalid route or missing proof blocks the send.

On a 429, preserve `Retry-After`, respect the quota and the attempt limit. A 429 recorded with `--failure` gives the participant a single resend: `collect` marks it `waiting resend` and `pending` returns the call with the suffix `-r1` after the `Retry-After` (or 60 s). The resend does not reopen the 10-minute deadline, which counts from the first task. Parallelism doesn't remove a per-minute limit. The lineup stays frozen: whoever failed is listed in `discarded`, and the weight fraction over those who answered keeps a few low-weight valid votes from overriding many out-of-format ones. If availability changes between rounds, record the new inventory and compare only the same paired subset, preserving the total coverage.

## 5. Indexes, scores and approval

Refresh the official indexes at least daily and require a snapshot under 24 hours old. Use the official public pages without login when the API isn't reachable; keep source, date, identity and version. The operational reference has the commands and the scheduling.

Variety is good in a vote, and no model goes without a voice (owner request, 2026-11-06). Weight has three levels, applied by `scripts/weights.mjs`:

1. **Published:** the model's verified comparable Intelligence Index. Weight = index.
2. **Estimated:** with no published index, `scripts/estimate-indices.mjs` reads from the public Artificial Analysis pages the benchmarks it measures for the model (GPQA, HLE, SciCode, LCR, IFBench, tau2, Terminal-Bench Hard; at least 3) and calibrates the index by log-linear regression against at least 5 anchors with a published index and the same benchmarks, with r² of at least 0.5. Weight = estimate × 0.5, for the uncertainty. The result goes to `~/.cache/council/estimated-indices.json`, with benchmarks, source, anchors, r² and date, and is renewed along with the snapshot. Leave-one-out validation on 2026-11-06 across 99 models with an index: median error factor 1.17, p90 1.56. Before estimating, check whether the model already has a published index that is just unmapped in `mappings.json`.
3. **Floor:** with no data at all, weight = half the lowest published or estimated weight of the same piece.

Don't multiply by confidence and don't divide by the number of efforts. Flag when a base index is reused across efforts that weren't measured separately. The table shows each weight's level. The "distinct indexed models" criterion counts only published indexes, so that estimates and floors don't manufacture quorum. Fix before collection the coverage required for that result; without the required coverage or comparability, end `BLOCKED`, not "approved". Don't announce approval by everyone when only a sample was measured.

For score-based refinement, approval is the final version having beaten the baseline in the blind decision, with the decision council's per-answer quorum (two distinct indexed models among the valid ones and the valid weight at least two thirds of the weight of everyone who answered), all mandatory oracles passing and no demonstrated critical defect. The absolute score is neither a target nor a stop. Across the seven hill climbs with a mean-9 target recorded on the scoreboard (2026-11-05 to 10), none reached 9: the gain came in the first round (3.05 to 7.61 in one of them) and the following ones stayed in the noise (7.61, 7.64, 7.66). The per-category score says where to attack and stays in the record, always with the ruler it came from: a score given inside a decision comes out about 1 point above the one from notes mode for the same piece. Record the coverage of models with no index. The owner can fix a score target; freeze it before the reviews. The council's approval of a definition, with no owner (section 2), has no previous version for the blind vote and keeps the root rubric's score ruler: weighted mean and median of at least 9 and no category below 8.

## 6. Wrap-up and comparison

Fix the budget of tokens, time, attempts and number of rounds. The cap is three rounds in any loop: problem, definition, jury or vote (owner rule, 2026-11-09: "limit of 3 loops for the councils"). The baseline does not count. The maximum meta depth is one. At the cap, on unavailability, or on missing evidence, end `BLOCKED` with what was and wasn't demonstrated.

After round 2, make the progress checkpoint: did the version beat the previous one in the blind decision, did the mandatory defects drop, and do the oracles pass? With no progress, with a regression or with insufficient evidence, round 3 runs only with a recorded change of method. Closing at the cap without beating the baseline, or below a target the owner fixed, is `CLOSED_BELOW_TARGET`, with the best measured result and the reasons: it is not approval and not a failure to hide.

In every round, including the definition, show the round table here in the orchestrator's thread: generate it with `scripts/council-table.mjs collection.json table.html` (real data, escaped text), check it in `html_preview` and show it with `html_render`. Saving the HTML or showing only an image doesn't replace the table in the conversation. One row per model/effort, with the review's state, the Intelligence Index (source, version and date), the weight with its level and the share of the valid weight. For a decision, add vote and confidence. For scores, the original score followed by the number of criticisms/suggestions in that review, and the score `score × index`. A pending or errored review doesn't become a zero score or zero criticisms; an invalid review keeps its score visible, labeled as not aggregated, and contributes nothing. A missing index uses the calibrated estimate or the floor, always labeled. Also show the per-category means and the problems resolved, pending or refuted, and keep reported costs and auxiliary calls in the proxy. A static review doesn't prove tests were run. The rules for counting, for two pieces and for the paired comparison are in [hill-climb.md](hill-climb.md), section "Mandatory HTML table per round".

At the end, compare baseline and final by a paired blind decision, with the same rubric and the same cases. The rubric stays frozen from start to finish. Report regressions, failures and missing indexes together with the gain, without selecting only the favorable jurors. The skill is done only when the approval controls and the required checks actually passed.
