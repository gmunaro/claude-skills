# Cold reader

Reference for the `council` skill's comprehension route: finding out whether an outsider understands an artifact (post, store listing, screen, tutorial) and can act on it. It is a binary gate, with no score. In the Dawnbringer social routine it replaced, by council decision (8 of 8, 2026-11-09), a score-based hill climb that approved 0 of 61 posts.

## Steps

1. **Answer key.** Before any reading, write one line each: what the thing is, the single idea it conveys, and what it asks of the reader.
2. **Reading.** Launch a fresh Haiku medium, with nothing from the conversation and no project context. It receives only the artifact as the audience sees it (the final text and the path of the image) in this prompt, written in the audience's language:

   ```
   You are an ordinary person seeing this for the first time, for a few seconds, and you have never heard of whoever published it.
   Use only what is below. Do not search and do not open any file other than the indicated image.
   <<the artifact: text, and the absolute path of the image if there is one>>
   Answer only with this JSON:
   {"what_it_is": "<what kind of thing this is and what you do with it; 'I don't know' if you can't say>",
    "idea": "<in your own words, the single idea this conveys>",
    "what_it_asks": "<what this asks you to do, if it asks anything>",
    "my_response": "<what you would really do or answer, or 'nothing' and why>",
    "did_not_understand": ["<each word, phrase or part of the image you did not understand>"]}
   ```
3. **Pass or fail.** It passes only if all four hold: `what_it_is` gets the kind of thing right; `idea` repeats the answer key's without contradicting it; `what_it_asks` carries the answer key's request; `my_response` is a real action, not "nothing".
4. **Failed.** Rewrite, attacking the reason and the `did_not_understand` items, and read again with a fresh reader. Up to 2 rewrites (3 readings). After that, the fallback version goes out, or the one closest to passing, with the failure recorded.
5. **Record.** Save each reading (text, answer, passed, reason) in a file next to the artifact.

A juror that received the project context does not work as a cold reader: "would someone who has never seen it understand?" can only be answered without context.
