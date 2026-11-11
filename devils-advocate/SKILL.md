---
name: devils-advocate
description: Devil's advocate. An Opus high agent, without the conversation, builds the strongest case against a plan, a decision or an already-chosen hypothesis, and Haiku verifiers check each objection at the source. Use before executing a plan, migration or architecture, alongside the reviewer on a risky diff (auth, money, data, concurrency), after the council decides something expensive to undo, against the cause hypothesis of a hard bug before editing, and when the user runs /devils-advocate.
---

# Devil's advocate

The target is a finished proposal, not a choice between options (for that, `/council`) and not the lines of a diff (for that, `/blind-review`). On a risky diff, the devil's advocate attacks the design of the change: its assumptions and what it leaves uncovered. A trivial proposal does not go through here: the advocate would invent an objection just to play its role.

## Steps

1. **Packet.** Write the proposal in up to one page, with the stated assumptions, the constraints and the evidence. Include the author's rationale, because it is the target of the attack.
2. **Advocate.** Launch 1 `general-purpose` agent with `model: "opus"`, `effort: "high"` and a low `maxTurns`, which receives only the packet. This also applies against a proposal from Fable or the general conductor: to judge and review, Opus is enough as a peer of Fable (on Theo's benchmark, Fable 5.2 came out below Opus, https://youtu.be/yh5IAUow4Hc?t=593), and on 2026-11-10 Opus upheld 4 objections against a Fable plan. The instruction:

   > Build the strongest case against this proposal. Give up to 5 objections in order of severity (blocker, high, low), each with: the thesis in one sentence; the evidence (`file:line`, URL or a reproducible scenario); the assumption that falls if the thesis is true; and the fact that would defeat the objection. "No sustainable objection" is a valid result. At the end, say which was the best objection you tried and abandoned, and why.
3. **Verify.** Each objection is checked at the source, looking for the fact that would defeat it, and comes out `upheld`, `refuted` or `inconclusive`, with the excerpt. One that cites `file:line` you check directly on the line. One that needs a search goes to 1 Haiku medium, 5 at most in parallel. An objection with no evidence starts out `inconclusive`.
4. **Decide.**
   - **Blocker upheld:** revise the proposal, or take it to the owner if you disagree.
   - **Nothing upheld:** proceed and record "devil's advocate upheld nothing".
   - **Second round:** only against the revised proposal, and never more than two in total.
5. **Record.** One line in the `swarm` scoreboard with the method `devils-advocate` and how many objections were upheld, refuted and inconclusive.
