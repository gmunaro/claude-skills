---
name: ladder
description: Effort ladder. The task starts at the cheapest step that has a real chance of passing, and an oracle says to move up one step at a time (Haiku medium, Haiku high, Sonnet high, Opus high, conductor). Use when the task has an oracle and the difficulty is uncertain, when a batch of similar tasks can almost all pass at the cheap step, when a worker failed, and when the user runs /ladder.
---

# Ladder

Each step exists only because the one below it failed the oracle. The `/ladder` method requires an oracle. Without an oracle, the escalation order in `swarm` still applies, and the conductor is the one who finds the failure when checking.

## Steps

| Step | Model and effort |
|---|---|
| 1 | Haiku medium |
| 2 | Haiku high |
| 3 | Sonnet high |
| 4 | Opus high, with a short scope and the packet ready |
| 5 | The conductor does it directly |

The starting step comes from the `swarm` table: medium implementation starts at 3, hard at 4. `xhigh` only for a long unattended task; `max` only when the owner asks for it (ceilings in `swarm`).

## Procedure

1. Write the oracle, the input packet and the files the agent may edit.
2. Launch at the starting step.
3. Run the oracle yourself. If it passed, you are done.
4. If only evidence is missing, send `SendMessage` to the same agent asking for the command and its output, and the ladder does not go up. If it got it wrong or got stuck, follow the escalation order in `swarm`:
   - fix the prompt and relaunch at the same step;
   - raise the effort within the same model (step 1 to 2);
   - split the task;
   - move up a model (step 3, then 4);
   - the conductor does it directly.

   On each relaunch, the new agent gets the same packet plus the last ~30 lines of the failed output, not the diff or the reasoning of the one that failed.
5. At the end, one line in the `swarm` scoreboard: method `ladder`, the step where it passed and the reason for each move up. That history sets the starting step for the next tasks of the same type.

With A/B, use a shared step: all variants run at the same step, the first one that passes ends it, and if none passes they all move up together.
