#!/usr/bin/env node
// Curation: the paid council that judges image, audio and video. Node 24+, no dependencies.
//
//   node curation.mjs jury --category image|audio|video
//   node curation.mjs build-jury --category C --scores scores.json [--current-claude]   (rebuilds the snapshot)
//   node curation.mjs run --category C --input input.json --out new-folder --cap 3 [--mode decision|scores|vote] [--items items.json] [--estimate-only]
//                         [--context context.json] [--seed S] [--claude-openrouter]
//   node curation.mjs build-context --target target.json --root game-repo --out context.json
//
// Every juror gets the same message: the packet as text, with the media attachments embedded as base64.
// Non-Claude models go straight to the OpenRouter API (the OpenCode route does not deliver audio or video; see SKILL.md).
// Claude goes through CLIProxyAPI (subscription), after a real probe with the media; without access it stays out of the
// round (no paid fallback), unless --claude-openrouter sends it to OpenRouter with a warning. Validation, quorum, counts
// and the table are the council's.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const COUNCIL = path.join(HERE, '..', '..', 'council', 'scripts')
const imp = (f) => import(pathToFileURL(path.join(COUNCIL, f)).href)
const { decisionPacket, votePacket, validateDecision, validateReview, validateVotes, extractJson, agreement } = await imp('council-t3.mjs')
const { tally, quorumByAnswer } = await imp('tally.mjs')
const { weights } = await imp('weights.mjs')
const { renderTable } = await imp('council-table.mjs')
import { buildContext, contextBlock, anonymizeOptions, checkOptionsText, categoryWarnings } from './context.mjs'

export const CATEGORIES = ['image', 'audio', 'video']
export const DATA = path.join(HERE, '..', 'data')
const OPENROUTER = 'https://openrouter.ai/api/v1'
const PROXY = 'http://127.0.0.1:8317/v1'
/** Current Claude models with vision (gmunaro's request, 2026-11-07; Fable 5.1 replaced by 5.2 on 2026-11-10): all of them join the image jury. OpenRouter id -> proxy id. */
export const CURRENT_CLAUDE = {
  'anthropic/claude-fable-5.2': 'claude-fable-5-2',
  'anthropic/claude-opus-5.5': 'claude-opus-5-5',
  'anthropic/claude-sonnet-5.5': 'claude-sonnet-5-5',
  'anthropic/claude-haiku-5.5': 'claude-haiku-5-5',
}
export const JURY_SIZE = 9
export const EFFORT = 'medium'
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }
const CATEGORY_OF_MIME = { image: 'image', audio: 'audio', video: 'video' }
// Media token estimates for the upfront cap check. Conservative; the real cost comes from OpenRouter.
const IMAGE_TOKENS = 2500
const AUDIO_TOKENS_S = 50
const VIDEO_TOKENS_S = 350
const MAX_OUTPUT = 12000
const ESTIMATED_OUTPUT = 4000
const CALL_DEADLINE_MS = 5 * 60 * 1000

const sha = (v) => createHash('sha256').update(v).digest('hex')
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const readIf = (f) => { try { return read(f) } catch { return null } }
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1)) }
const price = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

// ---------- jury and weights ----------

export const juryPath = (category) => path.join(DATA, `jury-${category}.json`)

/** Frozen snapshot of the category's jury. Rejects an unknown category. */
export function readJury(category) {
  if (!CATEGORIES.includes(category)) throw new Error(`category must be ${CATEGORIES.join(', ')}`)
  return read(juryPath(category))
}

/**
 * Published weight for curation: the category's primary benchmark score, with source, version and date.
 * Passed to the council's weights(), tally() and renderTable() in place of the Intelligence Index.
 */
export const publishedFor = (benchmark) => (i) => Number.isFinite(i?.value) && i.value >= 0 && i.scale === benchmark
  && Boolean(String(i.version ?? '').trim()) && Number.isFinite(Date.parse(i.queried_at)) && /^https?:\/\//.test(i.source ?? '')

/**
 * Builds the top 9 from the current catalog and the benchmark scores. scores = { benchmark: { name, version, source,
 * queried_at, reason }, models: [{ model, value, source, note? }], secondaries?: [{ model, benchmark, value, source }] }.
 * Order: primary score first (desc); then secondary score (desc, same secondary benchmark); nothing else.
 * `currentClaude` reserves seats for every current Claude model that accepts the media (gmunaro's request for image).
 */
export function buildJury(catalog, scores, category, { currentClaude = false, now = new Date().toISOString() } = {}) {
  const byId = new Map(catalog.map((m) => [m.id, m]))
  const accepts = (m) => m?.architecture?.input_modalities?.includes(category) && m.architecture.output_modalities?.includes('text')
  const shortfalls = []
  const member = (id, origin) => {
    const m = byId.get(id)
    const score = scores.models.find((n) => n.model === id)
    const secondary = (scores.secondaries ?? []).find((n) => n.model === id)
    const reasoning = (m.supported_parameters ?? []).includes('reasoning')
    return { model: id, name: m.name, origin,
      proxy: CURRENT_CLAUDE[id] ?? null,
      effort: reasoning ? EFFORT : null, effort_note: reasoning ? 'medium requested (reasoning.effort)' : 'no effort control',
      price: Object.fromEntries(Object.entries(m.pricing ?? {}).map(([k, v]) => [k, price(v)])),
      index: score ? { value: score.value, scale: scores.benchmark.name, version: scores.benchmark.version, source: score.source,
        queried_at: scores.benchmark.queried_at, ...(score.note ? { note: score.note } : {}) } : null,
      secondary: secondary ?? null }
  }
  const chosen = []
  if (currentClaude) for (const id of Object.keys(CURRENT_CLAUDE)) {
    if (accepts(byId.get(id))) chosen.push(member(id, 'current_claude'))
    else shortfalls.push({ model: id, reason: 'Current Claude missing from the catalog or without the input' })
  }
  const isFree = (id) => !chosen.some((e) => e.model === id)
  const scored = scores.models.filter((n) => accepts(byId.get(n.model)) && isFree(n.model)).sort((a, b) => b.value - a.value)
  for (const n of scores.models) if (!accepts(byId.get(n.model))) shortfalls.push({ model: n.model, reason: 'has a score, but is not in the catalog with that input' })
  for (const n of scored) if (chosen.length < JURY_SIZE) chosen.push(member(n.model, 'primary_score'))
  const secondaryPool = (scores.secondaries ?? []).filter((n) => accepts(byId.get(n.model)) && isFree(n.model) && !scores.models.some((p) => p.model === n.model))
    .sort((a, b) => b.value - a.value)
  for (const n of secondaryPool) if (chosen.length < JURY_SIZE) chosen.push(member(n.model, `secondary_score (${n.benchmark})`))
  if (chosen.length < JURY_SIZE) shortfalls.push({ reason: `only ${chosen.length} models with a score and the ${category} input; remaining seats stay empty` })
  const carried = Object.fromEntries(['excluded_by_identity', 'no_score', 'shortfall'].filter((k) => scores[k]).map((k) => [k, scores[k]]))
  return { category, built_at: now, benchmark: scores.benchmark, catalog: { source: `${OPENROUTER}/models`, queried_at: now },
    effort: EFFORT, jury: chosen, shortfalls, ...carried }
}

// ---------- media and message ----------

/** Duration in seconds: mp4/mov via mvhd, ogg via the last granule (48 kHz for Opus, the header's rate for Vorbis). */
export function duration(file) {
  const d = fs.readFileSync(file)
  const ext = path.extname(file).toLowerCase()
  if (['.mp4', '.mov', '.m4a'].includes(ext)) {
    const i = d.indexOf('mvhd')
    if (i < 0) return null
    const v = d[i + 4]
    const [ts, dur] = v === 0 ? [d.readUInt32BE(i + 16), d.readUInt32BE(i + 20)] : [d.readUInt32BE(i + 24), Number(d.readBigUInt64BE(i + 28))]
    return dur / ts
  }
  if (ext === '.ogg') {
    const lastPage = d.lastIndexOf('OggS')
    if (lastPage < 0) return null
    const granule = Number(d.readBigUInt64LE(lastPage + 6))
    const opus = d.indexOf('OpusHead') >= 0
    const vorbis = d.indexOf('vorbis')
    const rate = opus ? 48000 : vorbis >= 0 ? d.readUInt32LE(vorbis + 11) : null
    return rate ? granule / rate : null
  }
  return null
}

/** One attachment: { file, mime, type (image|audio|video), bytes, sha256, seconds }. */
export function attachment(file) {
  const abs = path.resolve(file)
  const mime = MIME[path.extname(abs).toLowerCase()]
  if (!mime) throw new Error(`extension has no known MIME type: ${abs}`)
  const buf = fs.readFileSync(abs)
  return { file: abs, mime, type: CATEGORY_OF_MIME[mime.split('/')[0]], bytes: buf.length, sha256: sha(buf),
    seconds: mime.startsWith('image/') ? null : duration(abs) }
}

/** Parts in OpenRouter's chat completions format. */
export function openRouterParts(blocks) {
  return blocks.map((b) => {
    if (b.text !== undefined) return { type: 'text', text: b.text }
    const data = fs.readFileSync(b.file).toString('base64')
    if (b.type === 'image') return { type: 'image_url', image_url: { url: `data:${b.mime};base64,${data}` } }
    if (b.type === 'audio') return { type: 'input_audio', input_audio: { data, format: path.extname(b.file).slice(1).toLowerCase() } }
    return { type: 'video_url', video_url: { url: `data:${b.mime};base64,${data}` } }
  })
}

/** Blocks in the Anthropic API format (text and image only). */
export function anthropicParts(blocks) {
  return blocks.map((b) => {
    if (b.text !== undefined) return { type: 'text', text: b.text }
    if (b.type !== 'image') throw new Error(`Claude does not accept ${b.type}`)
    return { type: 'image', source: { type: 'base64', media_type: b.mime, data: fs.readFileSync(b.file).toString('base64') } }
  })
}

/**
 * A juror's message: the packet text, then each attachment preceded by the label the packet cites.
 * Decision: the rotation shifts the order of the options in the text and of the attachments together, so the first one is not favored.
 */
export function message(input, mode, rotation = 0, items = null) {
  if (mode === 'decision') {
    const n = input.options.length
    const order = input.options.map((_, i) => input.options[(i + rotation) % n])
    const text = decisionPacket({ ...input, options: input.options.map(({ id, text }) => ({ id, text })) }, rotation)
    const blocks = [{ text: `${text}\n## Attachments\n\nThe attachments below are the material for each option, in the order they appear. Judge what you see and hear in the attachments.` }]
    for (const o of order) (o.media ?? []).forEach((f, k) => blocks.push({ text: `Attachment for option ${o.id}${o.media.length > 1 ? ` (${k + 1}/${o.media.length})` : ''}: ${path.basename(f)}` }, attachment(f)))
    return blocks
  }
  const text = mode === 'vote' ? votePacket(items, input.artifact) : scoresPacket(input)
  const blocks = [{ text }]
  ;(input.media ?? []).forEach((f, k) => blocks.push({ text: `Attachment ${k + 1}: ${path.basename(f)}` }, attachment(f)))
  return blocks
}

/** Per-category scores packet (hill climb): objective, context, rubric with anchors and the council's response format. */
export function scoresPacket({ objective, context = '', categories, anchors = '' }) {
  if (!objective || !Array.isArray(categories) || !categories.length) throw new Error('scores: objective and categories are required')
  const example = { overall_score: 7, scores: categories.map((category) => ({ category, score: 7, gap: 'what prevents a higher score' })),
    fix_points: [{ problem: 'what is wrong in the attachment', fix: 'what to change' }] }
  return `# Evaluation\n\n${objective}\n\n## Player context\n\n${context || 'Judge only by what is in the attachments.'}\n\n## Rubric\n\nInteger score from 1 to 10 for each category (${categories.join(', ')}): 1 = inadequate, 5 = acceptable with caveats, 10 = the best possible. ${anchors}\nIn \`gap\`, write what prevents a higher score; \`nothing\` only with 10. In \`fix_points\`, list each defect with the fix.\n\n## How to respond\n\nRespond only with JSON in this format, with all ${categories.length} categories:\n${JSON.stringify(example)}\n`
}

// ---------- calls ----------

const keyOpenRouter = () => process.env.OPENROUTER_API_KEY ?? ''
const keyProxy = () => process.env.CLIPROXY_API_KEY ?? fs.readFileSync(path.join(os.homedir(), '.t3/secrets/cliproxy-api-key.txt'), 'utf8').trim()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const retryAfter = (r) => Math.min(60000, 1000 * (Number(r.headers.get('retry-after')) || 15))

/** One OpenRouter call. Returns { text, cost_usd, usage, ms, error, finish, http }. Resends once, and only on a 429 or 5xx with a response; a network error or timeout returns uncertain_cost, with no resend. */
export async function callOpenRouter(member, blocks, { maxTokens = MAX_OUTPUT, fetchFn = fetch } = {}) {
  const body = { model: member.model, max_tokens: maxTokens, usage: { include: true },
    messages: [{ role: 'user', content: openRouterParts(blocks) }],
    ...(member.effort ? { reasoning: { effort: member.effort }, provider: { require_parameters: true } } : {}) }
  const t0 = Date.now()
  let last = ''
  const attempts = []
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchFn(`${OPENROUTER}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(CALL_DEADLINE_MS),
        headers: { Authorization: `Bearer ${keyOpenRouter()}`, 'Content-Type': 'application/json', 'X-Title': 'curation' }, body: JSON.stringify(body) })
      const txt = await r.text()
      const j = (() => { try { return JSON.parse(txt) } catch { return null } })()
      if (r.ok && j?.choices?.length) {
        const c = j.choices[0]
        return { text: c.message?.content ?? '', cost_usd: price(j.usage?.cost), usage: j.usage ?? {}, ms: Date.now() - t0,
          error: c.error ? JSON.stringify(c.error).slice(0, 300) : null, finish: c.finish_reason ?? c.native_finish_reason ?? null, http: r.status, provider: j.provider ?? null, id: j.id,
          ...(attempts.length ? { attempts: [...attempts, { http: r.status }] } : {}) }
      }
      last = `HTTP ${r.status}: ${(j?.error ? JSON.stringify(j.error) : txt).slice(0, 400)}`
      attempts.push({ http: r.status, error: last.slice(0, 120) })
      // Only a 429 or 5xx with a response is retried: the call was not served, so there is no charge to lose.
      if (![429, 500, 502, 503, 504].includes(r.status)) break
      await wait(retryAfter(r))
    } catch (e) {
      // Timeout or network: the generation may have been billed without a response. No resend; the cost stays uncertain (the projected cost counts).
      last = `io: ${String(e.message ?? e).slice(0, 300)}`
      attempts.push({ error: last.slice(0, 120) })
      return { text: '', cost_usd: 0, usage: {}, ms: Date.now() - t0, error: last, finish: null, uncertain_cost: true, attempts }
    }
  }
  return { text: '', cost_usd: 0, usage: {}, ms: Date.now() - t0, error: last, finish: null, attempts }
}

/** One Claude call through CLIProxyAPI (subscription), at medium effort with adaptive thinking. */
export async function callClaudeProxy(member, blocks, { maxTokens = MAX_OUTPUT, fetchFn = fetch } = {}) {
  const t0 = Date.now()
  let last = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchFn(`${PROXY}/messages`, { method: 'POST', signal: AbortSignal.timeout(CALL_DEADLINE_MS),
        headers: { Authorization: `Bearer ${keyProxy()}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01',
          'User-Agent': 'claude-cli/2.1.317 (external, t3-code, agent-sdk/0.3.284)' },
        body: JSON.stringify({ model: member.proxy, max_tokens: maxTokens, output_config: { effort: member.effort ?? EFFORT },
          thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: anthropicParts(blocks) }] }) })
      const txt = await r.text()
      const j = (() => { try { return JSON.parse(txt) } catch { return null } })()
      if (r.ok && Array.isArray(j?.content)) {
        return { text: j.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), cost_usd: 0, usage: j.usage ?? {},
          ms: Date.now() - t0, error: null, finish: j.stop_reason ?? null, http: r.status }
      }
      last = `HTTP ${r.status}: ${txt.slice(0, 400)}`
      if (![408, 429, 500, 502, 503, 504, 529].includes(r.status)) break
      await wait(retryAfter(r))
    } catch (e) { last = `io: ${String(e.message ?? e).slice(0, 300)}` }
  }
  return { text: '', cost_usd: 0, usage: {}, ms: Date.now() - t0, error: last, finish: null }
}

/** What the Claude call would have cost on OpenRouter, for the record only (the subscription does not charge per call). */
export function equivalentCost(member, usage) {
  const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  return inputTokens * price(member.price?.prompt) + (usage.output_tokens ?? 0) * price(member.price?.completion)
}

/** A juror's projected cost: estimated text + media plus ESTIMATED_OUTPUT of output, at the snapshot's prices. */
export function projectedCost(member, blocks) {
  let tokens = 0
  let audio = 0
  for (const b of blocks) {
    if (b.text !== undefined) tokens += Math.ceil(b.text.length / 3)
    else if (b.type === 'image') tokens += IMAGE_TOKENS
    else if (b.type === 'audio') audio += Math.ceil((b.seconds ?? b.bytes / 8000) * AUDIO_TOKENS_S)
    else tokens += Math.ceil((b.seconds ?? b.bytes / 400000) * VIDEO_TOKENS_S)
  }
  const p = member.price ?? {}
  const audioPrice = price(p.audio) || price(p.prompt)
  return tokens * price(p.prompt) + audio * audioPrice + ESTIMATED_OUTPUT * price(p.completion)
}

// ---------- round ----------

/**
 * A juror's route. Claude goes through the proxy (subscription) when the probe passed. Probe failed: without claudeOpenrouter
 * the juror stays out of the round (no paid fallback); with claudeOpenrouter it goes through OpenRouter, with its cost in the projected total and a warning in the result.
 */
export function route(member, probes, { claudeOpenrouter = false } = {}) {
  if (!member.proxy) return { route: 'openrouter', reason: null }
  const s = probes[member.model]
  if (s?.ok) return { route: 'proxy-claude', reason: null }
  const failure = `proxy probe failed: ${s?.error ?? 'did not run'}`
  return claudeOpenrouter ? { route: 'openrouter', reason: `${failure}; --claude-openrouter`, route_switched: true }
    : { route: 'none', reason: `${failure}; left out of the round (no --claude-openrouter)` }
}

/** Real probe through the proxy, with the packet's first image, for each Claude in the jury. */
async function probeClaude(jury, image, fetchFn = fetch) {
  const probes = {}
  await Promise.all(jury.filter((m) => m.proxy).map(async (m) => {
    if (!image) { probes[m.model] = { ok: false, error: 'packet has no image for the probe' }; return }
    const r = await callClaudeProxy(m, [image, { text: 'Answer with just 3 words about this image.' }], { maxTokens: 2000, fetchFn })
    probes[m.model] = r.error || !r.text ? { ok: false, error: r.error ?? 'empty response', ms: r.ms } : { ok: true, ms: r.ms, usage: r.usage }
  }))
  return probes
}

function validate(mode, review, input, items) {
  if (mode === 'decision') return validateDecision(review, input.options.map((o) => o.id), input.categories)
  if (mode === 'vote') return validateVotes(review, items.map((i) => i.id))
  return validateReview(review, input.categories)
}

/** Weighted mean and median per category and overall, using only admitted reviews (scores mode). */
export function aggregateScores(entries, categories, opts) {
  const w = weights(entries, opts)
  const adm = entries.map((e, i) => ({ e, ...w[i] })).filter((x) => x.e.admitted)
  const mean = (f) => { const p = adm.reduce((s, x) => s + x.weight, 0); return p ? +(adm.reduce((s, x) => s + f(x.e) * x.weight, 0) / p).toFixed(2) : null }
  const median = (f) => {
    const xs = adm.map((x) => ({ v: f(x.e), p: x.weight })).sort((a, b) => a.v - b.v)
    const total = xs.reduce((s, x) => s + x.p, 0)
    let acc = 0
    for (const x of xs) { acc += x.p; if (acc >= total / 2) return x.v }
    return null
  }
  const { quorum, discarded } = quorumByAnswer(entries.map((e, i) => ({ e, ...w[i] })))
  return { quorum, discarded, overall_mean: mean((e) => e.review.overall_score), overall_median: median((e) => e.review.overall_score),
    by_category: Object.fromEntries(categories.map((c) => [c, mean((e) => e.review.scores.find((n) => n.category === c).score)])),
    fix_points: adm.flatMap((x) => (x.e.review.fix_points ?? []).map((p) => ({ model: x.e.model, ...p }))) }
}

/**
 * Compares the frozen jury with what buildJury would give on the current catalog (same scores from data/scores-<category>.json).
 * Returns who would enter and who would leave, with a warning to run build-jury; without the scores file, reports what is missing.
 */
export function juryChanges(snap, catalog, category) {
  const scores = readIf(path.join(DATA, `scores-${category}.json`))
  if (!scores) return { checked: false, reason: `no data/scores-${category}.json` }
  const currentClaude = snap.jury.some((m) => m.origin === 'current_claude')
  const fresh = buildJury(catalog, scores, category, { currentClaude }).jury.map((m) => m.model)
  const frozen = snap.jury.map((m) => m.model)
  const entered = fresh.filter((id) => !frozen.includes(id))
  const left = frozen.filter((id) => !fresh.includes(id))
  return { checked: true, entered, left, ...(entered.length || left.length ? { warning: `the current catalog changes the jury: run build-jury --category ${category}` } : {}) }
}

/**
 * Runs a complete round. Before: current catalog (accepted media, price), projected cost <= cap, Claude probe.
 * During: everyone in parallel; a call only starts if the measured spend plus what is reserved fits under the cap.
 * After: collection.json in the council's format, the result, cost.json and table.html.
 */
export async function run({ category, input, out, cap, mode = 'decision', items = null, estimateOnly = false, fetchFn = fetch, catalog = null, context = null, seed = null, claudeOpenrouter = false }) {
  if (!(Number.isFinite(cap) && cap > 0)) throw new Error(`invalid cap: ${cap} (a number greater than zero, in $)`)
  const snap = readJury(category)
  // D2: the stored sha is the one of the recomputed block; a context edited by hand after build-context is rejected.
  const contextSha = context ? sha(contextBlock(context)) : null
  if (context && context.sha256 !== contextSha) throw new Error(`context rejected: block sha256 (${contextSha.slice(0, 12)}) differs from context.sha256 (${String(context.sha256).slice(0, 12)})`)
  // Player context: the same block for every juror; in scores mode it goes in its own section, in decision mode it opens the evidence.
  if (context) input = mode === 'scores' ? { ...input, context: contextBlock(context) }
    : mode === 'decision' ? { ...input, evidence: `${contextBlock(context)}
${input.evidence ?? ''}` } : { ...input, artifact: `${contextBlock(context)}
${input.artifact ?? ''}` }
  // Decision: the option text must not reveal the origin, and the letters are drawn with a seed; the map stays out of the packet.
  let map = null
  if (mode === 'decision') {
    const found = checkOptionsText(input.options)
    if (found.length) throw new Error(`option reveals its origin: ${found.map((a) => `${a.option} (${a.where}): ${a.problem} "${a.excerpt}"`).join('; ')}`)
    const an = anonymizeOptions(input.options, { seed: seed ?? randomBytes(8).toString('hex') })
    map = { seed: an.seed, letter_to_option: an.map }
    input = { ...input, options: an.options }
  }
  const warnings = categoryWarnings(input.categories ?? [])
  const cat = catalog ?? (await (await fetchFn(`${OPENROUTER}/models`)).json()).data
  const byId = new Map(cat.map((m) => [m.id, m]))
  const nOptions = mode === 'decision' ? input.options.length : 1
  const jury = snap.jury.map((m, i) => {
    const live = byId.get(m.model)
    const dropped = !live ? 'left the catalog' : !live.architecture?.input_modalities?.includes(category) ? `no longer accepts ${category}`
      : !live.architecture?.output_modalities?.includes('text') ? 'no longer answers in text' : null
    return { ...m, price: live ? Object.fromEntries(Object.entries(live.pricing).map(([k, v]) => [k, price(v)])) : m.price, dropped, rotation: i % nOptions }
  })
  const blocksOf = (m) => message(input, mode, m.rotation, items)
  const types = new Set(blocksOf(jury[0]).filter((b) => b.type).map((b) => b.type))
  if (!types.size) throw new Error('packet has no media attachment')
  for (const t of types) if (t !== category && !(category === 'video' && t === 'audio')) throw new Error(`${t} attachment in a ${category} round`)

  const probes = estimateOnly ? {} : await probeClaude(jury, blocksOf(jury[0]).find((b) => b.type === 'image'), fetchFn)
  // In the estimate the probe does not run: Claude counts as subscription, and the paid equivalent is reported separately.
  const plan = jury.map((m) => ({ ...m, ...(m.dropped ? { route: 'none', reason: m.dropped }
    : estimateOnly && m.proxy ? { route: 'proxy-claude', reason: 'estimate: probe did not run' } : route(m, probes, { claudeOpenrouter })) }))
  const routeWarnings = plan.filter((m) => m.route_switched || (m.proxy && m.route === 'none')).map((m) => ({ model: m.model, route: m.route, reason: m.reason }))
  const projected = plan.map((m) => (m.route === 'openrouter' ? projectedCost(m, blocksOf(m)) : 0))
  const totalProjected = projected.reduce((s, v) => s + v, 0)
  const claudeEquivalent = plan.filter((m) => m.route === 'proxy-claude').reduce((s, m) => s + projectedCost(m, blocksOf(m)), 0)
  const juryDiff = juryChanges(snap, cat, category)
  const projectedSummary = { cap_usd: cap, projected_usd: +totalProjected.toFixed(4), claude_subscription_equivalent_usd: +claudeEquivalent.toFixed(4),
    note: 'projected_usd is what is paid (OpenRouter). Claude through the proxy is subscription; if the probe fails, the juror stays out of the round; the equivalent only becomes spend with --claude-openrouter.',
    by_juror: plan.map((m, i) => ({ model: m.model, route: m.route, projected_usd: +projected[i].toFixed(4) })), jury_changes: juryDiff,
    ...(warnings.length ? { category_warnings: warnings } : {}), ...(routeWarnings.length ? { route_warnings: routeWarnings } : {}) }
  if (estimateOnly) return projectedSummary
  if (totalProjected > cap) throw new Error(`projected cost $${totalProjected.toFixed(3)} exceeds cap $${cap}: reduce the packet (fewer attachments, shorter clip) or raise the cap`)
  if (fs.existsSync(path.join(out, 'collection.json'))) throw new Error('output folder already has collection.json: use a new folder')

  let spent = 0
  let reserved = 0
  const responses = await Promise.all(plan.map(async (m, i) => {
    if (m.route === 'none') return { error: m.reason, cost_usd: 0, usage: {}, ms: 0 }
    if (spent + reserved + projected[i] > cap) return { error: 'cost cap: call not started', cost_usd: 0, usage: {}, ms: 0 }
    reserved += projected[i]
    const blocks = blocksOf(m)
    const call = () => (m.route === 'proxy-claude' ? callClaudeProxy(m, blocks, { fetchFn }) : callOpenRouter(m, blocks, { fetchFn }))
    let r = await call()
    // One resend with the same packet when the JSON came back invalid or truncated (council rule), if it fits under the cap.
    if (!r.error && validate(mode, extractJson(r.text), input, items).length && spent + r.cost_usd + reserved <= cap) {
      const firstCost = r.cost_usd
      spent += firstCost
      r = { ...(await call()), resend: true, first_call_cost_usd: firstCost }
    }
    reserved -= projected[i]
    spent += r.cost_usd
    return r
  }))

  fs.mkdirSync(path.join(out, 'responses'), { recursive: true })
  if (map) write(path.join(out, 'map.json'), map)
  const entries = plan.map((m, i) => {
    const r = responses[i]
    write(path.join(out, 'responses', `${String(i + 1).padStart(2, '0')}-${m.model.replace(/[/:]/g, '_')}.json`), { model: m.model, route: m.route, ...r })
    const review = r.error ? null : extractJson(r.text)
    const problems = r.error ? [] : validate(mode, review, input, items)
    const status = r.error ? `failed: ${r.error}` : problems.length ? `invalid: ${problems.slice(0, 3).join('; ')}${r.finish === 'length' ? ' (truncated)' : ''}` : 'valid'
    const cost = r.cost_usd + (r.first_call_cost_usd ?? 0)
    return { model: m.model, effort: m.effort ?? 'no effort control', index: m.index, estimate: m.estimate ?? null,
      admitted: status === 'valid', status, review: status === 'valid' ? review : review ?? null,
      route: m.route + (m.reason ? ` (${m.reason})` : ''), cost_usd: +cost.toFixed(6),
      cost: m.route === 'proxy-claude' ? `subscription (≈$${equivalentCost(m, r.usage).toFixed(4)} on OpenRouter)` : `$${cost.toFixed(4)}`,
      ms: r.ms, usage: r.usage, ...(r.uncertain_cost ? { uncertain_cost: true } : {}), ...(r.attempts ? { attempts: r.attempts } : {}), rotation: mode === 'decision' ? m.rotation : undefined }
  })
  const opts = { published: publishedFor(snap.benchmark.name) }
  const collection = { category, mode, benchmark: snap.benchmark, categories: input.categories ?? [], jury_changes: juryDiff, context_sha256: contextSha,
    ...(warnings.length ? { category_warnings: warnings } : {}), ...(map ? { map: 'map.json (outside the packet)' } : {}),
    ...(mode === 'decision' ? { options: input.options.map((o) => o.id) } : {}), entries, probes,
    packet_sha256: sha(JSON.stringify(message(input, mode, 0, items).map((b) => b.text ?? b.sha256))),
    closing: { ready_for_analysis: true, at: new Date().toISOString() } }
  write(path.join(out, 'collection.json'), collection)
  const totalCost = entries.reduce((s, e) => s + e.cost_usd, 0)
  const uncertain = plan.map((m, i) => (responses[i].uncertain_cost ? projected[i] : 0))
  const spendLimit = totalCost + uncertain.reduce((s, v) => s + v, 0)
  const cost = { ...projectedSummary, measured_usd: +totalCost.toFixed(6), spend_limit_usd: +spendLimit.toFixed(6),
    uncertain_costs: plan.filter((_, i) => responses[i].uncertain_cost).map((m) => m.model), within_cap: spendLimit <= cap,
    source: 'usage.cost returned by OpenRouter in each response; Claude through the proxy does not charge per call (subscription)' }
  write(path.join(out, 'cost.json'), cost)

  let result
  if (mode === 'decision') {
    result = tally(entries, collection.options, collection.categories, opts)
    result = { ...result, original_choice: map.letter_to_option[result.choice] ?? null }
  }
  else if (mode === 'vote') result = agreement(entries, items.map((i) => i.id), undefined, opts)
  else result = aggregateScores(entries, collection.categories, opts)
  if (routeWarnings.length) result = { ...result, route_warnings: routeWarnings }
  write(path.join(out, mode === 'decision' ? 'decision.json' : mode === 'vote' ? 'agreement.json' : 'scores.json'), result)

  const html = renderTable({ round: `curation ${category} · ${mode} · ${path.basename(out)}`, entries, options: collection.options }, {
    published: opts.published, indexLabel: snap.benchmark.name,
    note: `Weight: published score on ${snap.benchmark.name} (${snap.benchmark.version}); without it, a floor of half the lowest weight in the round. Medium effort where the model advertises effort control. Cost: usage.cost from OpenRouter; Claude through the proxy is subscription (equivalent shown). Failures and off-format answers are listed, with no zero score and no substitute. Cap $${cap}; measured $${totalCost.toFixed(4)}.`,
    extras: [{ key: 'route', label: 'Route' }, { key: 'cost', label: 'Cost' }] })
  write(path.join(out, 'table.html'), html)
  return { result, cost, valid: entries.filter((e) => e.admitted).length, planned: entries.length }
}

// ---------- CLI ----------

function flags(args) {
  const f = {}
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error(`unexpected argument: ${args[i]}`)
    if (['--current-claude', '--estimate-only', '--claude-openrouter'].includes(args[i])) { f[args[i].slice(2)] = true; continue }
    f[args[i].slice(2)] = args[++i]
  }
  return f
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const f = flags(rest)
  if (cmd === 'jury') {
    const s = readJury(f.category)
    console.log(JSON.stringify({ category: s.category, built_at: s.built_at, benchmark: s.benchmark.name,
      jury: s.jury.map((m) => ({ model: m.model, score: m.index?.value ?? null, effort: m.effort_note, origin: m.origin,
        price_per_M: `${(m.price.prompt * 1e6).toFixed(2)}/${(m.price.completion * 1e6).toFixed(2)}` })), shortfalls: s.shortfalls }, null, 1))
  } else if (cmd === 'build-jury') {
    const cat = (await (await fetch(`${OPENROUTER}/models`)).json()).data
    const s = buildJury(cat, read(f.scores), f.category, { currentClaude: Boolean(f['current-claude']) })
    write(juryPath(f.category), s)
    console.log(JSON.stringify({ written: juryPath(f.category), jury: s.jury.map((m) => m.model), shortfalls: s.shortfalls }, null, 1))
  } else if (cmd === 'run') {
    for (const k of ['category', 'input', 'out', 'cap']) if (!f[k] && !(k === 'out' && f['estimate-only'])) throw new Error(`--${k} is required`)
    if (!keyOpenRouter() && !f['estimate-only']) throw new Error('OPENROUTER_API_KEY is missing from the environment')
    const r = await run({ category: f.category, input: read(f.input), out: f.out && path.resolve(f.out), cap: Number(f.cap),
      mode: f.mode ?? 'decision', items: f.items ? read(f.items) : null, estimateOnly: Boolean(f['estimate-only']),
      context: f.context ? read(f.context) : null, seed: f.seed ?? null, claudeOpenrouter: Boolean(f['claude-openrouter']) })
    console.log(JSON.stringify(r, null, 1))
  } else if (cmd === 'build-context') {
    for (const k of ['target', 'root', 'out']) if (!f[k]) throw new Error(`--${k} is required`)
    const c = buildContext(read(f.target), { gameRoot: path.resolve(f.root) })
    write(path.resolve(f.out), c)
    // The block is the text the jurors and the recommender read; the context's sha is the block's.
    const block = path.resolve(f.out).replace(/.json$/i, '') + '.block.txt'
    write(block, contextBlock(c))
    console.log(JSON.stringify({ written: path.resolve(f.out), block, sha256: c.sha256, fields: Object.keys(c.fields) }, null, 1))
  } else {
    console.error('Usage: curation.mjs jury|build-jury|run|build-context (see SKILL.md; generation is in generation.mjs, prompt and loop in prompt.mjs)')
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.message); process.exit(1) })
}
