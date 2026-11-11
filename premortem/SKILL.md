---
name: premortem
description: Pre-mortem of a plan. Four Haiku agents, one per lens (data, security, operations, user), imagine the plan failed three months from now and list the causes. The most likely ones become acceptance criteria or tasks. Use before executing a multi-step plan, a migration, an infrastructure change or a launch, and when the user runs /premortem.
---

# Pre-mortem

A pre-mortem is only worth it if the result changes the plan. If the plan is not going to be adjusted, don't run it.

## Steps

1. **Packet.** Write up the plan with the goal, the steps, the acceptance criteria and the repository context that an agent would not find on its own.
2. **Lenses.** Launch 4 Haiku medium agents in parallel, one per lens:
   - data and migration;
   - security and permissions;
   - operations and rollback;
   - user and real-world use.

   Add a fifth lens, external dependencies, when the plan depends on a third-party service. Each agent gets the plan and the instruction:

   > Today is <date + 3 months> and the plan has failed. Describe up to 6 causes through your lens. For each one: the cause in one sentence, the early signal that would show up in the first week, the probability and the impact (low, medium or high) and a check that can be run now (a command or verification), or `null`.
3. **Merge.** Combine the lists and remove duplicate causes. Sort by probability times impact.
4. **Apply.**
   - The top 7 causes become acceptance criteria or tasks in the plan.
   - A cause with a runnable check becomes a test or script, and serves as the oracle for `/ab` and `/ladder`.
   - A cause with no check goes to the owner, to accept the risk or define the check.
   - Record the reason for each discarded cause.
5. **Record.** One line in the `swarm` scoreboard with the method `premortem` and how many causes went into the plan.
