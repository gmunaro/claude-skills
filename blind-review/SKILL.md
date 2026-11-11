---
name: blind-review
description: Blind diff review. A fresh reviewer gets only the diff, the acceptance criteria and the verification commands, without the author's intent, and judges with evidence. Sonnet high by default; the model goes up with the author and with the risk (list in the skill). Use before integrating or opening a PR with non-trivial code, after the winner of an A/B, after each fix of a finding, and when the user runs /blind-review.
---

# Blind review

Without an acceptance criterion, a blind reviewer only gives opinions: write the criterion first. A mechanical edit covered by an oracle does not need one (type 13 in `swarm`).

## Steps

1. **Packet.** Only three things: the diff (or the command that generates it), the numbered acceptance criteria (C1, C2...) and the verification commands. The PR description, the commit message, the implementer's report, the author's identity and this conversation stay out. A diff with a new or changed test gets one fixed criterion: **the test fails without the fix**. The reviewer proves it by mutation on a copy (undo the fixed line, run the test, expect red) or checks the two outputs the author showed.
2. **Lineup.** One `reviewer` agent, never below whoever wrote the diff:
   - **Default:** Sonnet high, which is how the `reviewer` already comes.
   - **Diff from Opus, Fable or the general conductor:** `model: "opus"`, `effort: "high"`. To judge and review, Opus is enough as a peer of Fable: on Theo's PR review and code analysis benchmark, Fable 5.2 came out below Opus and Sonnet (https://youtu.be/yh5IAUow4Hc?t=593), took ~120 min to review 8 PRs (https://youtu.be/yh5IAUow4Hc?t=1263) and costs double per token.
   - **Risky diff (auth, money, data migration, removal of code or data in use, concurrency):** Opus high, whoever the author is. Deleting dead or test files does not count as risk. A risky diff also gets `/devils-advocate` against the design of the change, in parallel.
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
   - **After every fix there is a new round.** The author's "resolved" does not close the finding: the next reviewer closes it, reviewing only the changed code and the findings still open.
   - **Limit:** 3 rounds; 5 only for a security or data-loss risk.
   - **Stop:** stop when a round brings no new finding. If the last round of the limit still asked for a fix, you check it yourself: reproduce the finding's command and the test mutation, and say in the PR that this fix did not go through a reviewer.
6. **Close.**
   - **PR:** one verdict line with the number of rounds and, if there was one, the disagreement with the reviewer, stated in full.
   - **Scoreboard:** one line in the `swarm` scoreboard, with the method `blind-review`.
