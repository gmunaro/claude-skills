# Curation: generate candidates, prompt and loop

Reference for the `curation` skill, flows 4 to 8. Flows 1 to 3 (jury, player context, judge) and the rules on scales and the round cap are in [SKILL.md](SKILL.md). Scripts are in `scripts/`, with the same shortcuts as in SKILL.md.

### 4. Generators (`generation.mjs build`)

`node scripts/generation.mjs build --category image|video|audio --ranking ranking.json`

- Ranking: the generation benchmark (name, version, source, date) and the models in order, with price and `identity_checked` (`{ checked, source, date, verified, mismatched, manual_review }`).
- Top: the ranking crossed with the media's output catalog, in order, up to 3 per category or audio subtype (conductor decision, Nov 8). It does not fill up with models from outside the ranking.
- A model that only has a per-token price leaves as `no_estimate`, with no substitute.
- Image with a cost measured in real calls (`price.measured`: a list of `{ usd, file, date }` in the ranking) uses the largest measured value; the price's `origin` says which file it came from. The 2026-11-08 image top carries the costs from the Crowmother oracle (gpt-image-2.6-sunburst and 2.5-flare up to $0.0646, against 0.0336 from the catalog).
- Writes `data/generators-<category>.json`, with top, entered, left, `absent_from_catalog` and `no_estimate`.
- Unchecked identity or an empty top gives state `judging_only`: the category only judges.

Current rankings (research of 2026-11-07, identity checked by name on 2026-11-08):

| Category | Benchmark | Top in the 2026-11-08 catalog |
|---|---|---|
| image | Arena Text-to-Image | gpt-image-2.5-sunburst, gpt-image-2.6-sunburst, gpt-image-2.5-flare |
| video | AA Video Arena (with audio) | wan-3.0, heygen-video-1 (seedance-2.5 has no estimate) |
| music | AA Music Arena | lyria-3-pro-preview |
| speech | AA TTS Arena | eleven-v4, eleven-v4-turbo (gemini-3.8-flash-tts has no estimate); `judging_only`: speech only judges |

### 5. Generate (`generation.mjs generate`)

`node scripts/generation.mjs generate --category image|video|music|speech --prompt prompt.json --out new-folder --cap 3 [--estimate-only] [--catalog models.json]`

- `prompt.json` input: `{ text, duration_s (video, default 7), resolution, aspect_ratio, references }`. It accepts the `prompt-revised.json` from flow 7, which carries the same `references`, `aspect_ratio`, `resolution` and `duration_s` as the previous prompt.
- Order: pre-checks that cost nothing, live catalog, estimate, cut, generation.
  - Pre-checks: `OPENROUTER_API_KEY`; access to `/videos/models` for video. `generate` does not use ffmpeg.
  - Live catalog: the saved top is checked against `/models?output_modalities=all` (a free GET, also with `--estimate-only`; `--catalog` uses a saved file). A model that left or lost the media's output goes to `cuts` with `left_catalog`, with no substitute; if nobody is left, `zero_candidates`. An unavailable catalog is an error, not a fallback. A top built more than 14 days ago goes out with a warning in `warnings`.
  - Estimate per image, per second of video, per track or per character.
  - Cut of the top in ranking order when it goes over the cap, recorded in `cuts`.
  - Generation: 1 candidate per generator, one at a time, no resend (resending a paid generation would charge twice).
- Routes: `/images` for image; `/chat/completions` with streamed audio, read to the end, for music; `/videos` with job polling for video.
- Deadline: 5 min for image and audio, 15 min for video.
- Output: `candidates.json` with each candidate's model, prompt, projected and measured cost, file, sha and state, and `prompt.json` (the prompt used, which serves as `--previous` in `recommend`). A failure is listed, with no substitute.
- Round states:

| State | What to do |
|---|---|
| `ok` | proceed to judging with the candidates and the current asset |
| `no_key` | stop: a credential is missing |
| `no_video_access` | video only judges |
| `cap_exceeded` | nothing fit in the cap: shorten the clip or raise the cap with a recorded decision |
| `zero_candidates` | empty top or all failed: report and only judge |

- Video: each generator uses by default the resolution of the SKU that gave the price (`price.resolution` in the top; e.g. wan-3.0 720p, heygen-video-1 1080p). Asking for another resolution only works if the ranking has its price (`price.by_resolution`); with no price, the generator leaves as `no_estimate` before any call.
- Done when it writes `candidates.json`.
- **Hand over to judging**: `node scripts/generation.mjs for-judging --candidates a/candidates.json[,b/candidates.json] [--files x.png,y.png] --current <current asset> --out judging-folder --categories a,b[,c] [--question text]`. `--categories` is required, with at least 2: without it the decision comes out without per-category scores and the recommender without the `gap` fields. Examples: image `fidelity_to_canon,readability_on_screen,palette_and_outline`; music `fidelity_to_canon,mood_and_loop,timbre_and_mix`; video `fidelity_to_game_art,scene_readability,represents_the_game`. Use the same ones in j1 and j2. `--candidates` accepts candidates from several generations; `--files` brings loose files (for example the chosen one from an earlier decision, with origin `file`). It copies the `ok` candidates, the files and the current asset under a neutral name (`option-N.ext`, in sha256 order), writes the same text for all, and writes `input.json` (ready for flow 3) and `origin.json` (option → generator, file or current, always with the path in `file`), kept outside the packet. It accepts 2 to 4 options in total and refuses two sources with the same content (sha256).

### 6. Recommended prompt (`prompt.mjs critiques | recommend`)

- `node scripts/prompt.mjs critiques --folder round [--options A,B] [--origin origin.json]` lists the jury's critiques: `fix_points`, `gap` and reasons. It reads the round's `map.json` and `origin.json` (from `for-judging`) and writes the letter, the original id and the origin (generator or current) on each critique. `--options` accepts letters or original ids.
- `node scripts/prompt.mjs recommend --folder round --context context.json --generator generator.json --previous prompt.json --out dir [--origin origin.json]` asks a Claude through the proxy for the prompt for the chosen generator. Its inputs are the critiques, the player context, the limits, the capabilities (reference, maximum duration, audio), the price resolution and the generator's note, and the previous prompt.
  - `--previous` accepts the `prompt.json` of the previous generation (the `text` goes to Claude; `references`, `aspect_ratio`, `resolution` and `duration_s` are copied to `prompt.json` and, in flow 7, to `prompt-revised.json`) or a `.txt` without those fields. Use the `.json`: with the `.txt` the 2nd generation comes out without the reference.
  - `--context` accepts `context.json` (the block is built and the sha checked; a mismatched sha is refused) or `context.block.txt`.
  - `generator.json`: `node scripts/generation.mjs generator --category C (--model <id> | --position N) --out generator.json` writes the top item (refuses one that is not in it). Pick the generator of the one chosen in j1 (`loop-chosen` carries the `model`); if the chosen one is the current asset, the 1st of the top.
  - `--previous`: the `prompt.json` that `generate` writes next to `candidates.json` (`{ text, references, aspect_ratio, resolution, duration_s }`).
- `prompt.json` output: the text, the generator, the context's sha and each change with its source critique (`source_critique`). It refuses a change without a source critique.
- Done when it writes `prompt.json`.

### 7. Council review (`prompt.mjs prepare-review | apply-review`)

1. `prepare-review --prompt dir/prompt.json --context context.json --out dir` writes `items.json` (one change per item) and `packet.txt` (the council's agreement vote).
2. The conductor runs the vote in the council, with its default lineup, in folder `dir` (`C` = `node ../council/scripts/council-t3.mjs`):
   1. `C prepare --thread <conductor thread id> --prompt packet.txt --use-packet --output batch --phase vote --claude default --label "prompt review <target>"`
   2. `C pending --plan batch/plan-t3.json` and one `delegate_task` per listed call (same `task`, `target`, `title` and `clientRequestId`); after each dispatch, `C register --plan batch/plan-t3.json --id <clientRequestId> --task <taskId>` (`--failure "<text>"` when the task fails).
   3. With the Claude reviews and the first wave of free models back: `C close --plan batch/plan-t3.json --items items.json`.
   4. `C agreement --plan batch/plan-t3.json --items items.json > agreement.json`.
3. `apply-review --prompt dir/prompt.json --agreement agreement.json` applies only the changes with agreement from 7 to 10 and writes `prompt-revised.json` (applied and discarded, with mean and reason). The state is `revised`, `none_applied`, `no_quorum` or `no_recommendation`. The threshold is never below 7, even if agreement.json carries another one (the file's value goes in `file_threshold`). With all changes approved, the text is the recommended prompt the council voted on, with no new call (`via: recommended_voted`). With some approved, a Claude recomposes the previous prompt using only those and returns the `applied` list, which must equal the approved ones (one resend; if it persists, `no_recommendation`). The line diff against the previous prompt is in `diff`. Outside `revised` the revised prompt is not produced: inside the loop (flow 8) the iteration ends; outside it, generate with the previous prompt or stop.

### 8. Loop (`prompt.mjs loop-*`)

Stages: judge, recommend, review, generate and judge_final. At most 1 iteration per request; a request is one generation of one target. Before the loop there is a generation with the old prompt (flow 5, outside the loop, with its own cost): its candidates are the "old prompt" ones.

Script of one iteration (`P` = `node scripts/prompt.mjs`, `G` = `node scripts/generation.mjs`, `J` = `node scripts/curation.mjs`, `L` = `--loop it/loop.json`):

0. **create**: `P loop-create --target <target> --out it` writes `it/loop.json` with the caps ($3 per stage, $9 per iteration).
1. **judge**: `G for-judging --candidates g1/candidates.json --current <current asset> --out it/j1 --categories <a,b,c>`; `J run --category C --input it/j1/input.json --estimate-only --cap 3 --context context.json`; `P loop-can L --stage judge --projected <projected_usd>`; `J run --category C --input it/j1/input.json --out it/j1/round --cap <stage_cap_usd> --context context.json`; `P loop-record L --stage judge --files it/j1/round/cost.json`. Then: `P loop-chosen L --judge it/j1` writes to `loop.json` the one chosen in j1 (`chosen_j1`: file, option, origin, model). With `decision`, it is the jury's choice. With `divergence`, it is the option with the highest weighted mean (`via: tiebreak`; an exact tie goes in `tie` and the first letter wins) and the loop goes on: that is how the Crowmother measurement reached the gain (8 of 9 votes). `insufficient` or `no_quorum` do not choose: record the stage with that state and the iteration ends.
2. **recommend**: `P recommend --folder it/j1/round --origin it/j1/origin.json --context context.json --generator generator.json --previous old-prompt.json --out it/rec`; `P loop-record L --stage recommend --state ok` (Claude on subscription, cost 0). If `recommend` exits with an error (proxy down, invalid JSON twice), record `--state no_recommendation`: the iteration ends.
3. **review**: `P prepare-review --prompt it/rec/prompt.json --context context.json --out it/rev`; vote from flow 7 in `it/rev`; `P apply-review --prompt it/rec/prompt.json --agreement it/rev/agreement.json --out it/rev`; `P loop-record L --stage review` with the state of `prompt-revised.json` (`revised` records `ok`; `no_quorum`, `none_applied` and `no_recommendation` end it, because generating again with the same prompt spends without teaching anything).
4. **generate**: `G generate --category C --prompt it/rev/prompt-revised.json --estimate-only`; `P loop-can L --stage generate --projected <projected_usd>`; `G generate --category C --prompt it/rev/prompt-revised.json --out it/g2 --cap <stage_cap_usd>`; `P loop-record L --stage generate --files it/g2/candidates.json`.
5. **judge_final**: `P loop-finalists L --revised <all ok candidates of g2, in candidates.json order> --old <chosen in j1> --current <current asset>` (at most 4 options: the first ones from g2 stay, the rest go to `cut`). If the current asset won j1, there is no distinct old one: pass `--old none` (the old one is left out and one more candidate from g2 comes in); an old one equal to the current one is refused; `G for-judging --files <finalists from loop.json, minus the current one> --current <current asset> --out it/j2 --categories <the ones from j1>`; `J run --category C --input it/j2/input.json --estimate-only --cap 3 --context context.json`; `P loop-can L --stage judge_final --projected <projected_usd>`; `J run --category C --input it/j2/input.json --out it/j2/round --cap <stage_cap_usd> --context context.json`; `P loop-winner L --judge it/j2` writes to `loop.json` the winner (`final_winner`: file, option, origin, model and `via`); `P loop-record L --stage judge_final --files it/j2/round/cost.json`. Owner rule (Nov 8): "if the current one loses, replace it". With `decision`, the jury's choice wins (`via: decision`). With `divergence`, the option with the highest mean across categories (`scores_by_category` in `decision.json`) wins if that mean is higher than the current one's (`via: tiebreak`; an exact tie between candidates goes in `tie` and the first letter wins). If the current asset has the highest mean or ties, the current one stays (`via: current`). Divergence closes as `ok`, not as a failure. With no score for the current asset in `scores_by_category`, the command refuses instead of guessing. `insufficient` or `no_quorum` do not choose: record the stage with that state.

- `loop-can` refuses when the projection is above the stage cap or the recorded spend plus the projection is above the iteration cap. When approved, it returns `stage_cap_usd` (the smaller of $3 and the iteration's balance, without subtracting the projection): that is the `--cap` for the stage's `run` or `generate`. `remaining_usd` is the iteration's balance.
- `loop-record` reads the cost from the files in `--files` (`cost.json`: the larger of `measured_usd` and `spend_limit_usd`, which includes the projection for jurors with an uncertain cost; `candidates.json`: measured plus the projection for the uncertain ones); a typed `--cost` that does not match is refused. Measured spend above the cap ends the iteration in `cap_exceeded`. Claude on subscription does not count toward the dollar cap.
- Accepted failure states: `no_quorum`, `insufficient`, `none_applied`, `no_recommendation`, `zero_candidates`, `cap_exceeded`, `no_key`, `no_video_access`. Any of them ends the iteration; record it and report. `divergence` is not a failure state: `loop-record` refuses it in judge and in judge_final (record `ok` and run `loop-chosen` or `loop-winner`).
- `loop-next` says the next stage. Done when `loop.json` has a final state and the cost of each stage.
