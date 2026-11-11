---
name: blind-review
description: Blind diff review. A fresh reviewer gets only the diff, the acceptance criteria and the verification commands, without the author's intent, and judges with evidence. Sonnet high by default; Opus high on a risky diff (list in the skill). Use before integrating or opening a PR with non-trivial code, after the winner of an A/B, and when the user runs /blind-review.
---

# Blind review

Without an acceptance criterion, a blind reviewer only gives opinions: write the criterion first. A mechanical edit covered by an oracle does not need one (type 13 in `swarm`).

## Steps

1. **Packet.** Only three things: the diff (or the command that generates it), the numbered acceptance criteria (C1, C2...) and the verification commands. The PR description, the commit message, the implementer's report, the author's identity and this conversation stay out.
2. **Lineup.**
   - **Default:** 1 `reviewer` agent, which already comes as Sonnet high.
   - **Risky diff (auth, money, data migration, removal of code or data in use, concurrency):** 1 `reviewer` with `model: "opus"`, `effort: "high"`. Deleting dead or test files does not count as risk. A risky diff also gets `/devils-advocate` against the design of the change, in parallel.
   - **Every round:** always a fresh reviewer.
3. **Requested output.**
   - Verdict: `approve` or `block`.
   - Findings, each with severity (blocker, high or low), `file:line`, the problem in one sentence, the evidence (command output or a diff excerpt) and how to reproduce it.
   - The criteria, each marked yes, no or not verified, with the evidence.
   - Suspicions without evidence, in a separate list.
   - Everything in up to 400 words.
4. **Judge.**
   - **Blocker with evidence:** reproduce the command yourself and send it back to the implementer.
   - **Suspicion:** you decide; it does not block.
5. **Rounds.**
   - **Limit:** 3 rounds; 5 only for a security or data-loss risk.
   - **From the second round on:** they review only the changed code and the findings still open.
   - **Stop:** stop when a round brings no new finding.
6. **Close.**
   - **PR:** one verdict line with the number of rounds and, if there was one, the disagreement with the reviewer, stated in full.
   - **Scoreboard:** one line in the `swarm` scoreboard, with the method `blind-review`.
