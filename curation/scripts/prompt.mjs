#!/usr/bin/env node
// Generation prompt: a recommendation built from the jury's critiques, a council review of it, and a one-iteration loop.
// Node 24+, no dependencies. The council is dispatched by the conductor in T3 (delegate_task), not by this script:
// the review has two file phases (prepareReview -> council -> applyReview) and the loop is a
// state machine in loop.json that the conductor advances stage by stage.
//
//   node prompt.mjs critiques --folder round [--options A,B] [--origin origin.json]
//   node prompt.mjs recommend --folder round --context ctx --generator generator.json --previous prompt.json|prompt.txt --out dir [--options A,B] [--origin origin.json]
//   node prompt.mjs prepare-review --prompt dir/prompt.json --context ctx --out dir
//   node prompt.mjs apply-review --prompt dir/prompt.json --agreement dir/agreement.json [--out dir]
//   node prompt.mjs loop-create --target A --out dir [--cap-stage 3 --cap-iteration 9]
//   node prompt.mjs loop-next --loop dir/loop.json
//   node prompt.mjs loop-can --loop dir/loop.json --stage judge --projected 1.2
//   node prompt.mjs loop-record --loop dir/loop.json --stage judge [--state ok] [--files cost.json,...] [--cost 1.2]
//   node prompt.mjs loop-chosen --loop dir/loop.json --judge it/j1   (chosen_j1: the decision, or on divergence a tiebreak on the highest weighted mean)
//   node prompt.mjs loop-winner --loop dir/loop.json --judge it/j2   (final_winner: the decision, or on divergence the option with the highest category mean if it beats the current asset's; otherwise the current asset)
//   node prompt.mjs loop-finalists --loop dir/loop.json --revised a.png --old b.png,c.png|none --current d.png   (none: the current asset won j1)
//
// `--context` accepts the text block (block.txt) or the context.json written by build-context: with `fields`, the block is built
// with contextBlock and its sha256 must match the JSON's `sha256`.
// `--options` accepts letters (anonymous decision) or original ids; the round carries the translation in map.json, and `--origin`
// (or origin.json in the round folder) says where each option came from: { "<id>": { origin: "generator", model } | { origin: "current", file } }.
// `loop-record` reads the cost from cost.json (judging) or candidates.json (generation) listed in `--files`; a typed `--cost`
// is only accepted if it matches what was read. Without a cost file, `--cost` is required for judge, generate and judge_final.
// Accepted failure states: those in FAILURES (no_quorum, insufficient, none_applied, no_recommendation, zero_candidates,
// cap_exceeded, no_key, no_video_access); all of them end the iteration. divergence is not a failure: at judge the stage is
// recorded ok and loop-chosen breaks the tie on the highest weighted mean; at judge_final it is recorded ok and loop-winner
// replaces the current asset with the one with the highest category mean, if that mean beats the current asset's.
// Measured spend above the stage cap or the iteration cap also ends the loop at cap_exceeded. Claude via subscription (proxy) does not count toward $.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { callClaudeProxy, CURRENT_CLAUDE } from './curation.mjs'
import { contextBlock } from './context.mjs'

const { votePacket, extractJson } = await import(new URL('../../council/scripts/council-t3.mjs', import.meta.url).href)

const sha = (v) => createHash('sha256').update(v).digest('hex')
const hasText = (v) => typeof v === 'string' && v.trim().length > 0
/** Accepts a path to a JSON file or the already-parsed object. */
const read = (x) => (typeof x === 'string' ? JSON.parse(fs.readFileSync(x, 'utf8')) : x)
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1)); return f }
const now = () => new Date().toISOString()

// ---------- model call ----------

/** Default `call`: text -> Claude through CLIProxyAPI (subscription). Returns { text, cost_usd, error }. */
const defaultCall = (request) => callClaudeProxy({ proxy: CURRENT_CLAUDE['anthropic/claude-opus-5.5'], effort: 'medium' }, [{ text: request }])

/** Calls `call` and normalizes the result (a bare string is accepted); an error in the call becomes an exception. */
async function ask(call, request) {
  const r = await call(request)
  const res = typeof r === 'string' ? { text: r } : r
  if (res?.error) throw new Error(`call failed: ${res.error}`)
  return { text: res?.text ?? '', cost_usd: Number(res?.cost_usd) || 0 }
}

/** Asks for JSON, validates with `validate(json) -> problems[]` and resends once with the problems. Returns { json, cost_usd }. */
async function askJson(call, request, validate, label) {
  let cost = 0
  let problems = []
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await ask(call, attempt ? `${request}\n\n## Fix\n\nYour previous answer was refused: ${problems.join('; ')}. Answer again, with only the JSON.` : request)
    cost += r.cost_usd
    const json = extractJson(r.text)
    problems = validate(json)
    if (!problems.length) return { json, cost_usd: cost }
  }
  throw new Error(`invalid ${label}: ${problems.join('; ')}`)
}

// ---------- A6: critiques and recommendation ----------

const NO_GAP = /^\s*(nothing|null|none|n\/?a|-+)\s*$/i
const critiqueKey = (c) => `${c.option ?? ''}|${c.text.toLowerCase().replace(/\s+/g, ' ').trim()}`

/**
 * Context text for the recommender and the review. Accepts plain text (block.txt) or the context.json written by buildContext
 * (an object with `fields` and `sha256`): in that case it builds the block with contextBlock and refuses it if sha256(block) != context.sha256.
 * `content` is the file's text; returns the block text.
 */
export function readContext(content) {
  let obj = null
  if (/^\s*\{/.test(content)) { try { obj = JSON.parse(content) } catch { obj = null } }
  if (!obj || typeof obj.fields !== 'object' || obj.fields === null) return content
  const block = contextBlock(obj)
  if (!hasText(obj.sha256)) throw new Error('context.json has no sha256: cannot check the block')
  if (sha(block) !== obj.sha256) throw new Error(`context.json refused: block sha256 (${sha(block).slice(0, 12)}) differs from context.sha256 (${obj.sha256.slice(0, 12)})`)
  return block
}

/**
 * Critiques from a curation round folder: fix_points and reasons from scores.json, collection.json and
 * decision.json, plus the `gap` of each score. Only admitted opinions count. Repeats are listed once.
 * Anonymous decision: if the folder has map.json ({ seed, letter_to_option }), each critique of an option carries the `letter`
 * (also in `option`) and the `original_id`; if there is an origin (the `origin` option = a path, or origin.json in the folder; format
 * { "<original id>": { origin: 'generator', model } | { origin: 'current', file } }), it also carries the `origin`.
 * `options` restricts to the listed options (letters or original ids), for example only the ones generated with the prompt under review.
 * Returns [{ id: 'C1', text, source, model?, category?, option?, letter?, original_id?, origin? }].
 */
export function extractCritiques(folder, { options = null, origin = null } = {}) {
  const readIf = (name) => { const f = path.join(folder, name); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null }
  const scores = readIf('scores.json')
  const collection = readIf('collection.json')
  const decision = readIf('decision.json')
  if (!scores && !collection && !decision) throw new Error(`no scores.json, collection.json or decision.json in ${folder}`)
  const letterToId = readIf('map.json')?.letter_to_option ?? null
  if (origin && !fs.existsSync(origin)) throw new Error(`origin does not exist: ${origin}`)
  const origins = origin ? JSON.parse(fs.readFileSync(origin, 'utf8')) : readIf('origin.json')

  // Allowed letters: each item in `options` counts as a letter or as an original id (with a map); without a map it counts as is.
  const letters = options && letterToId ? new Set(options.map((o) => {
    const letter = o in letterToId ? o : Object.keys(letterToId).find((l) => letterToId[l] === o)
    if (!letter) throw new Error(`--options: "${o}" is neither a letter nor an original id in map.json (${Object.keys(letterToId).join(', ')})`)
    return letter
  })) : null
  const included = (option) => (!options || !option) || (letters ? letters.has(option) : options.includes(option))
  /** Translation fields of an option: letter, original id and origin (whichever exist). */
  const translation = (option) => {
    if (!option) return {}
    const id = letterToId?.[option]
    return { ...(id !== undefined ? { letter: option, original_id: id } : {}), ...((origins?.[id ?? option]) ? { origin: origins[id ?? option] } : {}) }
  }
  const found = []
  const point = (p) => (hasText(p?.problem) ? `${p.problem}${hasText(p.fix) ? ` -> ${p.fix}` : ''}` : null)
  const add = (source, t, extra = {}) => { if (hasText(t) && included(extra.option)) found.push({ text: t.trim(), source, ...extra, ...translation(extra.option) }) }

  for (const p of scores?.fix_points ?? []) add('scores.json', point(p), { model: p.model })
  for (const e of collection?.entries ?? []) {
    const r = e.review
    if (!e.admitted || !r) continue
    for (const p of r.fix_points ?? []) add('collection.json', point(p), { model: e.model })
    for (const n of r.scores ?? []) {
      if (!hasText(n?.gap) || NO_GAP.test(n.gap)) continue
      add('collection.json', `[${n.category} ${n.score}/10] ${n.gap}`, { model: e.model, category: n.category, ...(n.option ? { option: n.option } : {}) })
    }
    for (const t of r.reasons ?? []) add('collection.json', t, { model: e.model, ...(r.vote ? { option: r.vote } : {}) })
  }
  for (const [option, m] of Object.entries(decision?.best_argument ?? {})) add('decision.json', m?.reason, { model: m?.model, option })

  const seen = new Set()
  return found.filter((c) => !seen.has(critiqueKey(c)) && seen.add(critiqueKey(c))).map((c, i) => ({ id: `C${i + 1}`, ...c }))
}

/** Accepts critiques as { id, text } objects or as strings (which become C1, C2...). */
function normalizeCritiques(critiques) {
  if (!Array.isArray(critiques)) throw new Error('critiques: array required')
  const list = critiques.map((c, i) => (typeof c === 'string' ? { id: `C${i + 1}`, text: c } : c))
  for (const c of list) if (!hasText(c?.id) || !hasText(c?.text)) throw new Error('critiques: each item needs an id and text')
  if (new Set(list.map((c) => c.id)).size !== list.length) throw new Error('critiques: duplicate id')
  return list
}

/** Who an option is, in a short phrase: "generated by m/x" or "current asset (file)". */
const whoIs = (o) => (o?.origin === 'generator' ? `generated by ${o.model ?? 'generator'}` : o?.origin === 'current' ? `current asset${o.file ? ` (${path.basename(o.file)})` : ''}` : null)
/** A critique line in the request: with map/origin the option comes translated ("option A: id; generated by ..."); without them only the letter shows. */
const critiqueLine = (c) => {
  const who = [c.original_id && c.original_id !== c.option ? c.original_id : null, whoIs(c.origin)].filter(Boolean).join('; ')
  return `- ${c.id}${c.option ? ` (option ${c.option}${who ? `: ${who}` : ''})` : ''}: ${c.text}`
}
const limitsOf = (g) => (g.limits === undefined ? 'not provided' : typeof g.limits === 'string' ? g.limits : JSON.stringify(g.limits))
const generatorBlock = (g) => [`${g.id} (known limits: ${limitsOf(g)})`,
  g.capabilities ? `capabilities: ${Object.entries(g.capabilities).map(([k, v]) => `${k}=${v}`).join(', ')}` : null,
  g.price_resolution ? `price resolution: ${g.price_resolution}` : null,
  g.note ? `note: ${g.note}` : null].filter(Boolean).join('\n')

/** Critique ids cited in `source_critique` (an array or a "C1, C2" string). */
const sourceIds = (o) => (Array.isArray(o) ? o : String(o ?? '').split(/[\s,;]+/)).map((s) => String(s).trim()).filter(Boolean)

/** Validates {prompt, changes:[{id, source_critique, change}]}: every change cites critiques that exist. */
export function validateRecommendation(rec, critiques) {
  if (!rec || typeof rec !== 'object') return ['no JSON']
  const problems = []
  if (!hasText(rec.prompt)) problems.push('empty prompt')
  if (!Array.isArray(rec.changes) || !rec.changes.length) return [...problems, 'no changes']
  const ids = new Set(critiques.map((c) => c.id))
  const seen = new Set()
  for (const m of rec.changes) {
    if (!/^M\d+$/.test(m?.id ?? '')) problems.push(`invalid change id: ${m?.id}`)
    else if (seen.has(m.id)) problems.push(`duplicate change: ${m.id}`)
    else seen.add(m.id)
    if (!hasText(m?.change)) problems.push(`empty change in ${m?.id}`)
    const sources = sourceIds(m?.source_critique)
    if (!sources.length) problems.push(`${m?.id} has no source critique`)
    for (const s of sources) if (!ids.has(s)) problems.push(`${m?.id} cites a nonexistent critique: ${s}`)
  }
  return problems
}

function recommendationRequest({ critiques, context, generator, previousPrompt }) {
  return `You improve the prompt of a media generator from the critiques a jury made of the result of the previous prompt.

Rules:
- Each change fixes at least one critique and cites its ids in source_critique (e.g. "C3" or ["C3","C7"]). Without a source critique, no change.
- Change only what the critiques support. Do not invent game facts outside the context, do not remove what worked, do not go past the generator limits.
- Write the full prompt (not a diff), in the same language and format as the previous prompt.
- Describe each change in one sentence, saying what changes in the prompt.

## Generator

${generatorBlock(generator)}

## Game context

${context}

## Previous prompt

${previousPrompt}

## Jury critiques

${critiques.map(critiqueLine).join('\n')}

## How to respond

Respond only with JSON in this format:
{"prompt":"full text of the new prompt","changes":[{"id":"M1","source_critique":["C1"],"change":"what changes and why"}]}
`
}

/** Non-text fields of the generation prompt that carry over from the previous prompt to the recommended and revised ones (C3). */
export const GENERATION_FIELDS = ['references', 'aspect_ratio', 'resolution', 'duration_s']
const fieldsOf = (o) => Object.fromEntries(GENERATION_FIELDS.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]))

/**
 * Reads the previous prompt: a generation prompt.json ({ text, references?, aspect_ratio?, resolution?, duration_s? }) or a .txt.
 * Returns { text, fields } (fields is empty for a .txt).
 */
export function readPreviousPrompt(content) {
  const t = String(content)
  let j = null
  try { j = JSON.parse(t) } catch { /* plain text */ }
  if (j && typeof j === 'object') {
    if (!hasText(j.text)) throw new Error('previous prompt in JSON has no text field')
    return { text: j.text, fields: fieldsOf(j) }
  }
  return { text: t, fields: {} }
}

/**
 * Recommends a better prompt. `call(request: string) -> { text, cost_usd?, error? }` (default: Claude through the proxy).
 * Invalid JSON or a change without a source gets one resend. With `out` (a folder), writes prompt.json. Returns the object written.
 */
export async function recommendPrompt({ critiques, context, generator, previousPrompt, generationFields = {}, call = defaultCall, out = null }) {
  const list = normalizeCritiques(critiques)
  if (!list.length) throw new Error('recommendPrompt: no critiques')
  if (!hasText(context)) throw new Error('recommendPrompt: context required')
  if (!hasText(previousPrompt)) throw new Error('recommendPrompt: previousPrompt required')
  const id = generator?.id ?? generator?.model
  if (!hasText(id)) throw new Error('recommendPrompt: generator has no id')
  const g = { id, ...(generator.limits !== undefined ? { limits: generator.limits } : {}),
    ...(generator.capabilities && Object.keys(generator.capabilities).length ? { capabilities: generator.capabilities } : {}),
    ...(generator.price?.resolution ? { price_resolution: generator.price.resolution } : {}),
    ...(generator.note ? { note: generator.note } : {}) }

  const { json, cost_usd } = await askJson(call, recommendationRequest({ critiques: list, context, generator: g, previousPrompt }),
    (j) => validateRecommendation(j, list), 'recommendation')
  const rec = {
    version: 1, state: 'recommended', generated_at: now(), generator: g,
    context_sha256: sha(context), previous_prompt: previousPrompt, previous_prompt_sha256: sha(previousPrompt),
    generation_fields: fieldsOf(generationFields), ...fieldsOf(generationFields), text: json.prompt.trim(), critiques: list,
    changes: json.changes.map((m) => ({ id: m.id, source_critique: sourceIds(m.source_critique), change: m.change.trim() })),
    cost_usd,
  }
  if (out) write(path.join(out, 'prompt.json'), rec)
  return rec
}

// ---------- A7: council review ----------

/**
 * Review phase 1: writes items.json (one change = one item to vote on) and packet.txt (the council's votePacket)
 * to `out`. The conductor dispatches the council with those two files. `context` must be the one used for the recommendation (sha checked);
 * `critiques` is optional (default: the ones saved in prompt.json).
 */
export function prepareReview(promptJson, { context, critiques = null, out }) {
  const p = read(promptJson)
  if (!out) throw new Error('prepareReview: out required')
  if (!hasText(context) || sha(context) !== p.context_sha256) throw new Error('prepareReview: the context is not the one from the recommendation (different sha)')
  const list = critiques ? normalizeCritiques(critiques) : p.critiques
  const byId = new Map(list.map((c) => [c.id, c]))
  const items = p.changes.map((m) => ({
    id: m.id, section: 'prompt',
    problem: m.source_critique.map((o) => { const c = byId.get(o); if (!c) throw new Error(`${m.id}: critique ${o} is not in the list`); return c.text }).join(' | '),
    fix: m.change,
  }))
  const artifact = `## Generator\n\n${generatorBlock(p.generator)}\n\n## Previous prompt (in use)\n\n${p.previous_prompt}\n\n## Recommended prompt\n\n${p.text}\n\n## Game context\n\n${context}\n\n## Jury critiques\n\n${list.map(critiqueLine).join('\n')}`
  if (fs.existsSync(path.join(out, 'packet.txt'))) throw new Error('packet.txt already exists: use a new folder (the vote may already have been dispatched)')
  write(path.join(out, 'items.json'), items)
  return { items, packet: write(path.join(out, 'packet.txt'), votePacket(items, artifact)), items_file: path.join(out, 'items.json') }
}

function recompositionRequest(p, approved) {
  return `You receive the generation prompt in use and the list of changes approved by vote. Produce the final prompt by applying ONLY these changes: do not add others, do not remove what they do not touch, keep the language and format, and respect the generator limits.

## Generator

${generatorBlock(p.generator)}

## Prompt in use

${p.previous_prompt}

## Approved changes

${approved.map((m) => `- ${m.id}: ${m.change}`).join('\n')}

## How to respond

Respond only with JSON: {"prompt":"full text of the final prompt","applied":["ids of the changes you applied"]}
The \`applied\` list must be exactly: ${approved.map((m) => m.id).join(', ')}.
`
}

/** Line diff between two texts: lines that left the earlier text and lines new in the later one (unordered). */
function lineDiff(before, after) {
  const a = before.split('\n').map((l) => l.trim()).filter(Boolean)
  const d = after.split('\n').map((l) => l.trim()).filter(Boolean)
  return { removed: a.filter((l) => !d.includes(l)), added: d.filter((l) => !a.includes(l)) }
}

/**
 * Review phase 2: reads the council's agreement and writes prompt-revised.json.
 * A change goes in only with decision 'apply' and a mean >= 7 (the file's threshold can only raise that floor; F1).
 * All approved: the text is the recommended prompt the council voted on, with no new call. Partly approved: `call` recomposes
 * from the previous prompt + the approved changes and returns `applied`; a list that differs from the approved ones gets one resend and, if
 * it persists, the state is no_recommendation (F2). The line diff against the previous prompt is kept in `diff`.
 * Without quorum (or with the conductor's decision pending) nothing goes in: state no_quorum.
 * States: revised | none_applied (quorum, but all below 7) | no_quorum | no_recommendation. Outside revised the text is the previous prompt.
 */
export async function applyReview(promptJson, agreementJson, { call = defaultCall, out = null } = {}) {
  const p = read(promptJson)
  const conc = read(agreementJson)
  const dir = out ?? (typeof promptJson === 'string' ? path.dirname(promptJson) : null)
  const noQuorum = !conc?.quorum?.ok
  const fileThreshold = conc?.threshold ?? 7
  const threshold = Math.max(7, fileThreshold)
  const byId = new Map((conc?.items ?? []).map((i) => [i.id, i]))
  const applied = []
  const discarded = []
  for (const m of p.changes) {
    const it = byId.get(m.id)
    const base = { id: m.id, change: m.change, mean: it?.agreement ?? null }
    if (noQuorum) discarded.push({ ...base, reason: 'no quorum in the vote: no change goes in' })
    else if (!it) discarded.push({ ...base, reason: 'no vote for this item' })
    else if (it.decision === 'apply' && it.agreement >= threshold) applied.push({ ...base, reason: `mean ${it.agreement} >= ${threshold}` })
    else discarded.push({ ...base, reason: `mean ${it.agreement ?? 'no vote'} below ${threshold} (${it.decision})` })
  }

  let state = noQuorum ? 'no_quorum' : applied.length ? 'revised' : 'none_applied'
  let finalText = p.previous_prompt
  let cost_usd = 0
  let via = null
  let reason = null
  if (applied.length && applied.length === p.changes.length) {
    finalText = p.text
    via = 'recommended_voted'
  } else if (applied.length) {
    const ids = applied.map((m) => m.id).sort().join(',')
    const validate = (j) => [...(hasText(j?.prompt) ? [] : ['empty prompt']),
      ...(Array.isArray(j?.applied) && [...j.applied].map(String).sort().join(',') === ids ? [] : [`applied must be exactly ${ids}`])]
    try {
      const r = await askJson(call, recompositionRequest(p, applied), validate, 'recomposition')
      finalText = r.json.prompt.trim()
      cost_usd = r.cost_usd
      via = 'recomposed'
    } catch (e) {
      if (!/invalid recomposition/.test(e.message)) throw e
      state = 'no_recommendation'
      reason = e.message
    }
  }
  const rev = { version: 1, state, generated_at: now(), generator: p.generator, context_sha256: p.context_sha256,
    previous_prompt_sha256: p.previous_prompt_sha256, generation_fields: p.generation_fields ?? {}, ...(p.generation_fields ?? {}), text: finalText, applied, discarded,
    quorum: conc?.quorum ?? null, threshold, ...(fileThreshold !== threshold ? { file_threshold: fileThreshold } : {}), cost_usd,
    ...(via ? { via } : {}), ...(reason ? { reason } : {}), diff: lineDiff(p.previous_prompt, finalText) }
  if (dir) write(path.join(dir, 'prompt-revised.json'), rev)
  return rev
}

// ---------- A8: loop ----------

export const STAGES = ['judge', 'recommend', 'review', 'generate', 'judge_final']
/**
 * Failure states; all of them end the iteration before spending more. no_quorum (run/council); insufficient (judge and
 * judge_final); none_applied and no_recommendation (review: regenerating with the same prompt teaches nothing); zero_candidates,
 * cap_exceeded, no_key and no_video_access (generate). Divergence is not a failure: at judge, loop-chosen breaks the tie; at
 * judge_final, loop-winner replaces the current asset with the one with the highest mean if it beats the current one's; in both the stage is recorded ok.
 */
export const FAILURES = ['no_quorum', 'insufficient', 'none_applied', 'no_recommendation', 'zero_candidates', 'cap_exceeded', 'no_key', 'no_video_access']
/** Maximum number of options in a curation decision (judge_final is one decision). */
const OPTIONS_MAX = 4
/** Stages paid in $: their cost cannot stay unknown (recommend and review use Claude via subscription). */
const PAID_STAGES = ['judge', 'generate', 'judge_final']
/** Tolerance when comparing costs and caps in dollars. */
const EPS = 1e-6

/** `loop` is the path to loop.json or an object returned by these functions; the file is the source of truth. */
const load = (loop) => { const file = typeof loop === 'string' ? loop : loop.file; return { ...JSON.parse(fs.readFileSync(file, 'utf8')), file } }
const save = (l) => { const { file, ...rest } = l; write(file, rest); return l }
const stageOf = (l, name) => { const e = l.stages.find((x) => x.name === name); if (!e) throw new Error(`unknown stage: ${name} (${STAGES.join(', ')})`); return e }
const checkAmount = (v, name) => { if (!Number.isFinite(v) || v < 0) throw new Error(`invalid ${name}: ${v}`); return v }

/**
 * Creates out/loop.json with the stages and the caps declared before spending. One iteration per loop (one loop per request).
 * Caps in dollars: per stage and per iteration (protocol defaults: 3 and 9).
 */
export function createLoop({ target, stageCap = 3, iterationCap = 9, out }) {
  if (!hasText(target)) throw new Error('createLoop: target required')
  if (!out) throw new Error('createLoop: out required')
  const file = path.join(out, 'loop.json')
  if (fs.existsSync(file)) throw new Error('loop.json already exists: one loop per request')
  if (!(checkAmount(stageCap, 'stageCap') > 0) || !(checkAmount(iterationCap, 'iterationCap') > 0)) throw new Error('the caps must be greater than zero')
  return save({ version: 1, target, created_at: now(), state: 'in_progress', iteration: 1, max_iterations: 1,
    stage_cap_usd: stageCap, iteration_cap_usd: iterationCap, spent_usd: 0,
    stages: STAGES.map((name) => ({ name, state: 'pending', measured_cost: 0, files: [] })), file })
}

/** Why the stage cannot start now (loop ended, stage already recorded, or out of order), or null. */
function blocker(l, e) {
  if (l.state !== 'in_progress') return `loop closed: ${l.state}`
  if (e.state !== 'pending') return `${e.name} already recorded (${e.state}): at most ${l.max_iterations} iteration per request`
  const before = l.stages.slice(0, l.stages.indexOf(e)).find((x) => x.state !== 'ok')
  return before ? `order: ${before.name} has not completed yet` : null
}

/** The next stage to run, or null if the loop finished or failed. */
export function nextStage(loop) {
  const l = load(loop)
  return l.state === 'in_progress' ? l.stages.find((e) => e.state === 'pending')?.name ?? null : null
}

/**
 * Can `stage` start with cost `projected`? Refuses (ok:false) when out of order, repeated or with the loop closed; and, if
 * projected > the stage cap or spent + projected > the iteration cap, writes state cap_exceeded (ends the loop).
 * When approved, returns stage_cap_usd = min(stage cap, iteration cap − spent), without subtracting projected: it is the --cap
 * to pass to the stage's run/generate (always >= projected). remaining_usd is the iteration's balance before the stage.
 */
export function canStart(loop, stage, projected) {
  const l = load(loop)
  const e = stageOf(l, stage)
  const reason = blocker(l, e)
  if (reason) return { ok: false, reason }
  checkAmount(projected, 'projected')
  const excess = projected > l.stage_cap_usd ? `projected $${projected} exceeds the stage cap $${l.stage_cap_usd}`
    : l.spent_usd + projected > l.iteration_cap_usd ? `spent $${l.spent_usd} + projected $${projected} exceeds the iteration cap $${l.iteration_cap_usd}` : null
  if (excess) {
    e.state = 'cap_exceeded'
    l.state = 'cap_exceeded'
    l.reason = `${stage}: ${excess}`
    save(l)
    return { ok: false, state: 'cap_exceeded', reason: l.reason }
  }
  const remaining = +(l.iteration_cap_usd - l.spent_usd).toFixed(6)
  return { ok: true, stage_cap_usd: +Math.min(l.stage_cap_usd, remaining).toFixed(6), remaining_usd: remaining }
}

/**
 * Cost in $ of a stage, read from the files it produced (those named cost.json and candidates.json in `files`;
 * the others are ignored). Returns { cost, spend_limit_usd, sources } or null if neither was listed.
 * - cost.json (judging): the larger of measured_usd and spend_limit_usd (measured plus the projected cost of jurors with an
 *   uncertain cost, which may have been charged; the difference goes to spend_limit_usd), minus the cost_usd of proxy-claude route responses in
 *   collection.json (the subscription is not dollars; it already comes as 0 today, the subtraction is only a safeguard). The subscription equivalent is never read.
 * - candidates.json (generation): measured_usd plus the projected_cost of candidates with a null measured_cost and a state other than
 *   not_started (generation counts those at their projected cost against the cap); that part goes to spend_limit_usd.
 * A listed file that does not exist, or has no numeric measured_usd, is an error.
 */
export function readCostFromFiles(files = []) {
  const sources = files.filter((a) => ['cost.json', 'candidates.json'].includes(path.basename(a)))
  if (!sources.length) return null
  let totalCost = 0
  let limit = 0
  for (const a of sources) {
    if (!fs.existsSync(a)) throw new Error(`cost not read: ${a} does not exist`)
    const j = JSON.parse(fs.readFileSync(a, 'utf8'))
    if (!Number.isFinite(j.measured_usd) || j.measured_usd < 0) throw new Error(`cost not read: ${a} has no valid measured_usd`)
    if (path.basename(a) === 'cost.json') {
      const collection = path.join(path.dirname(a), 'collection.json')
      const subscription = fs.existsSync(collection) ? (JSON.parse(fs.readFileSync(collection, 'utf8')).entries ?? [])
        .filter((x) => String(x.route).startsWith('proxy-claude')).reduce((s, x) => s + (Number(x.cost_usd) || 0), 0) : 0
      const withUncertain = Math.max(j.measured_usd, Number.isFinite(j.spend_limit_usd) ? j.spend_limit_usd : 0)
      limit += withUncertain - j.measured_usd
      totalCost += Math.max(0, withUncertain - subscription)
    } else {
      const unmeasured = (j.candidates ?? []).filter((c) => c.measured_cost == null && c.state !== 'not_started').reduce((s, c) => s + (Number(c.projected_cost) || 0), 0)
      limit += unmeasured
      totalCost += j.measured_usd + unmeasured
    }
  }
  return { cost: +totalCost.toFixed(6), spend_limit_usd: +limit.toFixed(6), sources }
}

/**
 * Records the end of a stage, in order, and accumulates the spend in $ (money already spent always counts, even above the cap).
 * The cost comes from the files (see readCostFromFiles); a typed `measured_cost` is optional and only accepted if it matches what was read
 * (tolerance 1e-6). Without a cost file, `measured_cost` is required for judge, generate and judge_final (recommend and review
 * count as 0 because they run on the subscription). A state other than 'ok' (FAILURES) ends the loop; stage spend above the stage cap, or the
 * accumulated spend above the iteration cap, ends it at cap_exceeded (if the stage already failed, the failure state wins and the excess
 * goes in `reason`). Closing judge_final with ok completes the loop and requires recordFinalists first.
 */
export function recordStage(loop, stage, { measured_cost, state = 'ok', files = [] } = {}) {
  const l = load(loop)
  const e = stageOf(l, stage)
  const reason = blocker(l, e)
  if (reason) throw new Error(reason)
  if (state === 'divergence') {
    throw new Error(stage === 'judge_final' ? 'judge_final: divergence does not end the loop; record judge_final as ok and run loop-winner (it swaps in the option with the highest mean if that beats the current one\'s)'
      : `${stage}: divergence does not end the loop; record ${stage} as ok and run loop-chosen (tiebreak on the highest weighted mean)`)
  }
  if (state !== 'ok' && !FAILURES.includes(state)) throw new Error(`invalid state: ${state} (ok, ${FAILURES.join(', ')})`)
  if (measured_cost !== undefined) checkAmount(measured_cost, 'measured_cost')
  if (stage === 'judge_final' && state === 'ok' && !l.finalists) throw new Error('judge_final: record the finalists first (recordFinalists)')
  const readCost = readCostFromFiles(files)
  if (readCost && measured_cost !== undefined && Math.abs(readCost.cost - measured_cost) > EPS) {
    throw new Error(`measured_cost ${measured_cost} does not match what was read from ${readCost.sources.join(', ')}: ${readCost.cost}`)
  }
  if (!readCost && measured_cost === undefined && PAID_STAGES.includes(stage)) {
    throw new Error(`${stage}: unknown cost: list cost.json or candidates.json in files, or pass measured_cost`)
  }
  const spent = readCost?.cost ?? measured_cost ?? 0
  const aboveStage = spent > l.stage_cap_usd + EPS
  Object.assign(e, { state, measured_cost: spent, files, recorded_at: now(),
    ...(readCost ? { cost_read_from: readCost.sources, ...(readCost.spend_limit_usd ? { spend_limit_usd: readCost.spend_limit_usd } : {}) } : {}),
    ...(aboveStage ? { above_cap: true } : {}) })
  l.spent_usd = +(l.spent_usd + spent).toFixed(6)
  const aboveIteration = l.spent_usd > l.iteration_cap_usd + EPS
  if (aboveIteration) l.above_iteration_cap = true
  if (state !== 'ok') l.state = state
  else if (stage === 'judge_final') l.state = 'completed'
  if (aboveStage || aboveIteration) {
    l.reason = `${stage}: ${aboveStage ? `measured spend $${spent} exceeds the stage cap $${l.stage_cap_usd}` : `accumulated spend $${l.spent_usd} exceeds the iteration cap $${l.iteration_cap_usd}`}`
    if (state === 'ok') l.state = 'cap_exceeded'
  }
  return save(l)
}

/** Reads decision, map and origin from a judging (a for-judging folder); `pick(letter, via, extra)` builds the choice with the origin's file. */
function readJudging(folder) {
  const readFile = (f) => JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8'))
  const d = readFile('round/decision.json')
  const map = readFile('round/map.json').letter_to_option
  const origin = readFile('origin.json')
  const pick = (letter, via, extra = {}) => {
    const option = map[letter]
    const o = origin[option]
    if (!o?.file) throw new Error(`chosen: ${option} has no file in origin.json`)
    return { state: 'ok', via, letter, option, origin: o.origin, ...(o.model ? { model: o.model } : {}), file: o.file, ...extra }
  }
  return { d, map, origin, pick }
}

/**
 * The choice from a judging (a for-judging folder with round/): the decision's choice or, on divergence, the option with the highest
 * weighted mean (via 'tiebreak'; an exact tie is recorded and the first letter wins). Insufficient or no-quorum judgings choose
 * nothing: returns { state } so the iteration can end. The file comes from origin.json.
 */
export function chosenFromJudging(folder) {
  const { d, map, pick } = readJudging(folder)
  if (d.result === 'decision') return pick(Object.keys(map).find((l) => map[l] === d.original_choice), 'decision')
  if (d.result !== 'divergence') return { state: d.result === 'no_quorum' || !d.quorum?.ok ? 'no_quorum' : 'insufficient' }
  const letters = Object.keys(map).filter((l) => d.weighted?.[l] !== undefined)
  const max = Math.max(...letters.map((l) => d.weighted[l]))
  const tied = letters.filter((l) => d.weighted[l] === max).sort()
  return pick(tied[0], 'tiebreak', { weighted: max, ...(tied.length > 1 ? { tie: tied } : {}) })
}

/** Writes chosen_j1 (from chosenFromJudging) to loop.json; record judge as ok afterwards. */
export function recordChosen(loop, folder) {
  const l = load(loop)
  const e = chosenFromJudging(folder)
  if (e.state !== 'ok') throw new Error(`chosen: judging has no choice (${e.state}); record judge with that state`)
  return save({ ...l, chosen_j1: e })
}

/** Simple mean of an option's categories in `scores_by_category` (a category without a score is left out); null if there are none. */
const categoryMean = (scores) => {
  const v = Object.values(scores ?? {}).filter(Number.isFinite)
  return v.length ? v.reduce((s, n) => s + n, 0) / v.length : null
}

/**
 * Winner of judge_final (the for-judging folder of j2). With `decision`, the jury's choice (via 'decision'). With `divergence`
 * the owner rule applies ("if the current one loses, replace it", owner rule, 2026-11-08): the option with the highest category mean
 * (`scores_by_category`) wins as long as it beats the current asset's mean (via 'tiebreak'; an exact tie among candidates is recorded in
 * `tie` and the first letter wins). If the current asset has the highest mean or ties, the current asset stays (via 'current'). Divergence never
 * ends the iteration. Insufficient or no-quorum judgings choose nothing: returns { state }. No current option in origin.json, or no
 * score for the current asset, is an error (nothing to compare).
 */
export function finalJudgingWinner(folder) {
  const { d, map, origin, pick } = readJudging(folder)
  if (d.result === 'decision') return pick(Object.keys(map).find((l) => map[l] === d.original_choice), 'decision')
  if (d.result !== 'divergence') return { state: d.result === 'no_quorum' || !d.quorum?.ok ? 'no_quorum' : 'insufficient' }
  const letters = Object.keys(map)
  const current = letters.find((l) => origin[map[l]]?.origin === 'current')
  if (!current) throw new Error('final_winner: no option with origin current in origin.json')
  const mean = Object.fromEntries(letters.map((l) => [l, categoryMean(d.scores_by_category?.[l])]))
  if (mean[current] === null) throw new Error('final_winner: the current asset has no per-category scores in decision.json; cannot compare')
  const others = letters.filter((l) => l !== current && mean[l] !== null)
  const max = Math.max(...others.map((l) => mean[l]))
  const currentMean = +mean[current].toFixed(4)
  if (!others.length || !(max > mean[current] + EPS)) return pick(current, 'current', { mean: currentMean })
  const tied = others.filter((l) => max - mean[l] <= EPS).sort()
  return pick(tied[0], 'tiebreak', { mean: +max.toFixed(4), current_mean: currentMean, ...(tied.length > 1 ? { tie: tied } : {}) })
}

/** Writes final_winner (from finalJudgingWinner) to loop.json; a divergence closes as `ok`, not as a failure. */
export function recordFinalWinner(loop, folder) {
  const l = load(loop)
  const v = finalJudgingWinner(folder)
  if (v.state !== 'ok') throw new Error(`final_winner: judging has no choice (${v.state}); record judge_final with that state`)
  return save({ ...l, final_winner: v })
}

/**
 * Which files go into judge_final: all ok candidates of the revised prompt (g2, in top order), the chosen one from j1
 * (old prompt) and the current asset, at most 4 options. Beyond that the first g2 candidates stay; the rest go to `cut`.
 * Only records them (and checks they exist); the curation does the judging.
 */
export function recordFinalists(loop, { revised, old, current }) {
  const l = load(loop)
  const list = (v) => [v].flat().filter(hasText)
  // old "none": the current asset won j1, so there is no distinct old one and the slot goes to one more g2 candidate.
  const noOld = list(old).join() === 'none'
  const finalists = { revised_prompt: list(revised), old_prompt: noOld ? [] : list(old), current_asset: list(current) }
  for (const [role, files] of Object.entries(finalists)) {
    if (!files.length && !(noOld && role === 'old_prompt')) throw new Error(`finalists: missing ${role}`)
    for (const a of files) if (!fs.existsSync(a)) throw new Error(`finalists: file does not exist (${role}): ${a}`)
  }
  const fileSha = (f) => sha(fs.readFileSync(f))
  const currentShas = new Set(finalists.current_asset.map(fileSha))
  const same = finalists.old_prompt.find((a) => currentShas.has(fileSha(a)))
  if (same) throw new Error(`finalists: the old one ${same} is the current asset itself (same sha256); use --old none`)
  const slots = OPTIONS_MAX - finalists.old_prompt.length - finalists.current_asset.length
  if (slots < 1) throw new Error(`finalists: old and current already take ${OPTIONS_MAX - slots} of the ${OPTIONS_MAX} options`)
  const cut = finalists.revised_prompt.slice(slots)
  finalists.revised_prompt = finalists.revised_prompt.slice(0, slots)
  return save({ ...l, finalists: { ...finalists, ...(noOld ? { old_left_out: 'the current asset won j1' } : {}), ...(cut.length ? { cut } : {}) } })
}

// ---------- CLI ----------

function flags(args) {
  const f = {}
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error(`unexpected argument: ${args[i]}`)
    f[args[i].slice(2)] = args[++i]
  }
  return f
}
const csv = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined)
const readText = (f) => fs.readFileSync(f, 'utf8')
const need = (f, ...ks) => { for (const k of ks) if (f[k] === undefined) throw new Error(`--${k} required`) }
const show = (v) => console.log(JSON.stringify(v, null, 1))

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const f = flags(rest)
  if (cmd === 'critiques') { need(f, 'folder'); return show(extractCritiques(f.folder, { options: csv(f.options), origin: f.origin })) }
  if (cmd === 'recommend') {
    need(f, 'folder', 'context', 'generator', 'previous', 'out')
    return show(await recommendPrompt({ critiques: extractCritiques(f.folder, { options: csv(f.options), origin: f.origin }), context: readContext(readText(f.context)),
      generator: JSON.parse(readText(f.generator)), ...(({ text: previousPrompt, fields: generationFields }) => ({ previousPrompt, generationFields }))(readPreviousPrompt(readText(f.previous))), out: f.out }))
  }
  if (cmd === 'prepare-review') { need(f, 'prompt', 'context', 'out'); return show(prepareReview(f.prompt, { context: readContext(readText(f.context)), out: f.out })) }
  if (cmd === 'apply-review') { need(f, 'prompt', 'agreement'); return show(await applyReview(f.prompt, f.agreement, { out: f.out })) }
  if (cmd === 'loop-create') {
    need(f, 'target', 'out')
    return show(createLoop({ target: f.target, out: f.out, ...(f['cap-stage'] ? { stageCap: Number(f['cap-stage']) } : {}), ...(f['cap-iteration'] ? { iterationCap: Number(f['cap-iteration']) } : {}) }))
  }
  if (cmd === 'loop-next') { need(f, 'loop'); return show({ next: nextStage(f.loop) }) }
  if (cmd === 'loop-can') { need(f, 'loop', 'stage', 'projected'); return show(canStart(f.loop, f.stage, Number(f.projected))) }
  if (cmd === 'loop-record') {
    need(f, 'loop', 'stage')
    return show(recordStage(f.loop, f.stage, { ...(f.cost !== undefined ? { measured_cost: Number(f.cost) } : {}), state: f.state ?? 'ok', files: csv(f.files) ?? [] }))
  }
  if (cmd === 'loop-chosen') { need(f, 'loop', 'judge'); return show(recordChosen(f.loop, f.judge).chosen_j1) }
  if (cmd === 'loop-winner') { need(f, 'loop', 'judge'); return show(recordFinalWinner(f.loop, f.judge).final_winner) }
  if (cmd === 'loop-finalists') { need(f, 'loop', 'revised', 'old', 'current'); return show(recordFinalists(f.loop, { revised: csv(f.revised), old: csv(f.old), current: csv(f.current) })) }
  console.error('Usage: prompt.mjs critiques|recommend|prepare-review|apply-review|loop-create|loop-next|loop-can|loop-record|loop-chosen|loop-winner|loop-finalists (see the header)')
  process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.message); process.exit(1) })
}
