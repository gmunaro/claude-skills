---
name: curation
description: Curation, the paid jury that judges and generates media (image, audio, video). Use to choose between 2 to 4 versions of an asset (art, screenshot, speech, music, clip), to score an asset in a hill climb, to generate new candidates of an asset, and when the user runs /curation.
---

# Curation

The council judges text with free models and Claude on subscription. Curation judges and generates **media** with paid models, which the owner authorized on 2026-11-07 for this purpose only. The council's rule does not change: the prompt review runs in the council with the council's lineup.

Scripts are in `scripts/` (Node 24, no dependencies):

| Script | What it does |
|---|---|
| `curation.mjs` | jury, player context, judging round (decision, scores, vote) |
| `generation.mjs` | top generators per category and generation of 1 candidate per generator |
| `prompt.mjs` | jury critiques, recommended prompt, council review, loop |
| `context.mjs` | library: player context and option anonymization |

Validation, quorum, tally, agreement and the table come from `../council/scripts/`, imported. Read section 1 of the [council skill](../council/SKILL.md) for triage and [hill-climb.md](../council/hill-climb.md) before a hill climb.

## Catalog modalities

OpenRouter declares in `architecture` what each model takes in and puts out. Curation uses both lists explicitly:
- **Juror** (media-to-text): `input_modalities` contains the round's media and `output_modalities` contains `text`. The round checks this against the live catalog. A model that left, stopped accepting the media, or stopped answering in text is out, with the reason and no substitute.
- **Generator** (text-to-media): `output_modalities` contains `image`, `video`, `audio` (music) or `speech` (speech). The query uses `/models?output_modalities=all`, because the default list only returns models with text output.

## Flows

Working folders go in `C:/tmp/curation/` or the task's scratch, never in the game repo. The game repo is read-only. Each command below states input, output, done and how to read it.

### 1. Jury (`curation.mjs jury | build-jury`)

Snapshot per category in `data/jury-<category>.json`: up to 9 jurors, the benchmark (name, version, source, date), price, effort and shortfalls.

| Category | Weight benchmark | Jury (2026-11-07) |
|---|---|---|
| image | Arena Vision | the 4 current Claude + 5 best non-Claude |
| audio | MMAU-Pro | 6 with a score + 3 at floor weight |
| video | Video-MME-v2 (Non-Lin, no subtitles) | 6 with a score + 3 at floor weight |

- Weight: the council's three levels, using the category benchmark score (published, estimated, floor).
- To rebuild: edit `data/scores-<category>.json` and run `build-jury --category C --scores scores.json` (image: `--current-claude`). A score only counts when the benchmark model and the OpenRouter id are unambiguously the same model.
- Each round compares the snapshot with the current catalog and writes `jury_changes` (entered, left, warning). With a warning, run `build-jury` before the next round.

### 2. Player context (`curation.mjs build-context`)

`node scripts/curation.mjs build-context --target target.json --root <game repo> --out context.json`

- `target.json` input: `{ media: image|audio|video, subtype: music|speech (audio), name, appears_in: { screen, size_px (image and video), moment }, current_asset, canon (text or { file, excerpt }), scene (music and video), npc (speech) }`.
- Reads, read-only: `docs/v3/ART_DIRECTION.md` (the media's sections), `game/assets/palette.json` (32 colors), `docs/v3/voice/cast.json` and `docs/v3/voice/lines/<npc>.json`.
- Output: `context.json` with each field, its source file and sha256, and the block's sha; and `context.block.txt` next to it, the exact text that jurors and the recommender read (the context's sha is the block's).
- Refuses if a required field, the current asset or a source is missing.
- Done when it writes and prints the sha.
- The block goes identically to every juror through the round's `--context` flag. It does not mention the current asset.

### 3. Judge (`curation.mjs run`)

1. **Triage** as in the council: decision (2 to 4 versions), scores (hill climb) or fact/oracle (does not run).
2. **Input**, with minimal examples:
   - Decision: `{ "question": "Which Crowmother portrait to use?", "options": [{ "id": "c1", "text": "portrait with open wings", "media": ["c1.png"] }, { "id": "c2", "text": "profile portrait", "media": ["c2.png"] }], "categories": ["readability_on_screen", "fidelity_to_canon"], "evidence": "facts common to the options" }`
   - Scores (`--mode scores`): `{ "objective": "Scores for the Crowmother portrait", "categories": ["readability_on_screen", "palette"], "anchors": "", "media": ["portrait.png"] }`
   - Agreement vote (`--mode vote --items items.json`): `{ "artifact": "what the items fix", "media": ["portrait.png"] }`, with items `[{ "id": "V1", "section": "...", "problem": "...", "fix": "..." }]`.
   - Categories, at least 2 and the same in every round of a target. Examples: image `fidelity_to_canon,readability_on_screen,palette_and_outline`; music `fidelity_to_canon,mood_and_loop,timbre_and_mix`; video `fidelity_to_game_art,scene_readability,represents_the_game`.
   - Formats: image png, jpg, webp; audio ogg, wav, mp3, flac (wav or mp3 for `gpt-audio`); video mp4, webm, mov (video accepts an audio attachment).
3. **Anonymity (decision).** Option letters are drawn with a seed (`--seed` or random) and the order is shuffled. The letter-to-option map is in `map.json`, in the output folder, outside the jurors' packet; `decision.json` carries `original_choice`. The round refuses an option whose text, id or file name mentions "current", a model or a cost. A category that rewards the status quo (`ready_to_use`, `consistency_with_current`) produces a warning in `category_warnings`: replace it with facts common to the options.
4. **Estimate**: `run ... --estimate-only`. It needs no key, does not run the Claude probe, and returns `projected_usd` (paid only, OpenRouter) and `claude_subscription_equivalent_usd` separately. If the projection is above the cap, shrink the packet (fewer attachments, shorter clip) and measure again.
5. **Run**: `node scripts/curation.mjs run --category C --input input.json --out new-folder --cap 3 [--mode scores|vote] [--context context.json]`.
   - With `--context`, the block's sha is recomputed and must match the `sha256` in context.json. A context edited by hand after `build-context` is refused. The recomputed sha goes in `collection.context_sha256`.
   - Everyone runs in parallel and starts together. The check before spending is on the projection (the round refuses if the summed projection is above the cap, and each juror reserves its own projection). Measured spend is only known afterwards and is checked in `cost.json` (`within_cap`, against `spend_limit_usd`).
   - Invalid JSON gets one resend, if it fits in the cap.
   - A Claude that fails the probe is out of the round (route `none`, no paid fallback). Only with `--claude-openrouter` does it go through OpenRouter, with its cost in the projection. In both cases the result carries `route_warnings`.
   - A paid call is resent only on 429 or 5xx with a response. After a network error or a timeout there is no resend: the juror goes into `uncertain_costs` and its projection is added to `spend_limit_usd` in `cost.json` (that is the value that counts against the cap and in the loop).
   - Done when the folder has `collection.json`, `cost.json`, `table.html` and the result (`decision.json`, `scores.json` or `agreement.json`).
6. **Read the result**:

| Result | Action |
|---|---|
| `decision` | proceed with `original_choice` |
| `divergence` | goes to the owner with the best argument from each side. In the loop (flow 8) it does not: in j1 the tiebreak is the highest weighted score; in judge_final, if the current one loses, it is replaced by the one with the highest mean across categories |
| `missing_fact` | find the fact and run once more |
| `insufficient` | report the reasons; with no quorum twice, stop |

   Anyone who failed shows up in `discarded` and in the table, with no zero score and no substitute.

   **Two scales.** The score from `--mode scores` and the per-category score that comes out of a decision do not compare: the decision's came out 1.1 to 1.3 points higher for the same piece (AAA body, 2026-11-09). When you cite a score, say which scale it came from.

   **The absolute score is not a goal.** It stayed between 5.7 and 6.1 across three versions that the blind vote ranked 8 to 1 and 9 to 0, and the same version varied 0.76 from one jury to another. A round is accepted by the blind decision of the candidate against the previous version; the scores say which category to attack and stay in the record.

   **Head-to-head of 2.** With 4 similar sheets the vote spread out and gave `divergence` (2 of 2); the decision between 2 options separated 9 to 0. In a round-based hill climb, accept the round by judging the candidate against the previous one, with no third options. That head-to-head closes the current round; it does not count as a new round. The flow 8 loop builds its own finalists and follows its own count.

   **Cap of 3 rounds** per target in any jury loop (owner, 2026-11-09); the baseline does not count. Each round attacks the lowest categories with a local fix: the rounds that changed the piece's structure lost 2 of 2. Whoever edits SVG between rounds is Fable 5.2 high (type 17 of the `swarm`).

   **Outside reader.** A category that measures someone who arrives with no context ("understands without having played") stays out of the jury with `--context`: it goes to the council's cold reader.
7. **Show** `table.html` in T3 (`html_preview`, then `html_render`) and cite the measured cost from `cost.json` against the cap.

### 4 to 8. Generate candidates, prompt and loop

To build the generator top (4), generate candidates (5), take the recommended prompt from the critiques (6), take it to council review (7) or run the loop judge → recommend → review → generate → judge (8), read [generation.md](generation.md). A judging-only round does not need it.

## Scoreboard

One line per paid round in the `swarm` scoreboard, in the format and the writing method of its "Verify and close" section (through the shell, without opening the file). The type is 16; the method is `curation-<category>-<mode>` or `curation-generate-<category>`; the result carries valid/planned and the measured cost; the reason says what the round taught.

## Known limits

- No benchmark measures aesthetic judgment of media. Arena Vision measures general human preference; MMAU-Pro and Video-MME-v2 measure comprehension. Calibrate with human-labeled pairs before an expensive decision (ParaPairAudioBench measured audio judges 32 points below humans).
- An audio jury does not judge the timbre of a voice well (measured on front v07, 2026-11-07): use it for reading, rhythm and coherence, not to choose the voice.
- Lyria 3 Pro (2026-11-07): 30 s track in clip and up to 104 s in pro; asking for wav returns an empty stream, use mp3.
- Gemini Omni (2026-11-07): reference only at 640x360 and no `generate_audio`; 0.069504 $/s at 720p.
- Speech only judges: the speech generation route was not verified. `build` writes the speech subtype with `judging_only` and reason `no_verified_route`, and `generate --category speech` exits before the estimate with `zero_candidates` and that reason, until someone measures the route.
- Video-MME-v2 only covers models up to Feb 2026.
- Arena Vision scores are almost equal to each other (1261 to 1296): the image vote weighs almost equally.

## Tests

`node --test scripts/*.test.mjs` covers jury, rotation, anonymity, context, duration, cap, resend, Claude route, the scores and vote modes, generation, the generate → for-judging → run handoff, prompt and loop, all with a simulated network and no spend. When you change something the council exports, also run `node --test` in `../council/scripts/`.
