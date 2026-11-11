# Weighted execution

## Inventory before voting

- Read `https://openrouter.ai/api/v1/models`. Save the date, IDs and prices. Check every price component that applies to the request, not just input and output. A `:free` suffix alone does not prove the price; an advertised price of zero does not prove availability.
- Cross-check with `/v1/models` on the active CLIProxyAPI. For OpenRouter, use the proxy's authenticated route and enforce a maximum price of zero when that option is supported. Keep the exact free ID and disable paid fallback.
- Query the execution tool's capabilities for the efforts of each model. Confirm the mapping all the way to the backend. A pair rejected as an invalid effort is marked `unsupported`, with the error recorded. An effort that is accepted but whose effect is not confirmed is marked `requested_unconfirmed` in the report.
- Models that do not produce a text review, aliases with no resolved identity, and unavailable endpoints are listed with the reason. Do not silently swap a classifier for a chat model.
- Claude joins with a subscription or organization credit authorized by the owner, proven by a real call. The probe uses the proxy and the T3 route, with no paid-API fallback. Do not retry several times when the response already reports missing credits.
- The list of available models is frozen before the votes. A later failure is recorded in `discarded` and stays out of the quorum denominator (rule of 2026-11-07). Discovering an unsupported effort requires a new manifest before the count is redone.

`scripts/council-t3.mjs` expands the inventory pairs: `freeJobs(catalog, proxyIds, variants)` for the free models and `parseClaude(spec)` for the Claude lineup. `prepare` uses both and runs the Claude probe.

## Intelligence Index

Before collection, run `scripts/update-indices.mjs`. With a key, the current endpoint, per the [official OpenAPI](https://artificialanalysis.ai/api/v2/openapi), is `GET https://artificialanalysis.ai/api/v2/language/models/free`, authenticated with `x-api-key`. Use all pages and the `intelligence_index_version` field from the response. The old endpoint `/api/v2/data/llms/models` returned 410 when checked on 2026-11-06.

Without a key, query `https://artificialanalysis.ai/models` and the verified official pages listed in `~/.cache/council/public-sources.json`. `scripts/public-indices.mjs` reads the model objects already delivered in the public HTML, without running scripts or touching authenticated data. It requires a stable identity, an `intelligenceIndex` field and an explicit version. It records the page URL and hash, the evaluated configuration, and `coverage: partial_queried_pages`. Add other pages only after verifying the model's identity. The main page may show only a selection; do not claim to have downloaded the whole catalog.

The local snapshot is replaced only after collection finishes and the data is validated. A missing index is `null`, never zero. The daily update runs at 06:00 and at logon, scheduled once by `scripts/register-update.ps1`, which also runs `council-t3.mjs pool --force` (the day's free pool, showing who joined and who left). The council requires a cache less than 24 hours old even if the scheduled task fails. With no network, or if the site changes its format, report the block and keep the old data, marked as stale, without using it for an automatic decision. When showing the data, credit Artificial Analysis as the source.

`prepare` reads that snapshot and writes each pair's index into the plan. `indexFor` in `scripts/council-t3.mjs` matches by the exact effort slug (Claude) or by `openrouter_api_id` when available. The free endpoint may omit that field: in that case, record the verified association between model ID and `aa_id` in `~/.cache/council/mappings.json`, with `evaluated_config`. A key can be the model ID or the serialized pair `[model, effort]` for a specific configuration. Do not match by textual similarity. Without a single match, the index stays missing.

Prefer the Artificial Analysis Intelligence Index, queried at the official source for the exact identity and the evaluated configuration. Save `value`, `scale`, `version`, `source` and `queried_at`. Scores can change with the benchmark version; do not assume a fixed scale of 0 to 100.

Do not mix the Intelligence Index with Elo, LiveBench, coding rankings or the agent's opinion. If only another metric exists, record it as additional information. It does not become an Intelligence Index weight.

When a model's base index stands in for several efforts, record that reuse in `evaluated_config` and state the limitation. Do not claim to have measured an index per effort. Without a confirmed identity or source, use `index: null`. The review then weighs by the estimate in `estimated-indices.json`, if there is one, or by the floor, and the pending item goes in the report.

Several efforts of the same model may agree because they share training. Those votes keep the weights the owner asked for; do not present their agreement as independent statistical evidence.

## Isolated reviews

Cost scope: the owner's explicit choice of a paid model in T3 Code applies to that conversation or role. It does not widen the council lineup. The orchestrator's main conversation stays outside the `[COUNCIL_FREE_ONLY]` marker; apply the marker to the voters' OpenCode sessions. Claude joins through T3's Claude provider (`providerInstanceId: claudeAgent`), via CLIProxyAPI, with a subscription or organization credit authorized by the owner and proven by a real call on that route. It never joins through the paid OpenRouter API.

Mandatory preflight: confirm on the execution instance that the `council-free-only.ts` plugin is loaded, that `small_model` and the effective models for `title`, `summary` and `compaction` are free, and that OpenRouter points to the proxy. Run the tests `node --test ~/.config/opencode/council-free-policy.test.mjs ~/.config/opencode/council-free-plugin.test.mjs` when you change the protection. An instance that is already running must reload the configuration before the real tests.

Prefix every voter's OpenCode task with `[COUNCIL_FREE_ONLY]`. The marker turns on protection for the whole session; it does not change the question or reveal the count to the voters. Do not launch a session without the marker. The protection requires a confirmed price of zero and applies `provider.max_price.prompt = 0`, `provider.max_price.completion = 0` and `provider.allow_fallbacks = false` to the final request. If the catalog is missing or a fallback is attempted, stop without sending the call. Titles, summary and compaction are protected even outside marked sessions.

The owner asked for dispatch by script with the same packet for everyone, visible in this same T3 thread. Use this skill's `scripts/council-t3.mjs`, described below. Read `swarm` before native delegations, with provider, model and effort explicit. Claude reviews, when authorized and operational, use `delegate_task` with `providerInstanceId: claudeAgent`, the model ID and `options.effort`. The default Claude lineup (`--claude default`) is Haiku 5.5 and Sonnet 5.5 at low, medium and high, and Opus 5.5 at low and medium. Opus high is out by the owner's decision (2026-11-06). Fable 5.2 does not join: for judging and reviewing, Opus is enough as Fable's peer and is already in the lineup (SKILL.md, "The judge is no less capable than the producer"). The task is the same as for the free models, without the `[COUNCIL_FREE_ONLY]` marker, which exists only for OpenCode. Each pair's index comes from the Artificial Analysis page for that effort. After the round, add up the Claude participants' cost recorded in the proxy and compare it with the fixed ceiling.

### Script for the T3 thread

```text
node --test <skill>/scripts/council-t3.test.mjs
node <skill>/scripts/council-t3.mjs prepare --thread CURRENT_THREAD_ID --prompt packet.txt --output new-folder [--phase definition] [--claude default|none|claude-opus-5-5:low,high] [--free none] [--use-packet] [--opencode-url auto] [--enqueue]
node <skill>/scripts/council-t3.mjs pending --plan new-folder/plan-t3.json
node <skill>/scripts/council-t3.mjs register --plan new-folder/plan-t3.json --id CLIENT_REQUEST_ID (--task TASK_ID | --error MESSAGE | --failure NOTIFICATION_TEXT)
```

`prepare` reads the OpenRouter catalog and the proxy's `/v1/models`, finds the local OpenCode started by T3 (or uses `--opencode-url`), checks the free-only protection and the free auxiliary models, and runs a minimal Claude probe through the T3 route. It then matches each pair's index from the snapshot less than 24 hours old and writes `plan-t3.json`. If OpenCode is not running, first dispatch an OpenCode `delegate_task` so T3 starts the server. `--use-packet` keeps the packet at the given path instead of copying it. `--enqueue` sends the dispatch message to the thread with `t3 thread send`; without it, the orchestrator dispatches in the current turn. `--prompt` accepts a comma-separated list (the rotations from `decision-packet`), distributed round-robin in call order; the plan stores each one's path and SHA-256 in `packets`. `pending` returns the exact parameters of what to dispatch now: calls without a taskId, at most one per free model in flight (it reads the most recent `collection.json` to know who has finished), and the `-r1` resend for anyone marked `waiting resend`. `register` writes `dispatches.json` with all attempts. `cycle` is `collect` followed by `pending`. `prepare --no-history` ignores the reliability history; `prepare --image-input` keeps only free models that read images. `collect` reads 8 tasks at a time, each read capped at 30 s and the whole call capped at 2 min; whatever does not fit stays as it was and is read on the next pass, and valid and invalid results already read are not read again.

On receiving the dispatch, check the SHA-256 of the plan and the packet, read `native_batch`, and make the `delegate_task` calls in parallel. The task is the same for everyone and authorizes reading only the public packet. Save the taskIds and let the completion notifications wake the orchestrator; do not repeatedly poll tasks in progress. Failures stay in the report. If a call's transport fails without returning its ID, recover the identification before trying again. Do not resend a whole batch because of one participant.

The protection marker goes in each child's task, not in the queue message sent to the parent, to preserve the paid model the owner explicitly chose as orchestrator. The queue message only references the file and its hash. Request IDs are stable per thread, packet, model and effort; the script refuses to overwrite an existing batch.

### Direct HTTP, only when explicitly requested

In the folder `~/.t3/projects/mini-modelo-local`, run:

```text
node --test tests/council.test.mjs
node scripts/council.mjs --prompt .local/council/prompt.txt --output .local/council/round-1 --opencode-url http://127.0.0.1:PORT
```

Find the port of the active `opencode serve` instance; do not reuse an old port without checking. The OpenCode URL is used only to get the efforts and their options. Model calls go exclusively to `http://127.0.0.1:8317/v1`, with a ceiling of zero and `allow_fallbacks: false`. The script bypasses OpenCode sessions, so it generates no titles or other auxiliary calls. The credential comes from `CLIPROXY_API_KEY` or from the private file the proxy already uses, never from the prompt.

Use a new output folder on every run. `--max-tokens` and `--timeout-ms` set the budgets, by default 16,384 tokens and 120,000 ms. The run starts all calls before waiting for results. It saves `manifest.json`, one JSON per review, and `report.json`. Check the shared prompt hash, failures, truncation, availability and costs. A `200` does not prove the JSON follows the rubric; validate the scores separately. Do not treat a failure as a score of zero.

When the backend does not enumerate a model's efforts, the script runs `default` and flags that limitation. Do not announce coverage of levels that the provider did not enumerate or reject. Respect 429 without hammering the API and preserve the other models' reviews. Using `Promise.all` avoids serializing the models; do not repeat the whole packet just because one participant failed.

Each voter receives only the question, options, categories, evidence and response schema. It does not receive indexes, weights, quorum, the identity of the others or earlier results. Rotate the options: `decision-packet` writes one rotation per option and `prepare` distributes them. The same evidence goes to everyone. The packet's JSON example includes every required score (options × categories), because weak models copy the example. The voter does not research or edit files; since some edit anyway, the plan stores each packet's content and `collect` checks the SHA-256 on every cycle: an altered packet is restored, the change is recorded in the collection's `packet_changes`, and anyone who used that packet and finished after the change (having started before the restoration) is marked `suspect`. The vote still counts, and the mark appears in the table and in `decision.json`.

Each voter's return:

```json
{
  "vote": "A",
  "confidence": "high",
  "reasons": ["Fact from the packet that supports the choice"],
  "what_would_change_my_vote": "Evidence that would reverse the choice",
  "scores": [
    {"option": "A", "category": "reliability", "score": 9, "gap": "Limitation cited in the packet"}
  ]
}
```

Include one integer score from 1 to 10 per option/category. `gap` is required; `nothing` only goes with 10. `X` means a fact is missing, described in `missing`. The conductor attaches the model and effort from the run; they are not trusted from the voter's text.

## Failures and budget

- `429`: save `Retry-After` and the quota scope, reduce the provider's concurrency and respect the interval. Do not immediately repeat in parallel. In T3, record the notification text with `register --failure`; the participant gets a `-r1` resend, returned by `pending` after the wait, within the same 10-minute deadline. If the daily quota is gone, end the attempts that hit it. No paid model is an automatic substitute.
- `model_unavailable` in `delegate_task`: T3 does not advertise the model, so it was never eligible. Record it with `register --error`; it leaves the denominator and appears in `excluded_after_freeze`, with the reason.
- `finish_reason: length` or truncated JSON: discard the vote, preserve usage/cost, and retry at most once with a larger output budget. Reserve room for reasoning and JSON. Do not complete the vote by inference. Do not lower the requested effort without recording another pair in the manifest.
- Invalid JSON without truncation: at most one new attempt with the same schema. A terminal failure becomes a missing vote, not `X`.
- Limit attempts and total time before launching the batch. All attempts count in the telemetry; each model/effort pair counts at most once in the vote.

## Executable count

The packet comes from `council-t3.mjs decision-packet --input input.json --out packet.txt`, one rotation per option, with the return format above. In `gap`, markers such as `null`, `none`, `n/a` or `-` count as an empty field. The collection validates each vote with `collect --options A,B --categories ...`. Then:

```text
node <skill-folder>/scripts/tally.mjs --plan new-folder/plan-t3.json --options A,B
node --test <skill-folder>/scripts/tally.test.mjs
```

The counter reads `collection.json` from the same folder, refuses a collection that is still open, and writes `decision.json`. The indexes come from the plan frozen by `prepare`, never from the voter's text. It does not prove that the lineup is exhaustive or that a manual identity association is correct: that belongs to the inventory.

The weight of an option is the sum of the weights of the valid votes for it, using the three tiers in `scripts/weights.mjs` (published, estimated × 0.5, floor). Quorum (owner rule, 2026-11-07): anyone who did not respond, timed out, failed or was canceled is left out of the count entirely. An answer that did not follow the format is not counted as a vote, but its weight stays in the quorum denominator. The round passes with at least two distinct models with a published index among the valid votes, and with the weight of the valid votes at least two thirds of the weight of everyone who responded (valid plus out-of-format). No fraction of the planned participants is required. The output lists in `discarded` how many were left out and why (`off_format`, `timeout`, `failed`, `canceled`, `not_dispatched`), for the record only. With quorum, a choice wins with at least two thirds of the valid weight; one third of the weight on `X` yields `missing_fact`; with no winner, `divergence`, with the `top_voted` and the `best_argument` of each side. Without quorum, `insufficient`, with the `reasons`.

Show model, effort, vote, weight and its tier, confidence and main reason; scores per category; raw and weighted scoreboard; failures and cost. The automatic result uses only the weighted scoreboard.

## Operational verification

Check in the proxy and in ClickHouse the model IDs, times, status, usage and end of the response. A `200` with `length` is not a valid review. A token count of zero on a response that has `usage` requires checking the ingester. Do not expose authorization headers or private bodies in the report.

The old `~/.claude/workflows/council.js` only implements the Claude lineup with a simple count. Do not run it for this lineup. Use the harness orchestration and this skill's counter. Reload OpenCode after changing the skill; a session that is already running may keep the previous version in context.
