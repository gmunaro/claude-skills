# Conducting a large task and workstreams in threads

Reference for the `swarm` skill. The router, the parallelism limits and the prompt skeleton are in [SKILL.md](SKILL.md).

## Large task (refactor, migration, SPEC phase)

1. **Is it worth it?** If one agent can do it in one pass, do it directly and say so.
2. **Reconnaissance.** 2 to 5 `scout`s in parallel, one per area. External dependency: `researcher`.
3. **Plan with file owners.** Show the plan before executing, unless authorized beforehand. The plan has:
   - independent tasks, each with the files it owns (no overlap), an acceptance criterion and a verification command;
   - what is sequential and what is parallel, and what competes for the same PC resource;
   - the type and model of each task;
   - the stop condition.

   With many steps or an infrastructure change, run `/premortem` on the plan and turn the most likely failures into criteria.
4. **Execution.** One `implementer` per parallel task, all in the same message, each prompt complete and self-contained. Do not change the scope of an agent that is still running: wait, or stop it and relaunch.
5. **Integration.** Bring each worktree into the working branch (merge or cherry-pick) and resolve the conflicts yourself. A conflict means the file-ownership split failed: record it in the scoreboard. Before removing a worktree or a branch with commits outside master, prove that everything went in: `git cherry origin/master <ref>` must show no `+` line; a symbol name found on master does not prove it.
6. **Verification.** Run in parallel the `auditor` against the criteria and the review per type 13. The gate runs by the same command CI uses: a path that skips a CI check lets master break. Fix the blockers, verify again and repeat until clean or until the stop condition.
7. **Report.** The owner reads on the phone: first what changed, then what is theirs to decide, then the path of each file. Then: which agents ran, on which model and effort; the commands with their real results; the review findings and what was done with each; and what was not verified. Commit and PR only on request.

## Workstreams in threads

A common workstream opens in Opus. A workstream that creates or edits SVG opens in Fable 5.2 high, or hands the SVG to the `svg-artist` agent. The brief of a workstream follows CLAUDE.md (final done condition, council line, destination of the notice) and carries three more things:

- **Push.** The brief says whether the workstream may push its own branch. If it may, the branch goes up before each notice: a commit that exists only locally disappears with the thread.
- **The notice destination also in a file.** Besides the id in the brief, the current conductor's threadId is kept in a project file, which the brief, the scheduled tasks and the flow documents cite by path. Whoever sends a notice checks the id there at the moment of sending, and a conductor taking over writes their own id to that file before any other step. With the literal id copied into several places, the notices keep going to the old thread when the conductor changes.
- **What stays untouched in the owner's environment**, when the workstream works on their device or PC: the game save, installed apps, their data.

A notice that only relays information goes together with the next useful message: waking a thread re-reads its whole context. Finished work becomes a PR; the `archive/` tag from CLAUDE.md is only for what closes without a merge.
