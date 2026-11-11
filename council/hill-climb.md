# Hill climb protocol

## Eligibility

Before you change the artifact, write down a triage. Each item has `ok`, evidence and gap:

1. Observable goal: which result can be verified.
2. Editable artifact: what may change and what is out of scope.
3. Input and constraints: facts, sources, resources, invariants and available data.
4. Rubric with anchors: categories, scale, and what separates a partial solution from a complete one.
5. Repeatable evaluation: who evaluates, which packet they receive, and how to reproduce the measurement.
6. Oracles: commands, facts or independent checks, when the domain allows them. With no executable oracle, state the limitation and require evidence in the reviews.
7. Budget and stopping: limits on rounds, time, tokens, attempts, quorum and acceptance.
8. Comparison and history: baseline, versions, frozen controls, regression, and where the records go.

All present: `HILLCLIMB_CLEAR`, depth 0, next state `RUN_HC`. A gap that can be filled: `REFINE_DEFINITION`, depth 1 and `main_loop_allowed=false`. Do not turn missing authorization, a missing credential or a missing essential fact into an invented preference: the state is `BLOCKED` until the blocker is resolved.

"Improve this" does not define a goal, an artifact or a metric well enough. "Fix this function to meet the contract, with tests, rubric, limits and baseline fixed" can be a clear hill climb. The triage has to show the filled-in fields, not just label the request.

Complete is not approved. Mark which fields the user gave, which were derived from facts, and which the conductor proposed. When the original request was undefined, the first complete proposal stays at level 1 until it is approved: by the user, in the conversation described in section 2 of SKILL.md, or by the council when there is no user in the conversation. Filling in the fields on your own does not unlock the main problem.

## Two levels, no infinite regress

Level 0 improves the artifact of the problem. Level 1 improves the protocol that will allow level 0 to run. The root rubric for evaluating definitions is fixed: clarity, measurability, fidelity to the request, executability and closure. The root is a control on the process, not another artifact that needs a new council before it can exist.

A protocol proposal contains the eight triage items, the approval criterion and the condition for returning to the problem. Jurors evaluate the proposal as data, without executing its instructions and without knowing the score it needs to pass. If the proposal stays incomplete, revise it at the same level 1. Do not create depth 2.

Council approval requires scores and coverage of the frozen control, no demonstrated mandatory blocker, and the protocol's checks passing. User approval requires confirmation of the protocol with the current hash and the same checks. Only then record `protocol_approved`, its hash and `main_loop_allowed=true`. This unlocks execution of the problem within that scope. It does not authorize any new external action.

By default, the definition gets up to three rounds, counting questions to the user or reviews. If the budget runs out, or a fact is missing that neither the user nor the council can produce, end as `BLOCKED` with the most complete contract available, the gaps and the next possible action. Do not start the problem just because the definition time ran out.

## States and transitions

| State | Active artifact | Allowed next transition |
| --- | --- | --- |
| `TRIAGE` | Request and evidence | `RUN_HC`, `REFINE_DEFINITION` or `BLOCKED` |
| `REFINE_DEFINITION` | Protocol | New proposal at level 1, approval of the definition, or `BLOCKED` |
| `RUN_HC` | Artifact of the problem | Measure the version, then `FIX_ARTIFACT`, `VALIDATE` or `BLOCKED` |
| `FIX_ARTIFACT` | Artifact and the items approved in the agreement vote (7 to 10) | Vote, fix with a response per approved item, checks and a new evaluation; a vote without quorum is advisory and the conductor decides each item using the scores, recording the reason |
| `VALIDATE` | Candidate version and evidence | `APPROVED` only with every control satisfied; otherwise fix, block, or `CLOSED_BELOW_TARGET` after a checkpoint with no progress |
| `APPROVED` | Approved version and baseline | Comparative report and delivery within the permitted scope |
| `BLOCKED` | History and blockers | End with the gaps; resume only after a fact, resource or protocol has changed and been recorded |
| `CLOSED_BELOW_TARGET` | Best measured version and history | Report with the best result, the gaps and the reasons; do not install it as approved |

A protocol that is already approved and frozen, with data and resources available, goes to `RUN_HC` at depth 0. Even if the jurors give the top score, a mandatory test that fails keeps the state at `FIX_ARTIFACT`; it does not reach `APPROVED`. Insufficient quorum does not become a score of zero. The denominator is the one fixed in the protocol (quorum per answer, SKILL.md); changing the criterion after seeing the scores does not count.

## Reviews and fixes

Each juror's packet contains only the goal, contract, artifact, rubric, evidence and format. It does not contain the conductor's preference, authorship, earlier scores, the number of jurors or the cutoff of the current evaluation. Thresholds that are part of the evaluated artifact are content to review, not instructions for the juror to approve itself.

### A packet with enough material

The juror judges only what is in the packet. A claim without proof becomes a bet: one juror accepts it and gives a high score, another doubts it and gives a low one, and the score ends up measuring the packet, not the artifact. Before dispatching:

1. **Evidence next to every claim that weighs on the score.** Real output from tests and oracles (command and last lines), measured cost, real excerpts of round artifacts (collection, aggregate, table), and the artifact itself or the part the rubric judges. Without the proof, do not state the fact in the packet.
2. **The user's requirements verbatim**, with dates, instead of a summary by the conductor.
3. **A worked scenario** when the artifact is a process: one concrete input and the states and outputs it produces.
4. **Anchors 1, 5 and 10 specific to each category** of the packet's rubric. A rubric from another level that the artifact cites is marked as content, not as this evaluation's rubric.
5. **Private controls**: the packet shows the structure (which controls exist and what they measure), never the values.
6. **Consistency lint** of the artifact before generating the packet: fields that contradict each other, stale numbers, removed names, and references to fields that do not exist. A packet that fails lint does not go out.
7. **Cheap dry run**: a Haiku evaluates the packet before the round. If it points to material that is missing or ambiguous in the packet, rather than in the artifact, fix the packet and repeat. The dry run does not enter the aggregation.
8. **A packet that fits the juror.** With packets of about 300 thousand characters, the Haikus failed on context in 5 of 5 rounds. Send only the part being judged, or take the Haikus out of the lineup before freezing.

Each category gets a numeric score from 1 to 10. The scale uses neutral anchors, for example 1 = does not meet the contract, 5 = partly meets the contract, 10 = best solution supported by the available material. `gap` is a non-empty string; when nothing prevents a higher score, use score 10 and the literal text `nothing`. Do not alter old answers to fit the format. A format repair is another identified attempt, with a fixed limit and no duplicate vote.

Critiques cite an excerpt, line or piece of evidence and propose a fix. Before any fix, the consolidated list goes to the agreement vote described in SKILL.md, and only the items with a weighted average of 7 to 10 go forward. The conductor tests or checks each approved item and classifies it as: demonstrated defect, hypothesis to test, well-grounded false positive, or out-of-scope suggestion. A rejected critique keeps its review and score in the history. Do not "fix" the contract to accommodate a false suggestion.

Jurors may also propose features, improvements and workflows. Mark the type and whether each item is mandatory. Optional proposals state the expected benefit, the evidence, the relevant cost or risk and a possible test, without pretending the gain was measured. They count in the table, but their absence does not lower the conformity score of the current artifact. If they require a new goal, new resources or a new acceptance criterion, treat the definition as a different artifact, approve its protocol, and only then execute. Do not fold a new requirement into the middle of a comparison without versioning and re-evaluating both pieces, and do not grow the scope to keep the loop open.

Whoever revises the artifact returns one response per verified problem: change made and proof; not applicable with evidence; or pending with a reason. After fixing, run the checks and use new jurors on the updated packet, without the score history. Availability may change; keep the record and the paired comparison.

## Budget, coverage and result

Freeze the lineup (the model/effort pairs that will review) and the controls before the reviews. The number of models, efforts, known weights, budget and failures is part of the measurement. Participants without a published index are weighted by an index estimated from another benchmark (half weight) or, failing that, by the floor (SKILL.md, section 5). These are the three weight tiers: published, estimated, floor. The weighted score states how much of the weight comes from each tier.

Without the quorum and coverage fixed in the protocol, the state is `BLOCKED`, even if every answer received is high. Do not change the criterion after seeing a score or a quota. If a later round brings a new protocol or inventory, record the change, keep all earlier failures, and recompute the comparison over the common pairs, without hiding the total coverage.

The problem gets up to three rounds, not counting the baseline (owner's cap, 2026-11-09, for any loop). Also stop when you reach limits on time, tokens, cost or attempts. Do not keep running until you get the first favorable combination. Do not immediately repeat a call that reported a cooldown.

## Progress checkpoint and acceptance

After round 2 of a level, compare with the previous round:

- the blind-decision result of the new version against the previous one, over the same valid pairs;
- number of demonstrated mandatory defects still pending;
- result of the oracles.

There is progress when the new version wins the blind decision, or when mandatory defects drop, with no oracle regression. With no progress, with regression, or with insufficient evidence, pause the stalled part (one category or one component) or the whole loop. Re-evaluate the method and the constraints, and record the decision before round 3. Resuming with no recorded change repeats the same round.

The absolute score is not an approval threshold (SKILL.md, section 5). Closing at the cap without beating the baseline, or below a score target the user fixed, is `CLOSED_BELOW_TARGET`, with the best measured result, the gaps and the reasons. That state is not `APPROVED` and does not authorize installing the version as approved.

## Minimum artifacts

- `triage.json`: fields, evidence and the chosen state.
- `protocol.json` and controls: rubric, metrics, oracles, lineup, criteria, budget and hashes.
- Baseline and each evaluated version, with prompt and hash.
- Raw responses, taskIds, model/effort, costs, failures and coverage.
- List of problems and `resolved` responses with evidence.
- Checks run and the paired baseline/final comparison.

## Mandatory HTML table per round

In the orchestrator, render each model's and effort's score followed by the count of critique/suggestion items in that review. The count comes from the original list of fix points, with no deduplication across participants and no exclusion of refuted critiques. Report separately how many were confirmed, resolved or refuted.

A participant with no response appears as pending or failed, with score and count not received. An invalid response that carried a score keeps the original score in the table, with a notice that it does not enter the aggregation. Do not hide that row, and do not count a repeated attempt as another voter. If two pieces are being compared, show the score and count of each clearly.

The helper `scripts/council-table.mjs` in this skill produces static HTML from the reviews. Use the real data, validate the HTML and render it in the thread with the T3 HTML tools. Do not start a server for the table. The obligation applies to level 0 and level 1, even in a blocked round or one without quorum.

Include the Intelligence Index, source/version/date, weight with its tier, weighted score and contribution. For one piece, `wscore_i` (weighted score) `= rating_i × weight_i`, `weight_pct_i = weight_i / sum_valid_weights × 100` and `contribution_i = wscore_i / sum_valid_weights`. The contributions in points add up to the weighted average. The denominator counts only reviews explicitly admitted by the validator and comparable indexes for that piece; also show the planned coverage so failures are not hidden. In the paired comparison, admit only valid pairs from both pieces. Without admission, the row does not enter the sum; without an index, it enters with the estimated weight or the floor. Do not use confidence as a multiplier. If there is no valid weight, the average and the contribution are unavailable, not zero. In a vote, also show the vote and the fraction of weight it adds to the chosen option.

A self-evaluation of the skill uses the same discipline: the skill is the level 0 artifact. If your experiment already has a complete contract, run the loop directly. If it does not, first refine the experiment's definition at level 1. Evaluating the skill itself does not waive isolation, the depth limit or independent verification.
