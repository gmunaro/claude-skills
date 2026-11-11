# Research: benchmark for image judging by multimodal LLMs

Research date: 2026-11-07. Candidate list: `C:/tmp/curation/candidates-image.txt` (219 lines).
Convention: "[identity uncertain]" = the benchmark name does not unambiguously match an id in the list; "[unverified]" = a claim I could not read in the primary source.

## 1. Main benchmark: Arena Vision

- Name: LMArena's vision leaderboard, now at arena.ai (exact title [unverified]).
- URL: https://arena.ai/leaderboard/vision (https://lmarena.ai/leaderboard/vision redirects to arena.ai with a 301).
- Reading date: 2026-11-07. The page itself shows "Last updated: Nov 6, 2026", 167 models, 1,577,252 votes.
- Version: snapshot of November 6, 2026. The score is "Score" (a rating with a confidence interval, ±), which the page calls Score, not Elo.
- Why it was chosen: it is the only one of the three that measures judgment. People vote on pairs of vision responses. Art, readability and composition are perceptual judgments; MMMU-Pro measures correctness on fixed-answer questions. It is a primary source, updated in November 2026, with a confidence interval and a vote count per model.
- Why MMMU-Pro is not the main one:
  - The official page https://mmmu-benchmark.github.io/ says "Last updated: 09/05/2025" and did not render the leaderboard rows for reading.
  - Vals.ai archived MMMU-Pro on 9/1/2026 and does not evaluate new models.
  - Sources disagree a lot on the same model. GPT-5.6 Sol: 88.84% on Vals (https://www.vals.ai/benchmarks/mmmu) against 83% on BenchLM (https://benchlm.ai/benchmarks/mmmu-pro).
  - The same official page records the release of the test-set answer key on 2026-02-12. This may contaminate the score (my inference, [unverified]).
  - Kept as secondary (section 4).
- Limitations of Arena Vision:
  - It measures general preference, not quality specific to art or game-screen readability.
  - Style bias and response-length bias: [unverified], I did not measure it.
  - Some scores are "Preliminary" (Gemini 3.7 Flash, Gemini 3.8 Flash).
  - At the top, the intervals overlap: #2 to #5 are within 2 points of each other. Weights must account for the ±.
- Premise checked: third-party aggregators give 1325 for Claude Fable 5 as #1 (exact source not noted in this research; [unverified]). The primary page gives 1309±7 for the same model. I used the primary.
- Premise checked: the official MMMU site is not up to date. It is not the current reference for a leaderboard.

## 2. Non-Claude candidates (top by Arena Vision)

Exact ids from `candidates-image.txt`. Score = Arena Vision (https://arena.ai/leaderboard/vision, snapshot 11/6/2026), "±" is the confidence interval. MMMU-Pro = archived Vals.ai (https://www.vals.ai/benchmarks/mmmu, 9/1/2026, %); "-" = no entry. The id in the list carries no effort or date; when Arena shows an effort, it is in the note column.

| # Arena | OpenRouter id | Name in Arena | Arena Score | MMMU-Pro Vals | Note |
|---|---|---|---|---|---|
| 2 | qwen/qwen3.8-max-0902 [identity uncertain] | Qwen3.8-Max | 1300±7 | 88.03 [identity uncertain] | Alternative in the list: qwen/qwen3.8-max-prime. I could not prove which of the two. |
| 7 | google/gemini-3.7-flash | Gemini 3.7 Flash (High) | 1294±8 | 88.96 | Arena marks "Preliminary". |
| 8 | meta/muse-spark-* [identity uncertain] | Muse Spark | 1294±9 | 87.40 [identity uncertain] | Arena shows no version. The list has several Muse Spark entries (ids 16, 58, 73, 81). |
| 10 | openai/gpt-6.1-sol | GPT-6.1 Sol (Max) | 1293±11 | - | Mercor OSS: 85.8 (Max), https://www.mercor.com/apex/oss-benchmarks/oss-mmmu-pro-leaderboard/ (not the same source, do not mix). |
| 11 | google/gemini-3.8-flash | Gemini 3.8 Flash (High) | 1293±8 | 89.08 | Arena marks "Preliminary". |
| 12 | meta/muse-spark-1.2 | Muse Spark 1.2 (xHigh) | 1292±14 | 86.13 | Wide interval. |
| 13 | meta/muse-spark-1.3 | Muse Spark 1.3 (Max) | 1290±8 | - | Arena also has Muse Spark 1.3 (xHigh) 1290±8. Same id, different effort. |
| 17 | openai/gpt-5.6-sol | GPT-5.6 Sol (xHigh) | 1288±7 | 88.84 | |
| 20 | openai/gpt-6-astra | GPT-6 Astra (Max) | 1285±9 | - | Mercor OSS: 87.5 (Max). Different source. |
| 21 | openai/gpt-5.5 | GPT-5.5 | 1285±6 | 88.27 | Arena also has GPT-5.5 (High) 1283±6. |
| 23 | openai/gpt-5.4 | GPT-5.4 (High) | 1282±6 | 87.51 | Vals uses xhigh. Different effort. |
| 24 | google/gemini-3.5-flash | Gemini 3.5 Flash (Medium) | 1282±7 | 88.27 | |
| 25 | x-ai/grok-4.5 | Grok 4.5 | 1281±7 | 61.79 | Big gap versus Arena. Worth checking before weighting. |
| 26 | google/gemini-3.1-pro-preview | Gemini 3.1 Pro Preview | 1280±5 | 88.21 | Vals date: 02/26. |
| 28 | google/gemini-3.6-flash | Gemini 3.6 Flash (High) | 1280±8 | 88.38 | |
| 29 | meta/muse-spark-1.1 | Muse Spark 1.1 | 1279±7 | 86.59 | |
| 35 | google/gemini-3-flash-preview [identity uncertain] | Gemini 3 Flash | 1272±5 | 87.63 [identity uncertain] | Arena also has Gemini 3 Flash (Minimal) 1260±5. I do not know which of the two this id is. |
| 36 | z-ai/glm-5.3-flash | GLM-5.3-Flash | 1272±6 | 86.01 | |
| 37 | openai/gpt-5.6-terra | GPT-5.6 Terra (xHigh) | 1267±7 | 86.47 | |
| 38 | google/gemini-3.5-flash-lite | Gemini 3.5 Flash-Lite | 1266±7 | 83.58 | |
| 39 | google/gemma-4-31b-it | Gemma 4 31B | 1265±6 | - | llm-stats gives 0.769, self-reported, https://llm-stats.com/benchmarks/mmmu-pro (page dated "November 8, 2026", later than today; [unverified]). |
| 40 | moonshotai/kimi-k2.6 | Kimi K2.6 | 1264±7 | 86.30 | |
| 42 | x-ai/grok-4.6 | Grok 4.6 (High) | 1263±8 | - | |

Table notes:
- No id in the list: Gemini 3 Pro (1289±7), Dola Seed 2.0 Pro (1256±7), Molmo 7B-D (994±14). There is no matching candidate in `candidates-image.txt`.
- Top 5 non-Claude by Arena, with the identity caveat: Qwen3.8-Max 1300±7 [identity uncertain]; Gemini 3.7 Flash 1294±8 (Preliminary); Muse Spark 1294±9 [identity uncertain]; GPT-6.1 Sol (Max) 1293±11; Gemini 3.8 Flash 1293±8 (Preliminary).
- This table covers 23 rows. Arena rows with the same name as another id and a different effort were marked in the note, not added.

## 3. Claude models (4)

Ids from `candidates-image.txt`: anthropic/claude-opus-5.5 (40), anthropic/claude-fable-5.1 (60), anthropic/claude-sonnet-5.5 (31), anthropic/claude-haiku-5.5 (26).

| Model | OpenRouter id | Arena Vision score | MMMU-Pro (Vals, 9/1/2026) | MMMU-Pro (other sources) |
|---|---|---|---|---|
| Claude Opus 5.5 (High) | anthropic/claude-opus-5.5 | #6, 1296±10 (4,826 votes) | no entry | 87.4 (Max), Mercor OSS; 88% (Max, rounded), Artificial Analysis, undated |
| Claude Fable 5.1 (Max) | anthropic/claude-fable-5.1 | #16, 1288±9 (6,344 votes) | 90.64 | 86.1 (Max) and 83.9 (High), Mercor OSS |
| Claude Sonnet 5.5 (xHigh) | anthropic/claude-sonnet-5.5 | #44, 1261±10 (4,311 votes) | no entry | 85.8 (Max), Mercor OSS |
| Claude Haiku 5.5 | anthropic/claude-haiku-5.5 | no published score (row not visible in Arena; see note) | no published score | no published score (Artificial Analysis https://artificialanalysis.ai/models/claude-haiku-5-5 showed no number; Vals https://www.vals.ai/models/anthropic_claude-haiku-5-5 only lists SWE-bench Multimodal) |

Notes:
- Arena sources: https://arena.ai/leaderboard/vision, snapshot 11/6/2026. Leaderboard rows 159 to 167 were not read (the page cut off in the middle of row 159). Haiku 5.5 may be in them; so the note says "no published score" until checked.
- Mercor source: https://www.mercor.com/apex/oss-benchmarks/oss-mmmu-pro-leaderboard/ (only "© 2026", no update date).
- Artificial Analysis source: https://artificialanalysis.ai/evaluations/mmmu-pro (top 3 only, whole numbers, undated).
- Haiku 5.5 was released on 2026-10-07 according to https://www.anthropic.com/document/claude-haiku-5-5-system-card (date not read in the page body; [unverified]).

## 4. Secondary benchmarks and caveats

Use: Arena Vision covers almost all candidates. The secondary ones come in only where the main one has no score, or to cross-check the correctness reading.

**MMMU-Pro, Vals.ai (main secondary)**
- URL: https://www.vals.ai/benchmarks/mmmu. Read: 2026-11-07. Version: "Updated 9/1/2026", marked "Archived Benchmark"; 93 models; metric in %.
- Benchmark method: https://arxiv.org/abs/2409.02813 (MMMU-Pro, v3 of 5/22/2025, ACL 2025). It filters out questions answerable from text alone, augments the options and adds a vision-only mode.
- Limit: models released after 9/1/2026 are not included. That is why Opus 5.5, Sonnet 5.5 and Haiku 5.5 have no entry.

**MMMU-Pro, Mercor OSS**
- URL: https://www.mercor.com/apex/oss-benchmarks/oss-mmmu-pro-leaderboard/. It only shows "© 2026", no update date.
- Covers Claude and some OpenAI candidates. Used only in section 3 and in the table notes, never mixed with Vals in the same column.

**MMMU-Pro, Artificial Analysis**
- URL: https://artificialanalysis.ai/evaluations/mmmu-pro. Undated. Only the top 3 appear, as whole numbers: Gemini 4 Carbon (Medium) 89%, Claude Opus 5.5 (Max) 88%, GPT-6 Astra (Max) 87%.
- "Gemini 4 Carbon" has no id in the list. The closest is google/gemini-4-argon (line 21), but the identity is not confirmed: [identity uncertain].

**MMMU-Pro, llm-stats (self-reported)**
- URL: https://llm-stats.com/benchmarks/mmmu-pro (page 1 of 2). Scale 0 to 1. The numbers are self-reported by the vendors.
- Anomaly: the page says "Last updated November 8, 2026", a date later than today (11/7/2026). So I do not use it as a main source. Used only where Vals has no entry (e.g. Gemma 4 31B, 0.769).

**MMMU-Pro, BenchLM (not used in the table)**
- URL: https://benchlm.ai/benchmarks/mmmu-pro ("November 7, 2026"). It diverges a lot from Vals and llm-stats: GPT-5.6 Sol 83% against 88.84% on Vals. I did not mix sources in the same column.

**Official MMMU**
- URL: https://mmmu-benchmark.github.io/ ("Last updated: 09/05/2025"). The leaderboard rows are rendered in JavaScript and were not read. It records the release of the test-set answers on 2026-02-12, which may contaminate the score (inference, [unverified]).

**General caveats**
- Aggregators (benchlm, llm-stats, benchleader and similar) give numbers that differ from each other and from the primary source. I used only the primary pages in the table.
- Three Arena scores have ambiguous identity and are marked: Qwen3.8-Max (ids 56 and 34), Muse Spark (version not given in Arena) and Gemini 3 Flash (two names in Arena, one id in the list).
- "Preliminary" scores in Arena (Gemini 3.7 Flash, Gemini 3.8 Flash) may change.
- Grok 4.5 has a Vals score (61.79) far below its Arena score (1281). I did not investigate the cause.
- Not measured: style bias, cost per vote, behavior on art or game-screen readability. This data does not exist in the sources read; the choice of Arena is the best approximation available, not a direct measurement of the juror's criterion.
