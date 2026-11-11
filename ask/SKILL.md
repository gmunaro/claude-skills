---
name: ask
description: Answer a question without touching anything. Use when the user asks "how does it work", "why", "what's the difference", "is it worth it", "what is", asks for an explanation, a comparison, a technical opinion or an investigation of code, a library or a concept, or says "question", "quick question", "explain this to me".
---

# Ask (read-only)

Questions are read-only: **don't edit, don't create files, don't install anything.**

1. Restate the question in one line and say what needs to be verified to answer it with confidence.
2. If the answer depends on several sources, delegate in parallel, in a single message:
   - local code → `scout` (Haiku), one area per agent;
   - docs/web/repos/videos → `researcher` (Haiku), one source or topic per agent.
   Each prompt must be complete and self-contained: the question, where to look and the return format with sources.
   If you can answer by reading 1 or 2 files or with a quick search, do it yourself; don't delegate.
3. Check the subagents' central claims before passing them on. Haiku can be confidently wrong.
4. Answer in pt-BR:
   - **Short answer** first, in 1 to 3 sentences.
   - Then the **why**, with evidence (`file:line`, URL, timestamp).
   - **Recommendation**, if there is a choice to make: pick one and explain.
   - What remains **unverified**.
5. If the question reveals something worth changing in the code, suggest it; don't do it.
