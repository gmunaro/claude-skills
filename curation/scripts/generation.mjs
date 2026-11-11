#!/usr/bin/env node
// Curation generation: picks the top generators for each category and generates 1 candidate per generator. Node 24+, no dependencies.
//
//   node generation.mjs build --category image|video|audio --ranking research.json [--catalog models.json --catalog-date YYYY-MM-DD] [--out generators.json]
//   node generation.mjs generate --category image|video|music|speech --prompt prompt.json --out new-folder [--cap 3] [--estimate-only] [--catalog models.json]
//   node generation.mjs generator --category image|video|music|speech (--model id | --position N) --out generator.json   (top item, for recommend)
//   node generation.mjs for-judging --candidates a/candidates.json[,b/candidates.json] [--files x.png,y.png] --current file --out new-folder [--question text] [--categories a,b]
//
// build: top = ranking ∩ /models catalog (without the live query, use --catalog), writes data/generators-<category>.json.
// generate: free pre-checks, estimate, cut by the cap, then one candidate per generator, one at a time.
// for-judging: builds the curation decision input (ok candidates + the current asset, with neutral names and texts).
// Routes copied from gen.py (v07-generation). No call is resent: resending a paid generation would charge twice.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkOptionsText } from './context.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DATA = path.join(HERE, '..', 'data')
const OPENROUTER = 'https://openrouter.ai/api/v1'

/** Generation categories. Audio splits into subtypes, each with its own ranking and its own top. */
export const GENERATION_CATEGORIES = ['image', 'video', 'music', 'speech']
/** Category with no measured generation route: build writes judging_only and generate exits before estimating. */
const NO_ROUTE = { speech: 'no_verified_route' }
/** A top older than this makes generate emit a warning (the live catalog is checked either way). */
const MAX_AGE_DAYS = 14
// In /models, TTS declares output_modalities ["speech"] (checked 2026-11-08), not "audio".
const OUTPUT_MEDIA = { image: 'image', video: 'video', music: 'audio', speech: 'speech' }
const UNIT = { image: 'image', video: 'second', music: 'track', speech: 'character' }
export const TOP_MAX = 3
export const DEFAULT_CAP = 3
export const DEFAULT_DURATION_S = 7
const TOKENS_PER_IMAGE_1K = 1120 // measured on Gemini 1K (costs.jsonl); converts the catalog's pricing.image_output
const DEADLINE_MS = { video: 15 * 60 * 1000, other: 5 * 60 * 1000 }
const EPS = 1e-9

/** Limits measured or documented per generator (lessons from v07-generation). The module never sends the fields that break. */
export const LIMITS = {
  'google/lyria-3-clip-preview': ['Clip: always 30 s', 'audio.format wav returns an empty stream; use the default mp3'],
  'google/lyria-3-pro-preview': ['Pro: ~104 s (104–105 s for an 8-bar request), no duration control',
    'audio.format wav returns an empty stream; use the default mp3', 'no native loop and no guarantee of BPM or of a melody given as notes'],
  'google/gemini-omni-1.2-flash': ['fails with generate_audio true set explicitly (audio comes by default)', 'fails with frame_images',
    'fails with a 1280x720 reference; works with 640x360', 'failed calls are not charged'],
}

const sha = (v) => createHash('sha256').update(v).digest('hex')
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)) }
/** Positive number or null. */
const positive = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null }
/** Finite number (zero counts) or null. */
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

// ---------- A1: build the generators top ----------

const normRes = (r) => String(r).trim().toLowerCase()

/**
 * Parses the `resolution` field of the video ranking, in the format "720p (480p 0.05; 1080p 0.20)": the first one is the SKU's
 * resolution (the one the per-second `usd` belongs to) and the parentheses carry the other known per-second prices.
 * Returns { resolution, by_resolution }, or {} when the text is not in that format (for example "480p, 720p", a list with
 * no prices): no SKU resolution is recorded.
 */
function skuResolutions(text, usd) {
  const m = String(text ?? '').trim().match(/^(\d+p|\d+k)(?:\s*\((.*)\))?$/i)
  if (!m) return {}
  const byRes = { [m[1]]: usd }
  for (const entry of (m[2] ?? '').split(';')) {
    const x = entry.trim().match(/^(\d+p|\d+k)\s+([\d.]+)$/i)
    if (x && positive(x[2])) byRes[x[1]] = Number(x[2])
  }
  return { resolution: m[1], by_resolution: byRes }
}

/** Price per unit in USD, with its origin. null when there is only a per-token price (no estimate). */
function unitPrice(m, category, inCatalog) {
  const p = m.price ?? {}
  const unit = UNIT[category]
  const priced = (usd, origin) => (usd === null ? null : { unit, usd, origin, detail: p.how_calculated ?? null })
  if (category === 'image') {
    const entries = (p.measured ?? []).filter((e) => positive(e.usd))
    if (entries.length) {
      const largest = entries.reduce((a, b) => (b.usd > a.usd ? b : a))
      return { ...priced(largest.usd, `measured in real calls (largest of ${entries.length}: ${largest.file}, ${largest.date})`), measured: entries }
    }
    const measured = positive(p.measured_usd)
    if (measured) return priced(measured, 'ranking: measured cost in real calls')
    const tokens = positive(inCatalog?.pricing?.image_output)
    if (tokens) return priced(+(tokens * TOKENS_PER_IMAGE_1K).toFixed(6), `catalog: pricing.image_output × ${TOKENS_PER_IMAGE_1K} tokens per image`)
    return priced(positive(p.estimated_per_image_usd), 'ranking: estimate')
  }
  if (category === 'video') {
    const base = priced(positive(p.per_second_usd), 'ranking: per-second SKU from /videos/models')
    return base && { ...base, ...skuResolutions(p.resolution, base.usd) }
  }
  if (category === 'music') return priced(positive(p.measured_usd) ?? positive(p.per_track_usd), 'ranking: per-track price')
  // speech: only a per-character price counts; "Per token" does not match and stays without an estimate
  const text = String(p.how_calculated ?? '').match(/US\$\s*([\d.,]+)\s+per\s+character\b/i)
  return priced(positive(p.per_character_usd) ?? (text ? positive(text[1].replace(',', '.')) : null), 'ranking: per-character price')
}

/** Identity (benchmark model = OpenRouter id) checked by the conductor; absent counts as unchecked. */
function identityOf(v) {
  if (v === true) return { checked: true }
  if (v && typeof v === 'object') return { checked: v.checked === true, source: v.source ?? null, date: v.date ?? null }
  return { checked: false }
}

/**
 * Top generators of a category (image, video, music, speech) from /models and the ranking file.
 * Top = ranking ∩ catalog (media output), in ranking order, up to TOP_MAX, never filled with a model from outside the ranking.
 * A model with no USD-convertible price (tokens only) drops out of the top with no substitute. Unchecked identity or an empty top
 * gives state judging_only. `previous` is the result of the previous build, to record who entered and who left.
 */
export function buildGenerators(catalog, ranking, category, { now = new Date().toISOString(), previous = null, catalog: catalogInfo = null } = {}) {
  if (!GENERATION_CATEGORIES.includes(category)) throw new Error(`category must be ${GENERATION_CATEGORIES.join(', ')}`)
  const rankingCategories = ranking.category === 'audio' ? 'music|speech' : ranking.category
  if (ranking.category && !rankingCategories.split('|').includes(category)) throw new Error(`a ${ranking.category} ranking cannot be used for ${category}`)
  const source = ranking.subtypes ? ranking.subtypes[category] : ranking
  if (!source?.models) throw new Error(`ranking has no models for ${category}`)
  const bench = source.benchmark ?? ranking.benchmark
  const identity = identityOf(source.identity_checked ?? ranking.identity_checked)
  const media = OUTPUT_MEDIA[category]
  const byId = new Map(catalog.map((c) => [c.id, c]))

  const absent = []
  const common = []
  source.models.forEach((m, i) => {
    const c = byId.get(m.model)
    if (!c) absent.push({ model: m.model, position: i + 1, reason: 'outside the queried catalog' })
    else if (!c.architecture?.output_modalities?.includes(media)) absent.push({ model: m.model, position: i + 1, reason: `catalog has no ${media} output` })
    else common.push({ m, c, position: i + 1 })
  })

  const top = []
  const noEstimate = []
  for (const { m, c, position } of common.slice(0, TOP_MAX)) {
    const price = unitPrice(m, category, c)
    if (!price) { noEstimate.push({ model: m.model, position, reason: `no price per ${UNIT[category]} convertible to USD: ${m.price?.how_calculated ?? 'price missing'}` }); continue }
    top.push({ model: m.model, name: m.name ?? c.name, position, score: m.score, ...(m.secondary_score !== undefined ? { secondary_score: m.secondary_score } : {}),
      benchmark: bench.name, benchmark_version: bench.version ?? null, source: m.source, date: bench.queried_at, price,
      limits: LIMITS[m.model] ?? [],
      capabilities: Object.fromEntries(['accepts_reference', 'accepts_first_frame', 'generates_audio', 'max_duration_s'].filter((k) => m[k] !== undefined).map((k) => [k, m[k]])),
      note: m.note ?? null })
  }

  const before = (previous?.top ?? []).map((g) => g.model)
  const currentIds = top.map((g) => g.model)
  const reason = !identity.checked ? 'identity_unchecked' : !top.length ? (common.length ? 'no_estimate_for_any' : 'empty_intersection') : NO_ROUTE[category] ?? null
  return { category, state: reason ? 'judging_only' : 'ok', reason, built_at: now,
    catalog: catalogInfo ?? { source: `${OPENROUTER}/models`, queried_at: now },
    benchmark: { name: bench.name, version: bench.version ?? null, source: bench.source, queried_at: bench.queried_at },
    identity_checked: identity, top,
    entered: currentIds.filter((id) => !before.includes(id)), left: before.filter((id) => !currentIds.includes(id)),
    absent_from_catalog: absent, no_estimate: noEstimate }
}

const dataFile = (category) => path.join(DATA, `generators-${category === 'image' || category === 'video' ? category : 'audio'}.json`)

/** Saved top of the category (music and speech live in generators-audio.json, by subtype). */
export function readGenerators(category) {
  if (!GENERATION_CATEGORIES.includes(category)) throw new Error(`category must be ${GENERATION_CATEGORIES.join(', ')}`)
  const d = read(dataFile(category))
  return d.subtypes ? d.subtypes[category] : d
}

/** Top item for recommend (generator.json): by id (`model`) or by position in the top (1 = first). Refuses anything not in the top. */
export function topItem(list, { model, position } = {}) {
  const top = list.top ?? []
  const g = model ? top.find((x) => x.model === model) : top[position - 1]
  if (!g) throw new Error(`generator: ${model ?? `position ${position}`} is not in the top (${top.map((x) => x.model).join(', ') || 'empty top'})`)
  return g
}

// ---------- A2: pre-checks and estimate ----------

/** Access to the /videos listing (a GET that generates nothing). */
async function checkVideos(fetchFn, key) {
  try {
    const r = await fetchFn(`${OPENROUTER}/videos/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) })
    return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` }
  } catch (e) { return { ok: false, error: String(e.message ?? e).slice(0, 200) } }
}

/**
 * Resolution and per-second price of a video generator for this request. Returns { resolution, usd, reason }.
 * With `price.resolution` saved in the top: a request with no resolution gets the SKU's; one equal to the SKU's gets `price.usd`;
 * any other only counts if `price.by_resolution` has its price; otherwise { resolution: null, usd: null, reason } (no_estimate, nothing is sent).
 * Without `price.resolution` (top saved before v2): old behaviour, `price.usd` is taken as the price of the requested resolution
 * (default 720p), with no guarantee that the price belongs to that resolution.
 */
export function resolveVideoPrice(generator, prompt) {
  const price = generator.price ?? {}
  const requested = prompt.resolution ?? null
  if (!price.resolution) return { resolution: requested ?? '720p', usd: positive(price.usd), reason: null }
  if (!requested) return { resolution: price.resolution, usd: positive(price.usd), reason: null }
  const isSku = normRes(requested) === normRes(price.resolution)
  const key = isSku ? price.resolution : Object.keys(price.by_resolution ?? {}).find((k) => normRes(k) === normRes(requested))
  const usd = isSku ? positive(price.usd) : key ? positive(price.by_resolution[key]) : null
  return usd ? { resolution: key, usd, reason: null }
    : { resolution: null, usd: null, reason: `resolution ${requested} has no known price (the SKU is ${price.resolution})` }
}

/** Projected cost of 1 candidate: image per image, video per second (at the SKU's resolution, see resolveVideoPrice), music per track, speech per character. */
export function projectedCost(generator, category, prompt) {
  const usd = category === 'video' ? resolveVideoPrice(generator, prompt).usd : generator.price?.usd
  if (!positive(usd)) return null
  const units = category === 'video' ? positive(prompt.duration_s) ?? DEFAULT_DURATION_S : category === 'speech' ? [...prompt.text].length : 1
  return +(usd * units).toFixed(6)
}

// ---------- A2: generation routes ----------

/** Generation failure carrying the returned cost (0 = not charged, null = unknown). */
class Failure extends Error {
  constructor(message, cost = 0) { super(message); this.cost = cost }
}

const REF_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
const referenceParts = (prompt) => (prompt.references ?? []).map((f) => ({ type: 'image_url',
  image_url: { url: `data:${REF_MIME[path.extname(f).toLowerCase()] ?? 'image/png'};base64,${fs.readFileSync(f).toString('base64')}` } }))

async function jsonOf(r) {
  const txt = await r.text()
  try { return { j: JSON.parse(txt), txt } } catch { return { j: null, txt } }
}

/** POST /images → data[0].b64_json, usage.cost. */
async function imageRoute(g, prompt, ctx) {
  const refs = referenceParts(prompt)
  const r = await ctx.request('POST', '/images', { model: g.model, prompt: prompt.text, aspect_ratio: prompt.aspect_ratio ?? '1:1',
    resolution: prompt.resolution ?? '1K', ...(refs.length ? { input_references: refs } : {}) })
  const { j, txt } = await jsonOf(r)
  if (!r.ok) throw new Failure(`HTTP ${r.status}: ${txt.slice(0, 400)}`)
  const im = j?.data?.[0]
  if (!im?.b64_json) throw new Failure('response without image', num(j?.usage?.cost) ?? 0)
  const ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp' }[im.media_type] ?? 'png'
  return { bytes: Buffer.from(im.b64_json, 'base64'), ext, cost: num(j.usage?.cost) }
}

/** Reads the whole SSE stream (events arrive cut at any point): concatenates delta.audio.data, keeps the id, usage and error. */
async function readSse(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const audio = []
  const meta = { id: null, usage: null, error: null }
  let buffer = ''
  const handleLine = (l) => {
    const t = l.trim()
    if (!t.startsWith('data:') || t === 'data: [DONE]') return
    let ev
    try { ev = JSON.parse(t.slice(5)) } catch { return }
    meta.id = ev.id ?? meta.id
    meta.usage = ev.usage ?? meta.usage
    if (ev.error) meta.error = JSON.stringify(ev.error).slice(0, 300)
    for (const c of ev.choices ?? []) if (c.delta?.audio?.data) audio.push(c.delta.audio.data)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop()
    parts.forEach(handleLine)
  }
  handleLine(buffer + decoder.decode())
  return { bytes: Buffer.from(audio.join(''), 'base64'), ...meta }
}

/** POST /chat/completions with stream and modalities text+audio → concatenated audio (mp3 by default; wav comes back empty). */
async function musicRoute(g, prompt, ctx) {
  const r = await ctx.request('POST', '/chat/completions', { model: g.model, messages: [{ role: 'user', content: prompt.text }],
    modalities: ['text', 'audio'], stream: true })
  if (!r.ok) throw new Failure(`HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`)
  const s = await readSse(r)
  let cost = num(s.usage?.cost)
  if (cost === null && s.id) cost = await ctx.generationCost(s.id)
  if (s.error) throw new Failure(`stream error: ${s.error}`, cost)
  if (!s.bytes.length) throw new Failure('stream without audio', cost)
  return { bytes: s.bytes, ext: s.bytes.subarray(0, 4).toString('latin1') === 'RIFF' ? 'wav' : 'mp3', cost }
}

const FINAL_JOB = ['completed', 'failed', 'cancelled', 'expired']

/** POST /videos, polls GET /videos/{id} until done, downloads /videos/{id}/content?index=0; cost from the job's usage.cost. */
async function videoRoute(g, prompt, ctx) {
  const { resolution, reason } = resolveVideoPrice(g, prompt)
  if (!resolution) throw new Failure(`no_estimate: ${reason}`, 0) // defensive: generate() already drops this generator before any call
  const refs = referenceParts(prompt)
  const r = await ctx.request('POST', '/videos', { model: g.model, prompt: prompt.text, duration: prompt.duration_s ?? DEFAULT_DURATION_S,
    resolution: resolution, aspect_ratio: prompt.aspect_ratio ?? '16:9', ...(refs.length ? { input_references: refs } : {}) })
  const created = await jsonOf(r)
  if (!r.ok) throw new Failure(`HTTP ${r.status}: ${created.txt.slice(0, 400)}`)
  const id = created.j?.id
  if (!id) throw new Failure('response without job id', null)
  let job = created.j
  let consecutiveErrors = 0
  while (!FINAL_JOB.includes(job.status)) {
    await ctx.wait()
    ctx.signal.throwIfAborted()
    const p = await ctx.request('GET', `/videos/${id}`)
    const polled = await jsonOf(p)
    if (p.ok && polled.j) { job = polled.j; consecutiveErrors = 0 } else if (++consecutiveErrors >= 3) throw new Failure(`polling failed 3 times (HTTP ${p.status})`, null)
  }
  const cost = num(job.usage?.cost)
  if (job.status !== 'completed') throw new Failure(`job ${job.status}: ${JSON.stringify(job.error ?? null).slice(0, 300)}`, cost ?? 0)
  const c = await ctx.request('GET', `/videos/${id}/content?index=0`)
  if (!c.ok) throw new Failure(`HTTP ${c.status} downloading the video`, cost)
  const bytes = Buffer.from(await c.arrayBuffer())
  if (!bytes.length) throw new Failure('empty video', cost)
  return { bytes, ext: 'mp4', cost }
}

/** Speech: no route verified in gen.py; the failure is recorded with no call and no cost. */
async function speechRoute() { throw new Failure('no verified generation route for speech', 0) }

const ROUTES = { image: imageRoute, music: musicRoute, video: videoRoute, speech: speechRoute }

// ---------- A2: generate ----------

/**
 * Generates 1 candidate per top generator, with the same prompt (prompt = { text, references?, aspect_ratio?, duration_s?, resolution? }).
 * Order: pre-checks (no_key, no_video_access) → live catalog (anyone who left /models or lost the media output is
 * dropped, with no substitute) → estimate and cut by the cap (cap_exceeded) → calls,
 * one at a time in ranking order, so measured spend counts before the next one: none starts if measured + projected goes over the cap.
 * Unknown cost (deadline exceeded, error mid-stream) counts as the projected one against the cap. Failure or deadline = failure with no substitute.
 * Writes candidates.json, the prompt.json used (serves as --previous in recommend) and the files in `out`.
 * `catalog` (a /models list) replaces the live query; without it, queries /models?output_modalities=all (a GET with no cost).
 * `estimateOnly` just returns the plan, with no network and no writes. `generators` replaces reading data/generators-*.json.
 */
export async function generate({ category, prompt, out, cap = DEFAULT_CAP, estimateOnly = false, fetchFn = fetch, env = process.env,
  deadlineMs = category === 'video' ? DEADLINE_MS.video : DEADLINE_MS.other, generators = null, catalog = null,
  intervalMs = 10000, nowMs = Date.now() }) {
  if (!GENERATION_CATEGORIES.includes(category)) throw new Error(`category must be ${GENERATION_CATEGORIES.join(', ')}`)
  if (!prompt?.text) throw new Error('prompt.text is required')
  // An invalid cap (NaN, zero, negative) would turn off the "> cap" comparisons; fail before spending.
  if (!(Number.isFinite(cap) && cap > 0)) throw new Error(`--cap must be a number greater than zero (got ${cap})`)
  const list = generators ?? readGenerators(category)
  const ageDays = list.built_at ? (nowMs - Date.parse(list.built_at)) / 86400000 : null
  const base = { category, cap, prompt, generators: { state: list.state, reason: list.reason ?? null, built_at: list.built_at ?? null },
    no_estimate: list.no_estimate ?? [],
    ...(ageDays > MAX_AGE_DAYS ? { warnings: [`top built ${Math.floor(ageDays)} days ago: run generation.mjs build`] } : {}) }
  if (!estimateOnly) {
    if (!out) throw new Error('out is required')
    if (fs.existsSync(path.join(out, 'candidates.json'))) throw new Error('output folder already has candidates.json: use a new folder')
  }
  const finish = (state, rest) => {
    const r = { ...base, state, cuts: [], pre_checks: null, projected_usd: 0, measured_usd: 0, candidates: [], ...rest }
    if (!estimateOnly) write(path.join(out, 'candidates.json'), r)
    return r
  }

  if (NO_ROUTE[category]) return finish('zero_candidates', { reason: NO_ROUTE[category] })
  const top = list.state === 'ok' ? list.top ?? [] : []
  if (!top.length) return finish('zero_candidates', { reason: list.reason ?? 'empty top' })

  const key = env.OPENROUTER_API_KEY ?? ''
  const pre = { key: { ok: Boolean(key) },
    videos: { needed: category === 'video', ok: null, skipped: category !== 'video' ? 'not_video' : estimateOnly ? 'estimate_only' : 'not_checked' } }
  if (!estimateOnly) {
    if (!pre.key.ok) return finish('no_key', { pre_checks: pre })
    if (pre.videos.needed) {
      pre.videos = { needed: true, ...(await checkVideos(fetchFn, key)) }
      if (!pre.videos.ok) return finish('no_video_access', { pre_checks: pre })
    }
  }

  // E4: the saved top is checked against the live catalog before estimating; anyone who left is not called.
  const cat = catalog ?? (await fetchFn(`${OPENROUTER}/models?output_modalities=all`).then((r) => r.json()).then((j) => j.data, () => null))
  if (!Array.isArray(cat)) throw new Error('OpenRouter catalog unavailable (no data in /models); use --catalog models.json')
  const byId = new Map(cat.map((c) => [c.id, c]))
  const dropped = []
  const active = top.filter((g) => {
    const c = byId.get(g.model)
    const reason = !c ? 'not in /models' : !c.architecture?.output_modalities?.includes(OUTPUT_MEDIA[category]) ? `no ${OUTPUT_MEDIA[category]} output` : null
    if (reason) dropped.push({ model: g.model, reason: 'left_catalog', detail: `${reason}; run generation.mjs build` })
    return !reason
  })
  if (!active.length) return finish('zero_candidates', { reason: 'left_catalog', pre_checks: pre, cuts: dropped })

  // Estimate and cut: accumulates from best to worst; the first one that goes over and everyone after it are left out, with no substitute.
  const plan = []
  const cuts = [...dropped]
  let accumulated = 0
  let cutting = false
  for (const g of active) {
    const projected = projectedCost(g, category, prompt)
    if (projected === null) {
      const detail = category === 'video' ? resolveVideoPrice(g, prompt).reason : null
      cuts.push({ model: g.model, reason: 'no_estimate', ...(detail ? { detail } : {}) })
      continue
    }
    if (!cutting && accumulated + projected <= cap + EPS) { plan.push({ g, projected }); accumulated += projected; continue }
    cutting = true
    cuts.push({ model: g.model, reason: 'cut_by_cap', projected_cost: projected, accumulated_before: +accumulated.toFixed(6) })
  }
  const projectedUsd = +accumulated.toFixed(6)
  if (!plan.length) {
    return cuts.every((c) => c.reason === 'no_estimate') ? finish('zero_candidates', { reason: 'no_estimate_for_any', pre_checks: pre, cuts })
      : finish('cap_exceeded', { pre_checks: pre, cuts })
  }
  // Video records the resolution sent and the price's resolution: if they differ or the price's is null, the estimate is not guaranteed.
  const record = (g, projected, extra) => ({ model: g.model, position: g.position, prompt: prompt.text, file: null, sha256: null,
    ...(category === 'video' ? { resolution: resolveVideoPrice(g, prompt).resolution, price_resolution: g.price?.resolution ?? null } : {}),
    projected_cost: projected, measured_cost: null, state: 'projected', error: null, ...extra })
  if (estimateOnly) return finish('ok', { pre_checks: pre, cuts, projected_usd: projectedUsd, candidates: plan.map(({ g, projected }) => record(g, projected, {})) })

  const newSignal = () => AbortSignal.timeout(deadlineMs)
  fs.mkdirSync(out, { recursive: true })
  write(path.join(out, 'prompt.json'), prompt)
  const candidates = []
  let spent = 0
  for (const [i, { g, projected }] of plan.entries()) {
    if (spent + projected > cap + EPS) {
      candidates.push(record(g, projected, { state: 'not_started', error: `cap: measured spend ${spent.toFixed(4)} + projected ${projected.toFixed(4)} exceeds ${cap}` }))
      continue
    }
    const signal = newSignal()
    const ctx = { signal, wait: () => new Promise((r) => setTimeout(r, intervalMs)),
      request: (method, route, body) => fetchFn(`${OPENROUTER}${route}`, { method, signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'curation-generation' }, ...(body ? { body: JSON.stringify(body) } : {}) }),
      generationCost: async (id) => {
        for (let t = 0; t < 3; t++) {
          const r = await ctx.request('GET', `/generation?id=${encodeURIComponent(id)}`)
          const cost = r.ok ? num((await jsonOf(r)).j?.data?.total_cost) : null
          if (cost !== null) return cost
          await ctx.wait()
        }
        return null
      } }
    let item
    try {
      const r = await ROUTES[category](g, prompt, ctx)
      const file = path.resolve(out, `${String(i + 1).padStart(2, '0')}-${g.model.replace(/[/:]/g, '_')}.${r.ext}`)
      fs.writeFileSync(file, r.bytes)
      item = record(g, projected, { file, sha256: sha(r.bytes), measured_cost: r.cost, state: 'ok' })
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      item = record(g, projected, { state: 'failed', measured_cost: e instanceof Failure ? e.cost : null,
        error: timedOut ? `deadline of ${deadlineMs / 60000} min exceeded; cost unknown` : String(e.message ?? e).slice(0, 400) })
    }
    spent += item.measured_cost ?? projected
    candidates.push(item)
  }
  const measured = candidates.reduce((s, c) => s + (c.measured_cost ?? 0), 0)
  return finish(candidates.some((c) => c.state === 'ok') ? 'ok' : 'zero_candidates', { pre_checks: pre, cuts, projected_usd: projectedUsd,
    measured_usd: +measured.toFixed(6), unknown_costs: candidates.filter((c) => c.state !== 'not_started' && c.measured_cost === null).length, candidates })
}

// ---------- B1: candidates → decision input ----------

export const OPTIONS_MAX = 4
const DEFAULT_QUESTION = 'Which version of the asset should be used in the game?'
const NEUTRAL_EVIDENCE = 'The options are versions of the same asset; judge by the attached material and the context.'

/**
 * Builds the curation decision input from candidates.json (the output of `generate`) and the current asset.
 * Copies every candidate with state ok and the current asset into `out` as option-N.ext, in file sha256 order (which does not give away the current one),
 * with the same text for all ("version N of the asset"). Writes input.json ({ question, options: [{ id, text, media }], categories, evidence })
 * and, next to it, origin.json ({ "option-N": { origin: 'generator', model, measured_cost, prompt_sha } | { origin: 'current', file } }),
 * which stays out of the input so the juror never sees it. Ids are neutral; `run` draws the letters later.
 * `candidates` is a path to a candidates.json, an already-read object, or a list of them (finalists from several generations);
 * `files` is an optional list of loose files (for example the chosen one from a previous decision), with origin 'file'. Refuses: a folder that already has input.json, fewer than 2 or more than 4 options
 * (3 ok candidates + the current one), a missing file, or text/id/file name that fails checkOptionsText. Nothing is written on a refusal.
 */
export function forJudging({ candidates = [], files = [], current, out, question = DEFAULT_QUESTION, categories = [] }) {
  const groups = [candidates].flat().filter(Boolean)
  if ((!groups.length && !files.length) || !current || !out) throw new Error('for-judging: candidates (or files), current and out are required')
  const list = groups.flatMap((g) => (typeof g === 'string' ? read(g) : g).candidates ?? [])
  const inputJson = path.join(out, 'input.json')
  if (fs.existsSync(inputJson)) throw new Error('for-judging: output folder already has input.json: use a new folder')
  const readBytes = (f) => { if (!fs.existsSync(f)) throw new Error(`for-judging: file does not exist: ${f}`); return fs.readFileSync(f) }

  const sources = list.filter((c) => c.state === 'ok' && c.file).map((c) => ({ source: c.file, bytes: readBytes(c.file),
    origin: { origin: 'generator', model: c.model, file: path.resolve(c.file), measured_cost: c.measured_cost ?? null, prompt_sha: c.prompt ? sha(c.prompt) : null } }))
  for (const a of files) sources.push({ source: a, bytes: readBytes(a), origin: { origin: 'file', file: path.resolve(a) } })
  sources.push({ source: current, bytes: readBytes(current), origin: { origin: 'current', file: path.resolve(current) } })
  if (sources.length < 2) throw new Error('for-judging: no candidate with state ok and no file; a decision needs at least 2 options')
  if (sources.length > OPTIONS_MAX) throw new Error(`for-judging: ${sources.length - 1} ok candidates plus the current one make ${sources.length} options; the decision accepts 2 to ${OPTIONS_MAX} (at most ${OPTIONS_MAX - 1} candidates)`)

  sources.forEach((f) => { f.sha = sha(f.bytes) })
  // Two identical sources would give the jury two identical options (e.g. the current one won j1 and came back as old).
  const duplicates = sources.filter((f, i) => sources.findIndex((g) => g.sha === f.sha) !== i)
  if (duplicates.length) throw new Error(`for-judging: duplicate file (same sha256): ${duplicates.map((f) => f.source).join(', ')}`)
  sources.sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0))
  const plan = sources.map((f, i) => {
    const id = `option-${i + 1}`
    return { ...f, id, destination: path.resolve(out, `${id}${path.extname(f.source).toLowerCase()}`) }
  })
  const options = plan.map((p, i) => ({ id: p.id, text: `version ${i + 1} of the asset`, media: [p.destination] }))
  if (!(Array.isArray(categories) && categories.length >= 2)) throw new Error('for-judging: --categories is required, with at least 2 (without categories the decision comes out with no scores and the recommender with no per-category critiques)')
  const findings = checkOptionsText(options)
  if (findings.length) throw new Error(`for-judging: the input gives away the origin: ${findings.map((a) => `${a.option} (${a.where}): ${a.problem} "${a.excerpt}"`).join('; ')}`)

  fs.mkdirSync(out, { recursive: true })
  for (const p of plan) fs.writeFileSync(p.destination, p.bytes)
  const input = { question, options, categories, evidence: NEUTRAL_EVIDENCE }
  const origin = Object.fromEntries(plan.map((p) => [p.id, p.origin]))
  write(inputJson, input)
  write(path.join(out, 'origin.json'), origin)
  return { input, origin, files: { input: path.resolve(inputJson), origin: path.resolve(out, 'origin.json') } }
}

// ---------- CLI ----------

function flags(args) {
  const f = {}
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error(`unexpected argument: ${args[i]}`)
    if (['--estimate-only'].includes(args[i])) { f[args[i].slice(2)] = true; continue }
    f[args[i].slice(2)] = args[++i]
  }
  return f
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const f = flags(rest)
  if (cmd === 'build') {
    if (!['image', 'video', 'audio'].includes(f.category) || !f.ranking) throw new Error('--category image|video|audio and --ranking are required')
    const now = new Date().toISOString()
    const catalog = f.catalog ? read(f.catalog).data ?? read(f.catalog) : (await (await fetch(`${OPENROUTER}/models?output_modalities=all`)).json()).data
    const catalogInfo = f.catalog ? { source: path.resolve(f.catalog).replaceAll('\\', '/'), queried_at: f['catalog-date'] ?? now, note: 'saved catalog; the real round queries /models again' } : null
    const destination = f.out ?? dataFile(f.category === 'audio' ? 'music' : f.category)
    const before = fs.existsSync(destination) ? read(destination) : null
    const ranking = read(f.ranking)
    const build = (cat, previous) => buildGenerators(catalog, ranking, cat, { now, previous, catalog: catalogInfo ?? undefined })
    const r = f.category === 'audio'
      ? { category: 'audio', built_at: now, subtypes: { music: build('music', before?.subtypes?.music), speech: build('speech', before?.subtypes?.speech) } }
      : build(f.category, before)
    write(destination, r)
    const summary = (x) => ({ state: x.state, reason: x.reason, top: x.top.map((g) => g.model), entered: x.entered, left: x.left,
      absent: x.absent_from_catalog.length, no_estimate: x.no_estimate.map((s) => s.model) })
    console.log(JSON.stringify({ written: destination, ...(r.subtypes ? Object.fromEntries(Object.entries(r.subtypes).map(([k, v]) => [k, summary(v)])) : summary(r)) }, null, 1))
  } else if (cmd === 'generate') {
    for (const k of ['category', 'prompt']) if (!f[k]) throw new Error(`--${k} is required`)
    if (!f.out && !f['estimate-only']) throw new Error('--out is required')
    const r = await generate({ category: f.category, prompt: read(f.prompt), out: f.out && path.resolve(f.out), cap: f.cap ? Number(f.cap) : DEFAULT_CAP,
      estimateOnly: Boolean(f['estimate-only']), catalog: f.catalog ? read(f.catalog).data ?? read(f.catalog) : null })
    console.log(JSON.stringify({ state: r.state, cap: r.cap, projected_usd: r.projected_usd, measured_usd: r.measured_usd, cuts: r.cuts,
      candidates: r.candidates.map((c) => ({ model: c.model, state: c.state, measured_cost: c.measured_cost, file: c.file, error: c.error })) }, null, 1))
  } else if (cmd === 'generator') {
    if (!f.category || !f.out || (!f.model && !f.position)) throw new Error('--category, --out and --model or --position are required')
    const r = topItem(readGenerators(f.category), { model: f.model, position: f.position && Number(f.position) })
    write(path.resolve(f.out), r)
    console.log(JSON.stringify({ written: path.resolve(f.out), model: r.model, position: r.position }, null, 1))
  } else if (cmd === 'for-judging') {
    for (const k of ['current', 'out']) if (!f[k]) throw new Error(`--${k} is required`)
    if (!f.candidates && !f.files) throw new Error('--candidates or --files is required')
    const csv = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [])
    const r = forJudging({ candidates: csv(f.candidates), files: csv(f.files), current: f.current, out: path.resolve(f.out), question: f.question,
      categories: f.categories ? f.categories.split(',').map((c) => c.trim()).filter(Boolean) : [] })
    console.log(JSON.stringify({ ...r.files, options: r.input.options.map((o) => o.id) }, null, 1))
  } else {
    console.error('Usage: generation.mjs build|generate|generator|for-judging (see the header)')
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.message); process.exit(1) })
}
