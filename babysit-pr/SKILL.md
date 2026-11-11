---
name: babysit-pr
description: Follow a PR until it is green and approved. Use when the user asks to monitor, follow, watch, "babysit", look after or take a PR / pull request through to merge.
---

# Babysit PR

Goal: green CI and resolved reviews, **without widening the PR's scope**.

Waiting: in T3 Code, `watch_pull_request` and end the turn, and it wakes you when the PR changes. Outside T3, `/loop` or ScheduleWakeup every 270 s (inside the 5-min cache). On each pass:
1. `gh pr view <n> --json state,mergeable,reviewDecision,statusCheckRollup` and `gh pr checks <n>`.
2. **CI failed**: read the log (`gh run view --log-failed`), fix the real cause, verify locally and push. Proven flaky (passed on a rerun with no change): rerun and note it. A timing test that fails when the CI machine is loaded: rerun with no outside load before touching the code.
3. **Branch out of date or conflicting**: rebase onto the base, resolve, verify and push with `--force-with-lease` **on the PR branch only**. Never on main.
4. **Review comments (human or bot)**:
   - Ignore findings from before the last push.
   - Check each finding against the code. Real finding: fix it. False one: reply with the reason.
   - Don't let the review expand the PR beyond its original goal. Out-of-scope suggestions become a "follow-up" in the reply.
   - Every reply you post identifies itself as an agent and names the model ("— Claude Opus 5.5 (agent)").
5. Stop and report when everything is green, reviews are resolved and the PR is approved. Also stop when something needs a human decision. **Merge only if the owner explicitly authorized it**, and under the conditions the owner set.
