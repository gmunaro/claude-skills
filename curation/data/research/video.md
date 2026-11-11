# Research: video benchmark for the jury (OpenRouter)

Reading date: 2026-11-07.
Candidates: `C:/tmp/curation/candidates-video.txt` (76 lines).
Ids, names and input modalities: `C:/tmp/curation/catalog-2026-11-07.json`, filtered by `candidates.mjs` (video input only).

Method: primary sources first (paper, official site and leaderboard). Aggregators (BenchLM, llmboard, llm-stats, benchlist, anotherwrapper) are marked as aggregators: their numbers are third-party, not independently verified and have no per-model date. I did not run any model.

## 1. Main benchmark: Video-MME-v2

- Name: "Video-MME-v2: Towards the Next Stage in Benchmarks for Comprehensive Video Understanding".
- Paper: https://arxiv.org/abs/2604.05015 (submitted 2026-04-06; one version, v1). Main table read at https://arxiv.org/html/2604.05015v1 (2026-11-07).
- Official leaderboard: https://video-mme-v2.netlify.app/ (read on 2026-11-07). The model rows are rendered by JavaScript and did not come through in the read; I used the paper's numbers, which are the same as the official leaderboard where the rows were read.
- Dataset: https://huggingface.co/datasets/MME-Benchmarks/Video-MME-v2 (cited in searches; I did not open it).
- Configuration used: Non-Lin Score metric (score per group of questions, which penalizes lucky guesses), "wo sub" configuration (frames only, no subtitles; for Omni models, audio muted). Frames: 64 or 512 for the open-source models; 1 fps for the Gemini models; see Table 1 of the paper. Size: 800 videos, 3,200 questions, 4 questions per video, 8 options each.
- Reason: it is the newest version of Video-MME (2026), with evaluation done by the authors themselves under the same protocol for all models. It was designed against lucky guesses, which is the most common distortion in QA benchmarks. The no-subtitle configuration is the closest to a gameplay clip (unverified premise: a game clip has little speech).
- Important limit: it measures video understanding through multiple-choice questions. It does not measure quality judgment (animation, pacing, reading of action in a game clip). No benchmark I read measures that (section 4).
- Coverage: only 6 of the 76 ids have a score in this source (section 2). A jury of 9 with a main weight only works if all 9 models are among those 6, and today they are not.
- Scales: Non-Lin is not comparable with average accuracy (Avg Acc) or with VideoMMMU/MMVU. In the same paper, Gemini-3-Pro has Avg Acc 66.1 and Non-Lin 49.4 (Table 1, https://arxiv.org/html/2604.05015v1). Do not mix the scales in one average.

## 2. Candidate table (exact OpenRouter ids)

Main score = Video-MME-v2, Non-Lin, wo sub, source https://arxiv.org/html/2604.05015v1 (Table 1, read on 2026-11-07). Only 6 ids have this number.
Secondary scores = aggregators (see section 3). Not independently verified. The "source" column says which aggregator.
[identity uncertain] = the name in the paper or aggregator does not match the OpenRouter id, or the version is unclear.

| # | OpenRouter id | Name on OpenRouter | Video-MME-v2 Non-Lin wo sub (main) | Secondary (aggregator) | Flags |
|---|---|---|---|---|---|
| 1 | google/gemini-3-flash-preview | Gemini 3 Flash Preview | 32.9 (Gemini-3-Flash, 1 fps) | VideoMMMU 86.90 (llmboard) | [identity uncertain] the paper uses "Gemini-3-Flash"; the id is the preview of 2025-12-17 |
| 2 | qwen/qwen3.5-397b-a17b | Qwen3.5 397B A17B | 30.3 (Think, 512 frames); 16.9 (Instruct, 64 frames) | VideoMMMU 84.7 (BenchLM); Video-MME w/ subs 87.5 (BenchLM) | [identity uncertain] the paper's mode does not match the id; read both rows |
| 3 | qwen/qwen3.5-27b | Qwen3.5-27B | 19.5 (Think, 512); 14.0 (Instruct, 64) | VideoMMMU 82.30 (llmboard); MMVU 73.3 (BenchLM) | [identity uncertain] |
| 4 | qwen/qwen3.5-9b | Qwen3.5-9B | 19.5 (Think, 512); 10.3 (Instruct, 64) | none found | [identity uncertain] (same family; mode not confirmed) |
| 5 | qwen/qwen3.5-122b-a10b | Qwen3.5-122B-A10B | 16.3 (Think, 64); 12.5 (Instruct, 64) | VideoMMMU 82.00 (llmboard); MMVU 74.7 (BenchLM); MVBench 76.6 (anotherwrapper) | none |
| 6 | qwen/qwen3.5-35b-a3b | Qwen3.5-35B-A3B | 15.6 (Think, 64); 11.3 (Instruct, 64) | VideoMMMU 80.40 (llmboard); MMVU 72.3 (BenchLM) | none |
| 7 | qwen/qwen3.8-max-0902 | Qwen3.8 Max (0902) | no | VideoMMMU 88.7 (BenchLM); MMVU 82.4 (BenchLM); Video-MME w/ subs 90.4 (BenchLM) | [identity uncertain] OrcaRouter says it has the same weights as Prime; DataNorth says there is no model card |
| 8 | qwen/qwen3.8-max-prime | Qwen3.8 Max Prime | no | the same numbers as item 7 (BenchLM, name "Qwen3.8 Max") | [identity uncertain] same case as item 7 |
| 9 | qwen/qwen3.6-27b | Qwen3.6 27B | no | VideoMMMU 84.4 (BenchLM and llmboard); Video-MME w/ subs 87.7 (BenchLM); MVBench 75.5 (anotherwrapper) | none |
| 10 | qwen/qwen3.6-plus | Qwen3.6 Plus | no | VideoMMMU 84.0 (BenchLM and llmboard) | none |
| 11 | qwen/qwen3.6-35b-a3b | Qwen3.6 35B A3B | no | VideoMMMU 83.7 (BenchLM and llmboard); Video-MME w/ subs 86.6 (BenchLM) | none |
| 12 | minimax/minimax-m3 | MiniMax M3 | no | VideoMMMU 84.6 (BenchLM and llmboard); Video-MME w/ subs 85.4 (BenchLM) | none |
| 13 | google/gemini-3.1-flash-lite | Gemini 3.1 Flash Lite | no | VideoMMMU 84.80 (llmboard) | [identity uncertain] llmboard does not say whether it is the GA or the preview (id 59) |
| 14 | bytedance-seed/seed-2.0-mini | Seed-2.0-Mini | no | VideoMMMU 80.60 (llmboard) | none |
| 15 | z-ai/glm-5.3-flash | GLM 5.3 Flash | no | MMVU 80.5 (BenchLM); MVBench 0.778 (llm-stats); MVBench 77.8 (benchlist) | note: llm-stats uses a 0-1 scale, benchlist 0-100; the two are the same number |
| 16 | google/gemini-3.7-flash | Gemini 3.7 Flash | no | MVBench 82.2 (benchlist, self-reported) | none |
| 17 | bytedance-seed/seed-2-1-turbo | Seed 2.1 Turbo | no | LongVideoBench 0.806 (llm-stats); Video-MME 89.0 (BenchLM, aggregate with no subtitle split) | Video-MME with no split: do not use as "wo sub" |
| 18 | xiaomi/mimo-v2.5 | MiMo-V2.5 | no | Video-MME w/ subs 87.7 (BenchLM) | none |
| 19 | google/gemini-2.5-pro | Gemini 2.5 Pro | no | VideoMMMU 83.60 exists only for "Gemini 2.5 Pro Preview 06-05" (llmboard) | [identity uncertain] different version from the id (06-05 is not the 2025-06-17 id); do not assign the score |

Notes:
- Main score: only items 1 to 6 have Video-MME-v2. The other 13 have no main score.
- Items 7 and 8 cannot enter the weight without resolving the identity. Conservative: use neither until confirmed.
- The VideoMMMU and MMVU numbers come from aggregators and are not comparable with Non-Lin (section 1).
- I found no aggregator score for gemini-3.8-flash, muse-spark, kimi-k3, glm-5v-turbo, mimo-v2.6 or qwen3.8-omni-flash. Those ids stayed without a score in this research [unverified].

## 3. Secondary benchmarks

For the ids with no main score. All the numbers below come from aggregators or authors, not measured here.

| Benchmark | Primary source (read) | Leaderboard status | Aggregators with 2026 numbers |
|---|---|---|---|
| VideoMMMU (Δknowledge) | https://arxiv.org/abs/2501.13826 (ACL 2026 main) | official leaderboard undated and only with old models (top Claude-3.5-Sonnet 65.78); does not cover the candidates | BenchLM (data as of 2026-11-07, "self-reported" according to the page FAQ); llmboard ("Updated Nov 6, 2026", rows with "Nov 7, 2026"; evidence level C) |
| MMVU | https://arxiv.org/abs/2501.12380 (3,000 questions) | official leaderboard did not render | BenchLM (2026-11-07) |
| MVBench | I did not read the official source (https://huggingface.co/spaces/OpenGVLab/MVBench_Leaderboard) [unverified] | aggregator only | llm-stats (Sep/2026); benchlist (2026-08-26); anotherwrapper (2026-09-05) |
| LongVideoBench | I did not read the official source [unverified] | aggregator only | llm-stats (Aug/2026) |
| Video-MME w/ subs | https://video-mme.github.io (leaderboard frozen on 2025-09-28) | the official one has nothing from 2026 | BenchLM ("videommewithsub", 2026-11-07, vendor-reported) |

VideoMMMU scores (BenchLM, 2026-11-07, self-reported according to the FAQ): Qwen3.8 Max 88.7; Gemini 3 Pro 87.6; Kimi K2.5 86.6; GPT-5.2 85.9; Qwen3.7 Plus 85.4; Qwen3.5 397B 84.7; MiniMax M3 84.6; Qwen3.6-27B 84.4; Qwen3.6 Plus 84.0; Qwen3.6-35B-A3B 83.7.
VideoMMMU scores (llmboard, level C, unverified): Gemini 3 Flash 86.90; Gemini 3.1 Flash-Lite 84.80; Gemini 2.5 Pro Preview 06-05 83.60; Qwen3.5-27B 82.30; Qwen3.5-122B-A10B 82.00; Qwen3.5-35B-A3B 80.40; Seed 2.0 Mini 80.60.
Date discrepancy: the BenchLM page shows "Oct 15, 2026" in a snippet and "Last updated: November 7, 2026" on the page read. Recorded, not resolved.
MMVU (BenchLM, 2026-11-07, unverified): Qwen3.8 Max 82.4; GLM-5.3-Flash 80.5; Kimi K2.5 80.4; dots3-note 79.9; Qwen3.5-122B-A10B 74.7; Qwen3.5-27B 73.3; Qwen3.5-35B-A3B 72.3.
MVBench: GLM-5.3-Flash 0.778 (llm-stats); Gemini 3.7 Flash 82.2 (benchlist, self-reported); GLM 5.3 Flash 77.8 (benchlist); Qwen3.5-122B-A10B 76.6 (anotherwrapper); Qwen3.6-27B 75.5 (anotherwrapper).
LongVideoBench: Seed 2.1 Pro 0.806; Seed 2.1 Turbo 0.806; Kimi K2.5 0.798 (llm-stats, Aug/2026).
Video-MME w/ subs (BenchLM): Qwen3.8 Max 90.4; Gemini 3 Pro 88.4; Qwen3.7 Plus 88.0; Qwen3.6-27B 87.7; MiMo-V2.5 87.7; Qwen3.5 397B 87.5; Kimi K2.5 87.4; Qwen3.6-35B-A3B 86.6; MiniMax M3 85.4.
Video-MME with no split (BenchLM aggregate): Seed 2.1 Pro 89.2; Seed 2.1 Turbo 89.0; Kimi K2.5 87.4. Do not use as wo sub.

Conflicts between sources (recorded, not averaged):
- MMVU, Qwen3.8 Max: 82.4 (BenchLM). No second source.
- Video-MME, Qwen3.8 Max: 90.4 w/ subs (BenchLM "videommewithsub"). No-subtitle version not found.
- Video-MME v2, Kimi-K2.5: 61.1 (benchmarklist) vs 54.4 in the paper. Metric not identified on the aggregator. Take the paper as the reference.

Aggregator URLs: the exact links for the aggregators (BenchLM, llmboard, llm-stats, benchlist, anotherwrapper) are not recorded in this version of the file. Before using any of these numbers in a weight, open the page and confirm the number and the date. [URL not recorded]

Candidates with no score from any source: gemini-3.8-flash, meta/muse-spark-*, moonshotai/kimi-k3, moonshotai/kimi-k3.1-pro, google/gemini-4-argon, google/gemini-omni-*, xiaomi/mimo-v2.6-*, qwen/qwen3.8-omni-flash, qwen/qwen3.8-flash, qwen/qwen3.8-27b, z-ai/glm-5v-turbo, z-ai/glm-4.6v, bytedance-seed/seed-1.6*, google/gemini-2.5-flash*, other ids with no score [unverified].

## 4. Video judging benchmark: not found

The premise of a "video judging benchmark" was not confirmed.
- VideoJudge (https://arxiv.org/abs/2509.21451, submitted 2025-09-25, "work in progress"): it is a 3B and 7B judge model, not a benchmark. The abstract I read gives no human-agreement numbers.
- Other 2026 judge papers (2604.17768, 2606.02578, 2603.11665, 2606.19544): they are general multimodal or text-only, not video.
- Conclusion: no benchmark I read measures the quality of a model's judgment on video. A benchmark-weighted jury measures video understanding, not the ability to judge animation, pacing or reading of action.
- Recommendation (not verified in practice): calibrate the jury with a small set of gameplay clips labeled by humans, and measure each judge's agreement with those labels before giving weight. Cost not measured.

## 5. Recommended next steps

1. Decide whether the weight comes from Video-MME-v2 (only 6 ids) or from our own calibration. With 6 ids, the jury of 9 does not fit the main benchmark.
2. Resolve the identity of qwen/qwen3.8-max-0902 and qwen/qwen3.8-max-prime before using any of their numbers.
3. Open the aggregator pages and record the exact URLs (see section 3).
4. If Video-MME-v2 will be run on the candidates, the public dataset is at https://huggingface.co/datasets/MME-Benchmarks/Video-MME-v2. Cost not measured.
