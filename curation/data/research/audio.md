# Research: audio benchmarks for the voice-over jury

Reading date: 2026-11-07. Each source is marked with how it was read: "read" (page or file opened), "search" (only the search-result snippet), "[unverified]".

## 1. Main benchmark: MMAU-Pro

- Name: MMAU-Pro, "A Challenging and Comprehensive Benchmark for Holistic Evaluation of Audio General Intelligence".
- Paper: https://arxiv.org/abs/2508.13992 (read on 2026-11-07). Version: v1 only, submitted on August 19, 2025. Publication at AAAI 2026: [unverified] (search).
- Per-model results: https://sonalkum.github.io/mmau-pro/results.json (read on 2026-11-07; the WebFetch summary extracted the values, I did not check the raw JSON). Repository: https://github.com/sonalkum/MMAUPro (read).
- Result date: results.json has no date or version. BenchLM says the snapshots were updated on 2026-11-06 (https://benchlm.ai/voice-benchmarks/mmau-pro, read; third-party claim, [unverified]).
- Scope: 5,305 instances (audio + question and answer written by experts), 49 skills, speech, sound, music and mixtures, audio up to 10 min. Columns per category: Speech, Voice (persona, prosody, multi-turn QA), Sound, Music, Spatial, Multi-audio and Instruction Following (https://sonalkum.github.io/mmau-pro, read).
- References in the file itself: human 77.9 average; random 23.4.
- Why this one: it is the broad audio-understanding benchmark (not just transcription) with a per-category breakdown, public per-model results and a local evaluation script. The Voice column (prosody, persona) is the closest to acting and timbre. It does not measure dubbing performance directly; it is the best proxy available.
- How to use it: the juror weight should look at Speech and Voice, not only the average. The benchmark's own page warns that the average mixes heterogeneous tasks (BenchLM note, read).
- Limits: the public table has 34 entries, almost all from 2025. Of the 30 candidates, only 6 have a score (see table). Open-ended questions are graded by an LLM judge, and multiple-choice ones use embedding similarity (NV-Embed-v2), according to the repository README (read). The benchmark depends on an LLM judge, which is a bias worth recording.

## 2. Secondary benchmark: MMAR

- Name: MMAR, "A Challenging Benchmark for Deep Reasoning in Speech, Audio, Music, and Their Mix".
- Repository and leaderboard: https://github.com/ddlBoJack/MMAR (read on 2026-11-07). Paper: https://arxiv.org/abs/2505.13032 (search). Title carries "NeurIPS 2025" according to the search.
- Version and date: the public table reports accuracy, with no date per entry. The latest date cited in the README is February 2026, for the Interspeech 2026 challenge (separate leaderboard, agent systems, not a standalone LLM) (read).
- Reason: 1,000 deep-reasoning items on speech, audio, music and mixtures. It complements MMAU-Pro with a focus on reasoning, not on category.
- Limits: outdated table (the top is Gemini 2.5 Pro, 74.7). The results for Gemini 3.8 Flash and Qwen3.8-Omni-Flash come from a Qwen report (Table 4), not from the official leaderboard (https://arxiv.org/html/2609.25611v1, read).

## 3. Benchmarks evaluated and dropped as weights

- Big Bench Audio (Artificial Analysis): https://artificialanalysis.ai/speech-to-speech (read). 1,000 reasoning questions (Formal Fallacies, Navigate, Object Counting, Web of Lies), audio in and audio out. The ranking has 44 models, almost all real-time speech-to-speech (top: StepAudio 3 Realtime, 99.7%). The only non-realtime model with audio on the list is GPT-4o audio chat completions (54.3%), which is not a candidate. None of the 30 candidates appears: dropped. It does not evaluate speech quality.
- VoiceBench: https://aclanthology.org/2026.tacl-1.18/ (search, [unverified] in the text; published in TACL 2026). It measures spoken instructions with text responses and focuses on content, not on judging performance. The fork's table (https://github.com/fixie-ai/VoiceBench-fork, search) is from April 2025. Thinking Machines cites VoiceBench for Inkling (91.4) and Gemini 3.1 Pro (94.3), with no detailed method (https://thinkingmachines.ai/model-card/inkling/, read). Dropped as a main weight.
- AIR-Bench: https://github.com/OFA-Sys/AIR-Bench (search). The chat leaderboard only has models from 2023 and 2024 (top: Qwen2-Audio, 6.93/10). Obsolete for 2026.
- ParaPairAudioBench: https://arxiv.org/abs/2606.24648 (read). It is not a model leaderboard. It tests whether audio LLMs work as judges of paralinguistics (style, rhythm, emphasis, age, gender). Result: the judges trail humans by 32 percentage points on average, and fail on ties. I did not use it for scores, but it is a strong caveat for the jury design: validate the jurors against our own answer key before trusting the weighted vote.
- Muse Spark: Meta's documentation says the audio understanding of Muse Spark 1.3 "is not fully supported" and recommends 1.2 (https://dev.meta.ai/docs/video-understanding, search). I do not know whether Muse Spark Open and Muse Wonder inherit this limitation [unverified].

## 4. Table of the 30 candidates

Main score: MMAU-Pro overall average (results.json). Speech and Voice are on the same row because they are the columns that matter most for voice-over. Secondary score: MMAR (accuracy, official repository) or the Qwen report (vendor-run, Table 4). "no score" = no source read has a score for this id or this version.

| # | OpenRouter id | Main score (MMAU-Pro average) | Speech / Voice (MMAU-Pro) | Secondary score | Main score URL | Secondary score URL | Identity |
|---|---|---|---|---|---|---|---|
| 1 | stealth/crouton-alpha | no score | — | no score | — | — | [identity uncertain]: stealth model, no published identity |
| 2 | meta/muse-spark-open | no score | — | no score | — | — | See the Muse Spark caveat (section 6) |
| 3 | google/gemini-4-argon | no score | — | no score | — | — | — |
| 4 | meta/muse-wonder | no score | — | no score | — | — | — |
| 5 | perceptron/perceptron-mk1.5 | no score | — | no score | — | — | — |
| 6 | xiaomi/mimo-v2.6-pro-ultraspeed | no score | — | no score | — | — | — |
| 7 | xiaomi/mimo-v2.6-flash | no score | — | no score | — | — | — |
| 8 | xiaomi/mimo-v2.6-pro | no score | — | no score | — | — | — |
| 9 | qwen/qwen3.8-omni-flash | no score | — | MMAU 81.8; MMAR 79.8 (vendor-run) | https://sonalkum.github.io/mmau-pro/results.json (no entry) | https://arxiv.org/html/2609.25611v1 (Table 4, read) | [identity uncertain]: name matches "Qwen3.8-Omni-Flash"; version not confirmed |
| 10 | google/gemini-3.8-flash | no score | — | MMAU 76.9; MMAR 78.5; MMSU 83.3 (vendor-run) | — | https://arxiv.org/html/2609.25611v1 (Table 4, read) | [identity uncertain]: name matches "Gemini 3.8 Flash"; version not confirmed |
| 11 | google/gemini-3.7-flash | 70.4 | 89.7 / 87.9 | no score | https://sonalkum.github.io/mmau-pro/results.json (read) | — | [identity uncertain]: name matches "Gemini-3.7 Flash"; no date in the file |
| 12 | thinkingmachines/inkling-small | no score | — | no score | — | — | — |
| 13 | google/gemini-3.6-flash | 69.6 | 86.6 / 84.8 | no score | https://sonalkum.github.io/mmau-pro/results.json (read) | — | [identity uncertain]: name matches "Gemini-3.6 Flash"; no date in the file |
| 14 | google/gemini-3.5-flash-lite | no score | — | no score | — | — | — |
| 15 | thinkingmachines/inkling | no score (MMAU-Pro) | — | MMAU v1 77.2 (vendor card; comparable only as MMAU v1) | — | https://thinkingmachines.ai/model-card/inkling/ (read) | [identity uncertain]: the card's score is for the Inkling of 2026-07-15; id created on 07/17 |
| 16 | google/gemini-3.5-flash | 68.5 | 85.0 / 73.8 | no score | https://sonalkum.github.io/mmau-pro/results.json (read) | — | [identity uncertain]: name matches "Gemini-3.5 Flash"; no date in the file |
| 17 | google/gemini-3.1-flash-lite | no score | — | no score | — | — | — |
| 18 | nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free | no score | — | no score | — | — | — |
| 19 | xiaomi/mimo-v2.5 | no score | — | no score | — | — | — |
| 20 | google/gemini-3.1-flash-lite-preview | no score | — | no score | — | — | — |
| 21 | google/gemini-3.1-pro-preview-customtools | no score | — | no score | — | — | [identity uncertain]: does not inherit the score of 3.1 Pro Preview (id 22) |
| 22 | google/gemini-3.1-pro-preview | 72.2 | 88.9 / 82.1 | no score | https://sonalkum.github.io/mmau-pro/results.json (read) | — | [identity uncertain]: name matches "Gemini-3.1 Pro Preview"; no date in the file |
| 23 | openai/gpt-audio | 58.8 | 73.1 / 49.3 | no score | https://sonalkum.github.io/mmau-pro/results.json (read) | — | [identity uncertain]: the name "gpt-audio" matches; it is not GPT4o-Audio (52.5) |
| 24 | openai/gpt-audio-mini | no score | — | no score | — | — | [identity uncertain]: does not inherit GPT4o-mini-Audio (48.3) |
| 25 | google/gemini-3-flash-preview | no score | — | no score | — | — | — |
| 26 | mistralai/voxtral-small-24b-2507 | no score | — | no score | — | — | — |
| 27 | google/gemini-2.5-flash-lite | no score | — | no score | — | — | — |
| 28 | google/gemini-2.5-flash | 59.2 | 73.4 / 71.7 | MMAR 68.4 | https://sonalkum.github.io/mmau-pro/results.json (read) | https://github.com/ddlBoJack/MMAR (read) | [identity uncertain]: name matches "Gemini 2.5 Flash"; no date |
| 29 | google/gemini-2.5-pro | no score | — | MMAR 74.7 | — | https://github.com/ddlBoJack/MMAR (read) | [identity uncertain]: name matches "Gemini 2.5 Pro"; no date |
| 30 | google/gemini-2.5-pro-preview | no score | — | no score | — | — | [identity uncertain]: does not inherit MMAR 74.7 (id 29) |

## 5. Identity notes

- No source read gives a dated version. results.json (MMAU-Pro) and the MMAR table only give a model name. So every score tied to an id is marked [identity uncertain] at the version level: the name matches, the date was not confirmed.
- Ids 21 and 22 are different versions of Gemini 3.1 Pro Preview. Only id 22 gets the file's score.
- Id 24 (gpt-audio-mini) is not GPT4o-mini-Audio (48.3), which is a different model.
- Id 30 (gemini-2.5-pro-preview, slug 06-05) does not get the MMAR 74.7 of id 29, which is the undated "Gemini 2.5 Pro" entry.
- Id 1 (stealth/crouton-alpha): stealth model in the catalog, no published identity. No score can be assigned.
- Id 2 (meta/muse-spark-open) and id 4 (meta/muse-wonder): the scores in the Qwen report are for Muse Spark 1.2 (the family). They are not for this id.
- Id 15 (thinkingmachines/inkling): the 77.2 score is MMAU v1, not MMAU-Pro. It is not comparable with the main column.
- Ids 9 and 10: the scores come from a Qwen report, not from an independent leaderboard. The values were not reproduced.

## 6. Caveats

- Outdated data: the MMAU-Pro table has 34 entries, almost all from 2025 or early 2026. Of the 30 candidates, 6 have a main score (ids 11, 13, 16, 22, 23, 28). The newest models (ids 1–8, 12, 14, 17–21, 24–27, 30) stay "no score".
- LLM judge: MMAU-Pro's grading of open-ended questions uses an LLM judge (repository README, read). That is not the same as a voice-over juror.
- Audio judges: ParaPairAudioBench (https://arxiv.org/abs/2606.24648, read) measures audio judges at 32 points below humans, with failures on ties. Before applying the weight, the jury must be calibrated with human-labeled pairs.
- Big Bench Audio does not work as a weight: no candidate appears at https://artificialanalysis.ai/speech-to-speech (read).
- Muse Spark: Meta's documentation says the audio understanding of Muse Spark 1.3 is not fully supported (https://dev.meta.ai/docs/video-understanding, search). I did not check whether id 2 or id 4 inherits this limitation [unverified].
- Third parties: BenchLM (https://benchlm.ai/voice-benchmarks/mmau-pro) was not used as a score source, only as a date hint [unverified].
