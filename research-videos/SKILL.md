---
name: research-videos
description: Research the content of YouTube videos (Theo/t3.gg or any channel) with Haiku agents. Use when the user sends YouTube link(s), asks you to "watch", summarize or analyze videos, or asks what a creator said about some topic.
---

# Research videos

The tools live in `C:/Users/MunaroPC/.t3/projects/setupt3code/tools/yt-transcripts/` (read the README there).

1. **List** (for a channel or a topic): `python -m yt_dlp --js-runtimes node --flat-playlist --playlist-end 60 --print "%(id)s | %(title)s | %(duration)s" <channel-url>/videos`. Pick the relevant videos and confirm the list with the owner if there are more than 10.
2. **Download transcripts** to `C:/Users/MunaroPC/yt-research/transcripts/`:
   - try `python tools/yt-transcripts/fetch-direct.py <folder> <ids...>`;
   - if you get `RequestBlocked`, start `sink.py` in the background, open a **logged-in** YouTube tab in T3 Code's browser (preview), evaluate `grab.js` and call `grabMany([...])` without await. Watch `window.__prog` until `DONE`, then stop the sink.
3. **Analyze**: group the videos by topic (1 long video or 2 to 4 short ones per agent) and launch `researcher` (Haiku) in parallel, in a single message. Each prompt carries the owner's context, the transcript files (read **in full**, in chunks), what to extract (with timestamps) and the output file at `C:/Users/MunaroPC/yt-research/findings/<topic>.md`.
4. **Synthesize** (you, Opus): check the central claims and point out contradictions between videos, sponsored segments and what is opinion versus fact. Deliver in pt-BR with links `https://youtu.be/<id>?t=<seconds>`.
