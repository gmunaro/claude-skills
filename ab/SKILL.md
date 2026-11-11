---
name: ab
description: A/B between agent variants. Selection, when an oracle (test, typecheck, build) picks between edits made in separate worktrees. Coverage, when sweep or research lists built from different angles add up. Use when there is more than one plausible way to do something and a command decides which one works, when an incomplete list would be costly, and when the user runs /ab.
---

# A/B

Write the rubric before launching: the oracle command for selection, or the definition of what counts as an item for coverage. All variants get the same packet. Only the last line of the prompt changes, `Approach:` (skeleton in `swarm`).

## Selection (with an oracle)

1. Launch 2 variants, 3 at most, with the same `model` and the same `effort` (type 7 or 8 in the `swarm` table). Each one runs with `isolation: "worktree"` and a different angle, for example "change as little as possible" against "fix it at the source".
2. Run the oracle yourself in each worktree. The agent's "passed" does not count.
3. The one that passes the oracle wins. Among those that pass, the smallest diff wins (`git diff --shortstat`). On a tie, the first one.
4. Read only the winner's diff and integrate it. Remove the worktrees.
5. None passed: move all of them up one step together (`/ladder`, same step for all), with the last ~30 lines of the oracle output in the prompt.

## Coverage (lists)

1. Launch 2 Haiku medium variants, read-only, with angles that change the search path: another source, another order, other terms (code against documentation, grep against reading, official docs against repository).
2. Merge by item key. What remains is the union of the items that carry `file:line` or a URL. Where the variants disagree on a fact, or the item weighs on the decision, check it at the source.
3. If the second variant brought more than 20% new items, launch a third with another angle and stop there.

## Close

One line in the `swarm` scoreboard: method `ab-selection` or `ab-coverage`, the winning variant (or "union") and the reason.
