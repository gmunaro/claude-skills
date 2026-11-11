#!/usr/bin/env node
// Council on T3: builds the delegation plan (free models through OpenCode and Claude through claudeAgent),
// records the returned taskIds and lists what is still left to dispatch. Node 24+, no dependencies.
//
//   node council-t3.mjs prepare --thread ID --prompt packet.txt --output new-dir [options]
//   node council-t3.mjs pending --plan dir/plan-t3.json [--group claude|free] [--max N]
//   node council-t3.mjs register --plan dir/plan-t3.json --id clientRequestId (--task taskId | --error msg | --failure notification-text)
//   node council-t3.mjs register --plan dir/plan-t3.json --batch results.json
//   node council-t3.mjs collect --plan dir/plan-t3.json --categories a,b,c [--round N]
//   node council-t3.mjs vote-packet --items items.json --artifact current.txt --out packet.txt
//   node council-t3.mjs collect --plan voting/plan-t3.json --items items.json
//   node council-t3.mjs agreement --plan voting/plan-t3.json --items items.json [--threshold 7]
//   node council-t3.mjs decision-packet --input decision-input.json --out packet.txt   (writes one rotation per option)
//   node council-t3.mjs collect --plan decision/plan-t3.json --options A,B --categories a,b   (then: tally.mjs)
//   node council-t3.mjs cycle --plan dir/plan-t3.json (same flags as collect)      (collect + pending)
//   node council-t3.mjs close --plan dir/plan-t3.json (same flags as collect)      (closes before the deadline)
//   node council-t3.mjs history [--collections a/collection.json,b/collection.json]  (reliability of the free models)
//   node council-t3.mjs pool [--force]                                             (the day's free pool: who joined/left)
//
// The script does not call delegate_task: that tool only exists for the orchestrator. It writes the frozen
// plan, and the orchestrator runs `pending`, dispatches in parallel and returns the IDs with `register`.
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { weights } from './weights.mjs'
import { quorumByAnswer } from './tally.mjs'

export const MARKER = '[COUNCIL_FREE_ONLY]'
export const PROXY = 'http://127.0.0.1:8317/v1'
// Default Claude lineup, set by the owner on 2026-11-06: no Fable and no Opus high.
export const CLAUDE_DEFAULT = [
  { model: 'claude-haiku-5-5', efforts: ['low', 'medium', 'high'] },
  { model: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high'] },
  { model: 'claude-opus-5-5', efforts: ['low', 'medium'] },
]
export const AGREEMENT_THRESHOLD = 7
const PHASES = ['review', 'definition', 'problem', 'vote', 'decision']
const SNAPSHOT_MAX_MS = 24 * 3600 * 1000
/** Fixed deadline of each participant, counted from the start of the task (or the first dispatch attempt). */
export const DEADLINE_MS = 10 * 60 * 1000
/** Time cap of one `collect` call; whatever is not read within it stays as it was. */
export const COLLECT_BUDGET_MS = 2 * 60 * 1000
/** Dispatch error that proves the model was never eligible on T3 (wrong inventory, not a voter failure). */
export const UNAVAILABLE = /model_unavailable|not advertised by provider/i
/** Rate-limit failure: the participant gets a single resend, within the same deadline. */
export const RATE_LIMIT = /\b429\b|rate-?limited|cooling down|Retry-After/i
/** Minimum wait before resending after a 429, when the text carries no Retry-After. */
export const RESEND_WAIT_MS = 60 * 1000
const AWAITING_RESEND = 'awaiting resend'
// Reliability: a free model with at least 3 attempts in the last 14 days and fewer than 1/3 valid reviews
// is left out of the lineup. After 14 days without an attempt, it comes back on its own.
export const RELIABILITY = { windowDays: 14, minAttempts: 3, minRate: 1 / 3 }
const HISTORY_FILE = () => path.join(os.homedir(), '.cache/council/history.json')
const POOL_FILE = () => path.join(os.homedir(), '.cache/council/free-pool.json')
const POOL_CHANGES_MAX = 60

const sha = (value) => createHash('sha256').update(value).digest('hex')
const zero = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== ''))
  && Number.isFinite(Number(v)) && Number(v) === 0

/**
 * Free pairs: all prices zero, present on the proxy, text chat and a fixed identity.
 * `image: true` (packet with images) also requires image input in the catalog.
 */
export function freeJobs(catalog, proxyIds, variants = {}, { image = false } = {}) {
  const proxied = new Set(proxyIds)
  const jobs = []
  const excluded = []
  for (const m of catalog) {
    if (!m.pricing || !zero(m.pricing.prompt) || !zero(m.pricing.completion)
      || Object.values(m.pricing).some((p) => !zero(p))) continue
    let reason
    if (!proxied.has(m.id)) reason = 'absent_from_proxy'
    else if (!m.architecture?.input_modalities?.includes('text') || !m.architecture?.output_modalities?.includes('text')) reason = 'no_text_chat'
    else if (image && !m.architecture?.input_modalities?.includes('image')) reason = 'no_image_input'
    else if (m.id === 'openrouter/free' || m.id === 'openrouter/auto') reason = 'alias_without_fixed_identity'
    else if (/content-safety|\/lyria-/.test(m.id)) reason = 'classifier_or_music_generator'
    if (reason) { excluded.push({ model: m.id, reason }); continue }
    const levels = Object.entries(variants[m.id] ?? {}).filter(([, v]) => !v?.disabled).map(([e]) => e)
    for (const effort of levels.length ? levels : ['default']) jobs.push({ group: 'free', model: m.id, effort })
  }
  return { jobs, excluded }
}

/**
 * Daily refresh of the free pool. `models` are the IDs eligible right now (freeJobs, before the
 * history cut). With a snapshot under 24 h old and no `force`, returns the previous one unchanged.
 * Otherwise writes the new one and, if the list changed, appends { at, entered, left } to `changes`.
 */
export function refreshPool(previous, models, now = Date.now(), force = false) {
  const age = previous ? now - Date.parse(previous.queried_at) : Infinity
  if (!force && age >= 0 && age < SNAPSHOT_MAX_MS) return { updated: false, pool: previous, change: null }
  const current = [...new Set(models)].sort()
  const before = new Set(previous?.models ?? [])
  const nowSet = new Set(current)
  const change = previous ? { at: new Date(now).toISOString(),
    entered: current.filter((m) => !before.has(m)), left: [...before].filter((m) => !nowSet.has(m)).sort() } : null
  const changed = change && (change.entered.length || change.left.length)
  const changes = [...(previous?.changes ?? []), ...(changed ? [change] : [])].slice(-POOL_CHANGES_MAX)
  return { updated: true, pool: { queried_at: new Date(now).toISOString(), models: current, changes }, change: changed ? change : null }
}

/** Reads the catalog and the proxy, refreshes the pool if older than 24 h (or with force) and returns the summary. */
function updateFreePool(catalog, proxyIds, force = false) {
  const file = POOL_FILE()
  const r = refreshPool(readJsonIf(file), freeJobs(catalog, proxyIds).jobs.map((j) => j.model), Date.now(), force)
  if (r.updated) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(r.pool, null, 1))
  }
  const last = r.pool.changes.at(-1) ?? null
  return { file, updated_now: r.updated, queried_at: r.pool.queried_at, models: r.pool.models.length,
    entered: r.change?.entered ?? [], left: r.change?.left ?? [], last_change: last }
}

/** "default", "none" or "claude-opus-5-5:low,high;claude-haiku-5-5:medium". */
export function parseClaude(spec = 'default') {
  if (spec === 'none') return []
  const entries = spec === 'default' ? CLAUDE_DEFAULT : spec.split(';').filter(Boolean).map((part) => {
    const [model, efforts = 'medium'] = part.split(':')
    return { model: model.trim(), efforts: efforts.split(',').map((e) => e.trim()).filter(Boolean) }
  })
  const jobs = entries.flatMap(({ model, efforts }) => {
    if (!/^claude-[a-z0-9-]+$/.test(model)) throw new Error(`Invalid Claude model: ${model}`)
    return efforts.map((effort) => {
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`Invalid effort: ${model}/${effort}`)
      return { group: 'claude', model, effort }
    })
  })
  if (new Set(jobs.map((j) => `${j.model}/${j.effort}`)).size !== jobs.length) throw new Error('Duplicate Claude pair')
  return jobs
}

/**
 * Artificial Analysis index by exact identity. Claude: slug `<model>-<effort>` (measured per effort).
 * Free: verified mapping by `[model, effort]` or by model ID (base index reused).
 */
export function indexFor(job, snapshot, aliases = {}) {
  if (!snapshot?.models) return null
  const bySlug = (slug) => snapshot.models.find((m) => m.slug === slug)
  const byId = (id) => snapshot.models.find((m) => m.aa_id === id)
  let hit
  let config
  if (job.group === 'claude') {
    hit = bySlug(`${job.model}-${job.effort}`)
    config = hit?.evaluated_config
  } else {
    const alias = aliases[JSON.stringify([job.model, job.effort])] ?? aliases[job.model]
    hit = alias && byId(alias.aa_id)
    config = alias?.evaluated_config
  }
  if (!hit || typeof hit.value !== 'number') return null
  return { value: hit.value, aa_id: hit.aa_id, name: hit.name, source: hit.source, evaluated_config: config,
    scale: snapshot.scale, version: snapshot.version, queried_at: snapshot.queried_at }
}

/**
 * Estimated index from another benchmark, for models without a published index. File
 * ~/.cache/council/estimated-indices.json, key `[model, effort]` as JSON or the model ID.
 */
export function estimateFor(job, estimates = {}) {
  return estimates[JSON.stringify([job.model, job.effort])] ?? estimates[job.model] ?? null
}

const TASK_BY_PHASE = {
  decision: ['decision packet', 'It contains the question, the options, the evidence and the response format.', 'Decide'],
  vote: ['vote packet', 'It contains the artifact, the suggested fixes and the response format.', 'Vote'],
}

/** Same task for every voter in the phase; only the packet path changes between rotations. */
export function taskText(packetPath, group, phase = 'review') {
  const [name, content, verb] = TASK_BY_PHASE[phase]
    ?? ['evaluation packet', 'It contains all the contract, code and rubric needed.', 'Evaluate']
  const body = `Read only the ${name} at ${JSON.stringify(packetPath)} with the read tool. ${content} Do not open other files, do not search, do not run commands, do not edit and do not create subagents. ${verb} based exclusively on the packet and return only the JSON it requires. Work alone.`
  // The marker turns on OpenCode's free-only protection; Claude does not go through it.
  return group === 'free' ? `${MARKER}\n${body}` : body
}

/**
 * Frozen plan. The clientRequestId depends on thread, packet, task, model and effort.
 * `packets` ([{ path, prompt }]) distributes the packet rotations round-robin in call order.
 */
export function buildPlan({ jobs, runtimeModels, packetPath, prompt, packets, threadId, label = 'Council', phase = 'review',
  snapshot = null, aliases = {}, estimates = {}, controllerContext = {}, excluded = [] }) {
  if (typeof threadId !== 'string' || !/^[a-zA-Z0-9_:%.-]+$/.test(threadId)) throw new Error('Invalid thread ID')
  const allPackets = packets ?? [{ path: packetPath, prompt }]
  if (!allPackets.length || allPackets.some((p) => !p.prompt?.trim())) throw new Error('Empty packet')
  if (!PHASES.includes(phase)) throw new Error('Invalid phase')
  const available = new Set(runtimeModels)
  const out = [...excluded]
  const calls = []
  for (const j of jobs) {
    if (j.group === 'free' && !available.has(j.model)) {
      out.push({ model: j.model, effort: j.effort, reason: 'absent_from_T3_OpenCode_catalog' }); continue
    }
    const packet = calls.length % allPackets.length
    const { path: packetFile, prompt: content } = allPackets[packet]
    const task = taskText(packetFile, j.group, phase)
    const clientRequestId = `council-${sha(`${threadId}\0${sha(content)}\0${task}\0${j.model}\0${j.effort}`).slice(0, 40)}`
    const target = j.group === 'claude'
      ? { providerInstanceId: 'claudeAgent', model: j.model, options: { effort: j.effort } }
      : { providerInstanceId: 'opencode', model: `openrouter/${j.model}`,
        options: { agent: 'plan', ...(j.effort === 'default' ? {} : { variant: j.effort }) } }
    const index = indexFor(j, snapshot, aliases)
    calls.push({ group: j.group, model: j.model, effort: j.effort, packet, index, estimate: index ? null : estimateFor(j, estimates),
      parameters: { task, title: `${label}: ${j.model} / ${j.effort}`, role: 'review', mode: 'async', clientRequestId, target } })
  }
  if (!calls.length) throw new Error('No eligible participant')
  if (new Set(calls.map((c) => c.parameters.clientRequestId)).size !== calls.length) throw new Error('Duplicate clientRequestId')
  return { version: 3, thread_id: threadId, phase, prompt_sha256: sha(allPackets[0].prompt), packet_path: allPackets[0].path,
    packets: allPackets.map((p) => ({ path: p.path, sha256: sha(p.prompt), content: p.prompt })), controller_context: controllerContext, excluded: out, calls }
}

const TERMINAL = (st = '') => st === 'valid' || st === 'timeout' || st.startsWith('invalid') || st.startsWith('failed')
  || st.startsWith('canceled') || st.startsWith('not dispatched:')
const ROUND_CLOSED = 'round closed'
const baseId = (id) => id.replace(/-r1$/, '')

/**
 * Calls to dispatch now. A transport failure stays pending with the same clientRequestId.
 * A model unavailable on T3 leaves the list. A 429 marked by `collect` comes back once, with the `-r1` suffix
 * (another clientRequestId, because T3 would return the old task), after the wait.
 * Free models go in waves: at most one call in flight per model, because efforts of the same model
 * in parallel exhaust the provider's per-minute limit. `collection` is the latest collection.json, if any.
 */
export function pending(plan, dispatches = {}, collection = null, now = Date.now()) {
  if (collection?.closed_at) return []
  const state = new Map((collection?.entries ?? []).map((e) => [e.clientRequestId, e]))
  const inFlight = new Set()
  const candidates = []
  for (const c of plan.calls) {
    const id = c.parameters.clientRequestId
    const d = dispatches[id]
    const e = state.get(id)
    if (d?.unavailable && !d.taskId) continue
    if (!d?.taskId) { candidates.push(c); continue }
    if (e?.status?.startsWith(AWAITING_RESEND) && !d.resent) {
      if (now >= Date.parse(e.resend_after ?? 0)) candidates.push({ ...c, parameters: { ...c.parameters, clientRequestId: `${id}-r1` } })
      else inFlight.add(c.model)
      continue
    }
    if (!TERMINAL(e?.status)) inFlight.add(c.model)
  }
  const out = []
  for (const c of candidates) {
    if (c.group === 'free') {
      if (inFlight.has(c.model)) continue
      inFlight.add(c.model)
    }
    out.push(c)
  }
  return out
}

/**
 * Records what the orchestrator received: the `taskId` of a dispatch, the `error` of a dispatch without a task,
 * or `failure` (notification text of a task that failed; the T3 CLI does not keep that text).
 * The ID `<id>-r1` records the single resend after a 429.
 */
export function record(plan, dispatches, entries, now = new Date().toISOString()) {
  const known = new Set(plan.calls.map((c) => c.parameters.clientRequestId))
  const next = { ...dispatches }
  for (const e of entries) {
    const id = baseId(e.clientRequestId)
    const resend = id !== e.clientRequestId
    if (!known.has(id)) throw new Error(`clientRequestId outside the plan: ${e.clientRequestId}`)
    if (['taskId', 'error', 'failure'].filter((k) => e[k]).length !== 1) throw new Error('Provide exactly one of taskId, error or failure')
    const prev = next[id] ?? { attempts: [] }
    if (prev.taskId && e.taskId && prev.taskId !== e.taskId && !resend) throw new Error(`taskId mismatch for ${e.clientRequestId}`)
    if (resend && e.taskId && prev.resent && prev.taskId !== e.taskId) throw new Error(`resend already recorded for ${id}`)
    if (e.failure && !prev.taskId) throw new Error(`failure without a recorded taskId: ${id}`)
    const attempt = { at: now, ...(resend ? { resend: true } : {}),
      ...(e.taskId ? { taskId: e.taskId } : e.error ? { error: e.error } : { failure: e.failure, taskId: prev.taskId }) }
    next[id] = { ...prev,
      ...(e.taskId ? { taskId: e.taskId, ...(resend ? { resent: true } : {}) } : {}),
      ...(e.error && !prev.taskId && UNAVAILABLE.test(e.error) ? { unavailable: e.error } : {}),
      ...(e.failure ? { failure: { taskId: prev.taskId, text: e.failure, at: now } } : {}),
      attempts: [...prev.attempts, attempt] }
  }
  return next
}

const NO_CONTENT = /^\s*(null|none|undefined|nil|n\/?a|-+|\.+)\s*$/i
/** Text with content: rejects empty and markers such as "null", "none", "n/a" or "-". */
const hasText = (v) => typeof v === 'string' && v.trim().length > 0 && !NO_CONTENT.test(v)

/** Extracts the first JSON object from a response (accepts Markdown fences and surrounding text). */
export function extractJson(text) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)) } catch { return null }
    }
  }
  return null
}

/** Validates a review against the packet format. Returns the list of problems (empty = valid). */
export function validateReview(review, categories) {
  const problems = []
  const grade = (v) => Number.isFinite(v) && v >= 1 && v <= 10
  if (!review || typeof review !== 'object') return ['no JSON']
  if (!grade(review.overall_score)) problems.push('overall_score outside 1-10')
  const scores = Array.isArray(review.scores) ? review.scores : []
  const got = scores.map((n) => n?.category)
  for (const c of categories) if (!got.includes(c)) problems.push(`category missing: ${c}`)
  if (scores.length !== categories.length) problems.push(`expected ${categories.length} categories, got ${scores.length}`)
  for (const n of scores) {
    if (!grade(n?.score)) problems.push(`invalid score in ${n?.category}`)
    if (!hasText(n?.gap)) problems.push(`empty gap in ${n?.category}`)
    else if (/^\s*nothing\s*\.?\s*$/i.test(n.gap) && n.score !== 10) problems.push(`"nothing" with score ${n.score} in ${n.category}`)
  }
  if (!Array.isArray(review.fix_points)) problems.push('fix_points missing')
  return problems
}

/** Validates an agreement vote: each item exactly once, integer score 1-10 and a reason. */
export function validateVotes(review, ids) {
  if (!review || typeof review !== 'object') return ['no JSON']
  const votes = Array.isArray(review.votes) ? review.votes : []
  const problems = []
  const seen = votes.map((v) => v?.id)
  for (const id of ids) {
    const n = seen.filter((s) => s === id).length
    if (n === 0) problems.push(`item missing: ${id}`)
    else if (n > 1) problems.push(`item repeated: ${id}`)
  }
  for (const v of votes) {
    if (!ids.includes(v?.id)) problems.push(`item not in list: ${v?.id}`)
    if (!Number.isInteger(v?.agreement) || v.agreement < 1 || v.agreement > 10) problems.push(`invalid agreement in ${v?.id}`)
    if (!hasText(v?.reason)) problems.push(`empty reason in ${v?.id}`)
  }
  return problems
}


/** Validates a decision council vote: an option or X, confidence, reasons and a 1-10 score per option x category. */
export function validateDecision(review, options, categories) {
  if (!review || typeof review !== 'object') return ['no JSON']
  const problems = []
  if (![...options, 'X'].includes(review.vote)) problems.push(`vote outside options: ${review.vote}`)
  if (!['low', 'medium', 'high'].includes(review.confidence)) problems.push('confidence must be low, medium or high')
  if (!Array.isArray(review.reasons) || !review.reasons.length || !review.reasons.every(hasText)) problems.push('empty reasons')
  if (!hasText(review.what_would_change_my_vote)) problems.push('what_would_change_my_vote empty')
  if (review.vote === 'X' && !hasText(review.missing)) problems.push('vote X without missing')
  const scores = Array.isArray(review.scores) ? review.scores : []
  if (scores.length !== options.length * categories.length) problems.push(`expected ${options.length * categories.length} scores, got ${scores.length}`)
  for (const o of options) for (const c of categories) {
    const found = scores.filter((n) => n?.option === o && n?.category === c)
    const n = found[0]
    if (found.length !== 1) problems.push(`score missing or repeated: ${o}/${c}`)
    else if (!Number.isInteger(n.score) || n.score < 1 || n.score > 10) problems.push(`invalid score in ${o}/${c}`)
    else if (!hasText(n.gap)) problems.push(`empty gap in ${o}/${c}`)
    else if (/^\s*nothing\s*\.?\s*$/i.test(n.gap) && n.score !== 10) problems.push(`"nothing" with score ${n.score} in ${o}/${c}`)
  }
  return problems
}

/**
 * Decision council packet. input = { question, options: [{ id, text }], categories, evidence, mode }.
 * Neutral anchors; no cutoff, count, lineup or conductor preference. `quick` asks for a short review.
 */
export function decisionPacket({ question, options, categories, evidence, mode = 'quick' }, rotation = 0) {
  if (!hasText(question)) throw new Error('empty question')
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) throw new Error('2 to 4 options')
  const ids = options.map((o) => o.id)
  if (ids.includes('X') || new Set(ids).size !== ids.length || !options.every((o) => hasText(o.id) && hasText(o.text))) throw new Error('invalid options')
  if (!Array.isArray(categories) || !categories.length || !categories.every(hasText)) throw new Error('empty categories')
  if (!hasText(evidence)) throw new Error('empty evidence')
  if (!['quick', 'full'].includes(mode)) throw new Error('mode must be quick or full')
  const size = mode === 'quick'
    ? 'Be brief: up to 2 one-sentence reasons and `gap` with up to 20 words.'
    : 'Justify in detail: reasons citing the passage of the evidence and `gap` with what prevents a higher score.'
  // Rotation: the same list starting at another option, so the first position is not always favored.
  const order = options.map((_, i) => options[(i + rotation) % options.length])
  const example = { vote: order[0].id, confidence: 'medium', reasons: ['fact from the evidence that supports the choice'],
    what_would_change_my_vote: 'evidence that would flip the choice',
    scores: order.flatMap((o) => categories.map((category) => ({ option: o.id, category, score: 7, gap: 'what prevents a higher score' }))) }
  return `# Decision\n\n${question}\n\n## Options\n\n${order.map((o) => `- **${o.id}**: ${o.text}`).join('\n')}\n\n## Evidence\n\n${evidence}\n\n## How to respond\n\nChoose the option best supported by the evidence. If a fact is missing without which you cannot choose, vote \`X\` and say in \`missing\` what it is. Give an integer score from 1 to 10 to each option in each category (${categories.join(', ')}): 1 = inadequate, 5 = acceptable with caveats, 10 = the best possible with what exists. In \`gap\`, write what prevents a higher score; \`nothing\` only with 10. ${size}\n\nRespond only with JSON in this format, with one score per option and category (${options.length * categories.length} total):\n${JSON.stringify(example)}\n`
}

/**
 * Vote packet: the current artifact and the suggested fixes, anonymous and without the conductor's opinion.
 * items = [{ id, section?, problem, fix }].
 */
export function votePacket(items, artifact) {
  if (!items.length) throw new Error('No items to vote on')
  if (new Set(items.map((i) => i.id)).size !== items.length) throw new Error('Duplicate item ID')
  const list = items.map((i) => `### ${i.id}${i.section ? ` (${i.section})` : ''}\nProblem: ${i.problem}\nProposed fix: ${i.fix}`).join('\n\n')
  return `# Vote on fixes\n\nYou receive an artifact and a list of fixes suggested by anonymous reviewers. For each item, say how much you agree that the fix should be applied to this artifact: 1 = disagree (false premise, makes it worse or out of scope), 5 = neutral or unsure, 10 = fully agree (real defect and adequate fix). Judge each item by the artifact, not by the number of items. Do not propose new items.\n\nRespond only with JSON in this format, with all IDs exactly once:\n{"votes":[{"id":"${items[0].id}","agreement":7,"reason":"short text quoting the passage"}]}\n\n## Artifact\n\n${artifact}\n\n## Suggested fixes\n\n${list}\n`
}

/**
 * Agreement per item: mean weighted by the weight of each valid vote (published, estimated or floor; see weights.mjs).
 * An item is applicable only with a mean ≥ threshold (7 to 10) and only if the vote has quorum.
 * Without quorum, the vote is advisory: each item gets `decision: conductor_decides` and the indication of the
 * mean (favorable ≥ threshold, unfavorable below); the conductor decides item by item and records the reason.
 */
export function agreement(entries, ids, threshold = AGREEMENT_THRESHOLD, opts = {}) {
  const w = weights(entries, opts)
  const adm = entries.map((e, i) => ({ e, ...w[i] })).filter((x) => x.e.admitted)
  const total = adm.reduce((s, x) => s + x.weight, 0)
  const { quorum } = quorumByAnswer(entries.map((e, i) => ({ e, ...w[i] })))
  const items = ids.map((id) => {
    const mean = total ? adm.reduce((s, x) => s + x.e.review.votes.find((v) => v.id === id).agreement * x.weight, 0) / total : null
    const byType = Object.fromEntries(['published', 'estimated', 'floor'].map((t) => [t, adm.filter((x) => x.type === t).length]))
    const favorable = mean !== null && mean >= threshold
    return { id, agreement: mean === null ? null : +mean.toFixed(2), votes_by_type: byType,
      indication: mean === null ? null : favorable ? 'favorable' : 'unfavorable',
      decision: !quorum.ok ? 'conductor_decides' : favorable ? 'apply' : 'reject' }
  })
  return { threshold, quorum, items }
}

/**
 * Collection window of the round. Analysis only starts when everyone has answered or the deadline passed.
 * Each participant's deadline = start + 10 minutes, always. Anyone not yet dispatched counts from the
 * first dispatch attempt (or the plan's creation), so a failed dispatch also expires.
 * Resending after a 429 does not reopen the deadline: the start of the first task counts.
 * Marks as `timeout` (failure, outside the quorum denominator) anyone past the deadline. Mutates entries.
 */
export function closeWindow(entries, now, deadlineMs = DEADLINE_MS, closedAt = null) {
  const waiting = (e) => e.status === 'pending' || e.status === 'not dispatched' || e.status.startsWith(AWAITING_RESEND)
  for (const e of entries) {
    if (!waiting(e) || (closedAt && e.unread)) continue
    // A 429 that missed its turn to resend is still a 429: the cause arrived, there just was no time.
    const cause = e.status.startsWith(AWAITING_RESEND) ? e.status.slice(AWAITING_RESEND.length).replace(/^:\s*/, '') : null
    if (e.start && now - Date.parse(e.start) > deadlineMs) e.status = cause ? `failed: ${cause}` : 'timeout'
    else if (closedAt) e.status = cause ? `failed: ${cause}` : e.taskId ? `canceled: ${ROUND_CLOSED}` : `not dispatched: ${ROUND_CLOSED}`
  }
  const stillWaiting = entries.filter(waiting)
  const deadlines = stillWaiting.filter((e) => e.start).map((e) => Date.parse(e.start) + deadlineMs)
  return {
    ready_for_analysis: stillWaiting.length === 0,
    ...(closedAt ? { closed_at: closedAt } : {}),
    timeout_s: Math.round(deadlineMs / 1000),
    base_timeout: '10 min fixed per participant',
    waiting: stillWaiting.length,
    next_deadline: deadlines.length ? new Date(Math.max(...deadlines)).toISOString() : null,
  }
}

function lastAssistantText(messages = []) {
  const m = [...messages].reverse().find((x) => x.role === 'assistant' && typeof (x.text ?? x.content) === 'string')
  return m ? (m.text ?? m.content) : null
}

/** Seconds of Retry-After cited in the error text, in ms; null if there is none. */
export function retryAfterMs(text = '') {
  const m = /Retry-After\D{0,3}(\d+)/i.exec(text)
  return m ? Number(m[1]) * 1000 : null
}

/**
 * State of a participant from what the T3 CLI showed of the current task.
 * The text of a task that failed comes from the notification, recorded with `register --failure`,
 * because the CLI does not keep the error. A 429 without a resend still becomes `awaiting resend`.
 * `prev` is the entry from the previous collection: the participant's start is the first task's.
 */
export function entryFrom(base, dispatch, shown, validate, prev = null, now = Date.now()) {
  const state = shown.thread?.status
  const entry = { ...base, taskId: dispatch.taskId, start: prev?.start ?? shown.thread?.createdAt }
  if (state === 'completed' || state === 'failed') entry.end = shown.thread?.updatedAt
  const text = lastAssistantText(shown.messages)
  if (state === 'completed') {
    const review = extractJson(text)
    const problems = validate(review)
    return { text, entry: { ...entry, review: review ?? undefined, problems,
      status: problems.length ? `invalid: ${problems.slice(0, 3).join('; ')}` : 'valid', admitted: problems.length === 0 } }
  }
  if (state !== 'failed') return { text, entry: { ...entry, status: 'pending', admitted: false } }
  const failure = text ?? (dispatch.failure?.taskId === dispatch.taskId ? dispatch.failure.text : null)
  if (failure && RATE_LIMIT.test(failure) && !dispatch.resent) {
    const since = Date.parse(entry.end ?? '') || now
    return { text, entry: { ...entry, status: `${AWAITING_RESEND}: ${failure.slice(0, 140)}`, admitted: false,
      resend_after: new Date(since + (retryAfterMs(failure) ?? RESEND_WAIT_MS)).toISOString() } }
  }
  return { text, entry: { ...entry, admitted: false,
    status: `failed: ${(failure ?? 'no message; record the notification text with register --failure').slice(0, 160)}` } }
}

/**
 * Clock of anyone not yet dispatched. With waves, a free model waits for its own model's turn:
 * while another call of the same model is in flight it has no clock (`start: null`); when the
 * last one finishes or expires, its 10 minutes start there. Claude and the first of each model count
 * from the first dispatch attempt or the plan's creation. Mutates entries.
 */
export function queueClock(entries, createdAt, deadlineMs = DEADLINE_MS) {
  for (const e of entries) {
    if (e.status !== 'not dispatched' || e.attempted) continue
    const siblings = e.group === 'free' ? entries.filter((x) => x !== e && x.model === e.model && x.taskId) : []
    if (siblings.some((x) => !TERMINAL(x.status))) { e.start = null; continue }
    const ends = siblings.map((x) => Date.parse(x.end ?? '') || Date.parse(x.start ?? '') + deadlineMs).filter(Number.isFinite)
    e.start = new Date(Math.max(Date.parse(createdAt), ...ends)).toISOString()
  }
  return entries
}

/**
 * Checks each plan packet by SHA-256. A changed packet (a participant edited the file)
 * is restored with the plan's content and becomes a recorded change. `io` = { read(p) -> text|null,
 * mtime(p) -> ms|null, write(p, text) }. Returns the changes found in this cycle.
 */
export function checkPackets(packets = [], io, now = Date.now()) {
  const changes = []
  for (const p of packets) {
    const current = io.read(p.path)
    if (current !== null && sha(current) === p.sha256) continue
    const changedAt = io.mtime(p.path) ?? now // before restoring: the restore changes the mtime
    const restored = typeof p.content === 'string' && sha(p.content) === p.sha256
    if (restored) io.write(p.path, p.content)
    changes.push({ path: p.path, sha256_found: current === null ? null : sha(current),
      changed_at: new Date(changedAt).toISOString(), detected_at: new Date(now).toISOString(), restored,
      ...(current === null ? {} : { changed_content: current.slice(0, 4000) }) })
  }
  return changes
}

/**
 * Marks as suspect anyone who used a changed packet and finished after the change, having started
 * before the restore: they may have read another participant's text. The vote still counts; the
 * mark stays in the collection and in the table for the conductor to judge. `packets` = plan.packets. Mutates entries.
 */
export function markSuspects(entries, packets = [], changes = [], now = Date.now()) {
  for (const a of changes) {
    const k = packets.findIndex((p) => p.path === a.path)
    for (const e of entries) {
      if (e.packet !== k || !e.taskId || !e.start) continue
      const end = Date.parse(e.end ?? '') || now
      if (end >= Date.parse(a.changed_at) && Date.parse(e.start) <= Date.parse(a.detected_at)) {
        e.suspect = `${path.basename(a.path)} changed at ${a.changed_at}, restored at ${a.detected_at}`
      }
    }
  }
  return entries
}

/**
 * Summary of a round for the history: per model, attempts that reached an end (valid,
 * invalid, failed, timeout) and how many were valid. Canceled and not dispatched do not count.
 */
export function roundSummary(entries) {
  const models = {}
  for (const e of entries) {
    const st = e.status ?? ''
    if (!e.taskId || !(st === 'valid' || st === 'timeout' || st.startsWith('invalid') || st.startsWith('failed'))) continue
    const m = (models[e.model] ??= { group: e.group, attempts: 0, valid: 0 })
    m.attempts++
    if (e.admitted) m.valid++
  }
  return models
}

/**
 * Reliability per model from the history ({ rounds: { id: { at, models } } }), only with
 * rounds inside the window. `exclude` applies to free models only; Claude never leaves because of history.
 */
export function reliability(hist, now = Date.now(), cfg = RELIABILITY) {
  const out = {}
  for (const r of Object.values(hist?.rounds ?? {})) {
    if (now - Date.parse(r.at) > cfg.windowDays * 86400000) continue
    for (const [model, x] of Object.entries(r.models)) {
      const o = (out[model] ??= { group: x.group, attempts: 0, valid: 0 })
      o.attempts += x.attempts
      o.valid += x.valid
    }
  }
  for (const o of Object.values(out)) {
    o.rate = o.attempts ? o.valid / o.attempts : null
    o.exclude = o.group === 'free' && o.attempts >= cfg.minAttempts && o.rate < cfg.minRate
  }
  return out
}

/** Identity of the round in the history: the frozen plan's calls. */
const roundId = (plan) => sha(plan.calls.map((c) => c.parameters.clientRequestId).join())

/** Writes the round to the history (idempotent: the same plan overwrites its own entry). */
function writeHistory(id, at, entries) {
  const file = HISTORY_FILE()
  const hist = readJsonIf(file) ?? { rounds: {} }
  hist.rounds[id] = { at, models: roundSummary(entries) }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(hist, null, 1))
}

export function dispatchMessage(planPath, digest, count, phase = 'review') {
  // The free-only marker belongs to the OpenCode children and never goes in the orchestrator's message.
  return `Automatic council dispatch requested by the owner. Use this same thread as the parent of the subagents.\nLocal plan: ${JSON.stringify(planPath)}\nPlan SHA-256: ${digest}\nThere are ${count} delegate_task calls. Run \`node council-t3.mjs pending --plan <plan>\`, execute the listed calls in parallel with identical parameters and register each taskId or error with \`register\`. On each notification, record the failure with \`register --failure\` when there is one, run \`collect\` and \`pending\` again and dispatch the next wave. Do not use create_threads or t3_thread_launch and do not substitute direct HTTP. controller_context is private to the orchestrator. Wait for the native notifications, no polling. Collect the reviews, validate the format and present the HTML table by model/effort with score, critique/suggestion count, index, weighted score and contribution. Do not invent scores or discard low scores. ${phase === 'definition' ? 'This phase evaluates the experiment DEFINITION; the main problem loop stays blocked until approval bound to the hash.' : 'Continue within the phase recorded in the plan.'}`
}

// ---------- I/O ----------

async function getJson(url, headers = {}, timeout = 20000) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) })
  if (!r.ok) throw new Error(`HTTP ${r.status} at ${url}`)
  return r.json()
}

function proxyKey() {
  return process.env.CLIPROXY_API_KEY ?? fs.readFileSync(path.join(os.homedir(), '.t3/secrets/cliproxy-api-key.txt'), 'utf8').trim()
}

/** Ports of local `opencode serve` processes started by T3. */
function opencodePorts() {
  const raw = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name like 'opencode%'\" | % { $_.CommandLine }"], { encoding: 'utf8', windowsHide: true })
    : execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
  return [...raw.matchAll(/opencode\S*\s+serve\b.*?--port[= ](\d+)/g)].map((m) => Number(m[1]))
}

async function opencodeRuntime(flag, directory) {
  const urls = flag && flag !== 'auto' ? [flag] : opencodePorts().map((p) => `http://127.0.0.1:${p}`)
  for (const base of urls) {
    const u = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password) throw new Error('OpenCode must be local')
    const scoped = (route) => { const x = new URL(route, u); x.searchParams.set('directory', directory); return x }
    try {
      const [providers, config] = await Promise.all([getJson(scoped('/config/providers'), {}, 8000), getJson(scoped('/config'), {}, 8000)])
      return { url: u.origin, providers, config }
    } catch { /* try the next port */ }
  }
  throw new Error('No local OpenCode responded. Dispatch an OpenCode delegate_task so T3 starts the server, or pass --opencode-url.')
}

/** A minimal call through the same route as T3's Claude provider (User-Agent t3-code), to prove credit. */
async function probeClaude(model, key) {
  const r = await fetch(`${PROXY}/messages`, { method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01',
      'User-Agent': 'claude-cli/2.1.317 (external, t3-code, agent-sdk/0.3.284)' },
    body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with OK only.' }] }) })
  const text = await r.text()
  if (!r.ok) throw new Error(`Claude probe failed (HTTP ${r.status}): ${text.slice(0, 300)}`)
  return { model, status: r.status, usage: JSON.parse(text).usage }
}

function readJsonIf(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** [file, arguments, options] to call the T3 CLI. Each call is capped at 30 s. */
function t3Invocation(args) {
  const cli = process.env.T3CODE_CLI_PATH ?? 't3'
  const options = { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
  if (process.platform === 'win32' && /\.cmd$/i.test(cli)) {
    // Calls Electron+bin.mjs directly to avoid % expansion by cmd.exe.
    const launch = /^"([^"\r\n]+\.exe)" "([^"\r\n]+bin\.mjs)" %\*\r?$/m.exec(fs.readFileSync(cli, 'utf8'))
    if (!launch) throw new Error('T3 .cmd launcher not recognized')
    return [launch[1], [launch[2], ...args], { ...options, env: { ...process.env,
      ELECTRON_RUN_AS_NODE: '1', T3CODE_DESKTOP_CLI_LAUNCHER: '1', T3CODE_HOME: process.env.T3CODE_HOME ?? path.join(os.homedir(), '.t3') } }]
  }
  return [cli, args, options]
}

function t3(args, input) {
  const [file, argv, options] = t3Invocation(args)
  return JSON.parse(execFileSync(file, argv, { ...options, input }))
}

const execFileAsync = promisify(execFile)
async function t3Async(args) {
  const [file, argv, options] = t3Invocation(args)
  return JSON.parse((await execFileAsync(file, argv, options)).stdout)
}

/** Runs tasks with at most `limit` at a time; starts none after `until` (epoch ms). */
export async function mapLimit(items, limit, until, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length && Date.now() < until) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function parseFlags(args) {
  const flags = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`)
    if (['--enqueue', '--use-packet', '--no-claude-probe', '--image-input', '--no-history', '--force'].includes(a)) { flags[a.slice(2)] = true; continue }
    if (args[i + 1] === undefined) throw new Error(`${a} has no value`)
    flags[a.slice(2)] = args[++i]
  }
  return flags
}

async function prepare(flags) {
  for (const k of ['thread', 'prompt', 'output']) if (!flags[k]) throw new Error(`--${k} is required`)
  const out = path.resolve(flags.output)
  const planPath = path.join(out, 'plan-t3.json')
  if (fs.existsSync(planPath)) throw new Error('Plan already exists. Use `pending` and `register` to resume.')
  // --prompt a.txt,b.txt: rotations of the same packet, distributed round-robin across the calls.
  const promptPaths = flags.prompt.split(',').map((p) => path.resolve(p.trim())).filter(Boolean)
  const prompts = promptPaths.map((p) => fs.readFileSync(p, 'utf8'))
  const directory = path.resolve(flags.directory ?? process.cwd())
  const key = proxyKey()
  const claude = parseClaude(flags.claude ?? 'default')
  const noFree = flags.free === 'none'

  const [catalog, proxy] = await Promise.all([
    noFree ? { data: [] } : getJson('https://openrouter.ai/api/v1/models'),
    getJson(`${PROXY}/models`, { Authorization: `Bearer ${key}` }),
  ])
  const proxyIds = proxy.data.map((m) => m.id)
  const missing = claude.filter((j) => !proxyIds.includes(j.model))
  if (missing.length) throw new Error(`Claude absent from proxy: ${missing.map((j) => j.model).join(', ')}`)

  let runtimeModels = []
  let variants = {}
  let runtime = null
  if (!noFree) {
    runtime = await opencodeRuntime(flags['opencode-url'] ?? 'auto', directory)
    const { config, providers } = runtime
    const plugins = config.plugin ?? []
    if (!plugins.some((p) => (Array.isArray(p) ? p[0] : p).includes('council-free-only.ts'))
      || config.provider?.openrouter?.options?.baseURL !== PROXY) throw new Error('Free-only/proxy protection missing in OpenCode')
    const free = new Set(freeJobs(catalog.data, proxyIds).jobs.map((j) => j.model))
    for (const name of ['title', 'summary', 'compaction']) {
      const id = config.agent?.[name]?.model?.replace(/^openrouter\//, '')
      if (!free.has(id)) throw new Error(`OpenCode helper is not free: ${name}`)
    }
    const provider = providers.providers?.find((p) => p.id === 'openrouter')
    if (!provider) throw new Error('OpenRouter not found in OpenCode')
    runtimeModels = Object.keys(provider.models)
    variants = Object.fromEntries(Object.entries(provider.models).map(([id, m]) => [id, m.variants ?? {}]))
  }
  const inventory = noFree ? { jobs: [], excluded: [] } : freeJobs(catalog.data, proxyIds, variants, { image: Boolean(flags['image-input']) })
  const pool = noFree ? null : updateFreePool(catalog.data, proxyIds)
  if (!flags['no-history']) {
    const conf = reliability(readJsonIf(HISTORY_FILE()))
    const bad = new Set(Object.entries(conf).filter(([, o]) => o.exclude).map(([m]) => m))
    for (const model of bad) {
      const o = conf[model]
      inventory.excluded.push({ model, reason: `history: ${o.valid}/${o.attempts} valid in ${RELIABILITY.windowDays} days` })
    }
    inventory.jobs = inventory.jobs.filter((j) => !bad.has(j.model))
  }

  const probes = claude.length && !flags['no-claude-probe'] ? [await probeClaude(flags['probe-model'] ?? 'claude-haiku-5-5', key)] : []

  const cache = path.join(os.homedir(), '.cache/council')
  const snapshot = readJsonIf(path.join(cache, 'intelligence-index.json'))
  const aliases = readJsonIf(path.join(cache, 'mappings.json')) ?? {}
  const estimates = readJsonIf(path.join(cache, 'estimated-indices.json')) ?? {}
  const age = snapshot ? Date.now() - Date.parse(snapshot.queried_at) : Infinity
  const snapshotValid = age < SNAPSHOT_MAX_MS

  const packetPaths = flags['use-packet'] ? promptPaths.map((p) => p.replaceAll('\\', '/'))
    : prompts.map((_, i) => path.join(out, prompts.length === 1 ? 'packet.md' : `packet-${i + 1}.md`).replaceAll('\\', '/'))
  const packets = prompts.map((prompt, i) => ({ path: packetPaths[i], prompt }))
  const plan = buildPlan({ jobs: [...inventory.jobs, ...claude], runtimeModels, packets, threadId: flags.thread,
    label: flags.label ?? 'Council', phase: flags.phase ?? 'review', snapshot: snapshotValid ? snapshot : null, aliases, estimates,
    excluded: inventory.excluded, controllerContext: flags.context ? JSON.parse(fs.readFileSync(path.resolve(flags.context), 'utf8')) : {} })
  plan.created_at = new Date().toISOString()
  plan.inventory = { opencode: runtime?.url ?? null, openrouter_catalog: !noFree, claude_probes: probes,
    indices: snapshot ? { queried_at: snapshot.queried_at, mode: snapshot.mode, valid_24h: snapshotValid } : null }

  fs.mkdirSync(out, { recursive: true })
  if (!flags['use-packet']) packets.forEach((p) => fs.writeFileSync(p.path, p.prompt))
  const text = JSON.stringify(plan, null, 2)
  fs.writeFileSync(planPath, text)
  const summary = { plan_path: planPath, plan_sha256: sha(text), calls: plan.calls.length,
    free: plan.calls.filter((c) => c.group === 'free').length, claude: plan.calls.filter((c) => c.group === 'claude').length,
    no_index: plan.calls.filter((c) => !c.index).length, excluded: plan.excluded.length,
    excluded_by_history: plan.excluded.filter((x) => x.reason?.startsWith('history')).map((x) => `${x.model} (${x.reason})`),
    indices_valid: snapshotValid, pool,
    packets: plan.packets.map(({ path: p, sha256 }) => ({ path: p, sha256 })), enqueued: false }
  if (flags.enqueue) {
    summary.delivery = t3(['thread', 'send', flags.thread, '-', '--json'], dispatchMessage(planPath, summary.plan_sha256, summary.calls, plan.phase))
    summary.enqueued = true
  }
  console.log(JSON.stringify(summary, null, 1))
}

function dispatchesPath(planPath) { return path.join(path.dirname(path.resolve(planPath)), 'dispatches.json') }

function closedPath(planPath) { return path.join(path.dirname(path.resolve(planPath)), 'closed.json') }

function collectionPath(planPath) { return path.join(path.dirname(path.resolve(planPath)), 'collection.json') }

function pendingCmd(flags) {
  if (!flags.plan) throw new Error('--plan is required')
  const plan = JSON.parse(fs.readFileSync(path.resolve(flags.plan), 'utf8'))
  const dispatches = readJsonIf(dispatchesPath(flags.plan)) ?? {}
  // Waves: one free call per model in flight. --group claude|free and --max N limit it further.
  const list = pending(plan, dispatches, readJsonIf(collectionPath(flags.plan)))
    .filter((c) => !flags.group || c.group === flags.group).slice(0, flags.max ? Number(flags.max) : undefined)
  const noTask = plan.calls.filter((c) => !dispatches[c.parameters.clientRequestId]?.taskId
    && !dispatches[c.parameters.clientRequestId]?.unavailable).length
  console.log(JSON.stringify({ pending: list.length, no_task: noTask, total: plan.calls.length,
    calls: list.map((c) => c.parameters) }, null, 1))
}

function registerCmd(flags) {
  if (!flags.plan) throw new Error('--plan is required')
  const plan = JSON.parse(fs.readFileSync(path.resolve(flags.plan), 'utf8'))
  const file = dispatchesPath(flags.plan)
  const entries = flags.batch ? JSON.parse(fs.readFileSync(path.resolve(flags.batch), 'utf8'))
    : [{ clientRequestId: flags.id, ...(flags.task ? { taskId: flags.task } : {}), ...(flags.error ? { error: flags.error } : {}),
      ...(flags.failure ? { failure: flags.failure } : {}) }]
  const next = record(plan, readJsonIf(file) ?? {}, entries)
  fs.writeFileSync(file, JSON.stringify(next, null, 1))
  const noTask = plan.calls.filter((c) => !next[c.parameters.clientRequestId]?.taskId && !next[c.parameters.clientRequestId]?.unavailable).length
  console.log(JSON.stringify({ registered: entries.length, no_task: noTask, total: plan.calls.length }))
}

/**
 * Reads each subagent's result through the T3 CLI, validates and writes collection.json in the format of council-table.mjs.
 * Reads run in parallel (8 at a time), each capped at 30 s, and the whole call capped at 2 min:
 * whatever does not fit stays as it was in the previous collection and is read next time. Valid and invalid
 * reviews already read from the same task are not reread. A model T3 refused at dispatch (`model_unavailable`)
 * leaves the denominator as a wrong inventory and appears in `excluded_after_freeze`.
 */
async function collect(flags) {
  if (!flags.plan || !(flags.categories || flags.items)) throw new Error('--plan and (--categories or --items) are required')
  const collectStart = Date.now()
  const planFile = path.resolve(flags.plan)
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  const dispatches = readJsonIf(dispatchesPath(planFile)) ?? {}
  const previousCollection = readJsonIf(collectionPath(planFile))
  const previous = new Map((previousCollection?.entries ?? []).map((e) => [e.clientRequestId, e]))
  const closedAt = readJsonIf(closedPath(planFile))?.at ?? null
  // Packet changed by a participant: restore from the plan before reading any response.
  const changes = [...(previousCollection?.packet_changes ?? []), ...checkPackets(plan.packets, {
    read: (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } },
    mtime: (p) => { try { return fs.statSync(p).mtimeMs } catch { return null } },
    write: (p, t) => fs.writeFileSync(p, t) })]
  const categories = (flags.categories ?? '').split(',').map((c) => c.trim()).filter(Boolean)
  const ids = flags.items ? JSON.parse(fs.readFileSync(path.resolve(flags.items), 'utf8')).map((i) => i.id) : null
  const options = flags.options ? flags.options.split(',').map((o) => o.trim()).filter(Boolean) : null
  if (options && !categories.length) throw new Error('--options requires --categories')
  const validate = (r) => (ids ? validateVotes(r, ids) : options ? validateDecision(r, options, categories) : validateReview(r, categories))
  const snap = readJsonIf(path.join(os.homedir(), '.cache/council/intelligence-index.json'))
  const dir = path.join(path.dirname(planFile), 'responses')
  fs.mkdirSync(dir, { recursive: true })
  const excluded = []
  const read = await mapLimit(plan.calls, 8, collectStart + COLLECT_BUDGET_MS, async (c) => {
    const id = c.parameters.clientRequestId
    // Old plans did not store scale/version; fill them in only if the snapshot is the same one queried in the plan.
    const index = c.index && !c.index.version && snap?.queried_at === c.index.queried_at
      ? { ...c.index, scale: snap.scale, version: snap.version } : c.index
    const base = { model: c.model, effort: c.effort, group: c.group, clientRequestId: id, packet: c.packet ?? 0, index, estimate: c.estimate ?? null }
    const d = dispatches[id]
    const prev = previous.get(id)
    if (d?.unavailable && !d.taskId) {
      excluded.push({ model: c.model, effort: c.effort, clientRequestId: id, reason: `absent_from_T3_catalog: ${d.unavailable.slice(0, 160)}` })
      return null
    }
    if (prev && /^(canceled|not dispatched:)/.test(prev.status ?? '')) return prev
    if (!d?.taskId) {
      const error = d?.attempts?.at(-1)?.error
      const attempted = d?.attempts?.[0]?.at
      return { ...base, start: attempted ?? plan.created_at, ...(attempted ? { attempted: true } : {}), status: 'not dispatched',
        ...(error ? { dispatch_error: error } : {}), admitted: false }
    }
    if (prev?.taskId === d.taskId && (prev.status === 'valid' || prev.status?.startsWith('invalid'))) return prev
    let shown
    try { shown = await t3Async(['thread', 'show', d.taskId.replace(/^node:/, 'thread:'), '--messages', '4', '--json']) }
    catch (e) { return { ...(prev ?? base), status: prev?.status ?? 'pending', admitted: prev?.admitted ?? false, read_error: e.message.slice(0, 120) } }
    const { entry, text } = entryFrom(base, d, shown, validate, prev)
    if (text) fs.writeFileSync(path.join(dir, `${id}.txt`), text)
    return entry
  })
  // Anyone not read within the budget stays as they were (or pending).
  const entries = plan.calls.map((c, i) => read[i] === undefined
    ? { ...(previous.get(c.parameters.clientRequestId) ?? { model: c.model, effort: c.effort, group: c.group,
      clientRequestId: c.parameters.clientRequestId, index: c.index, estimate: c.estimate ?? null, status: 'pending', admitted: false }), unread: true }
    : read[i]).filter(Boolean)
  queueClock(entries, plan.created_at)
  const closing = closeWindow(entries, Date.now(), DEADLINE_MS, closedAt)
  markSuspects(entries, plan.packets, changes)
  const out = { round: flags.round ?? plan.round ?? plan.phase, ...(options ? { options, categories } : {}), collected_at: new Date().toISOString(),
    ...(closedAt ? { closed_at: closedAt } : {}), closing, excluded_after_freeze: excluded,
    packet_changes: changes, entries }
  fs.writeFileSync(collectionPath(planFile), JSON.stringify(out, null, 1))
  if (closing.ready_for_analysis && !flags['no-history']) writeHistory(roundId(plan), plan.created_at, entries)
  const count = (pred) => entries.filter(pred).length
  console.log(JSON.stringify({ total: entries.length, valid: count((e) => e.admitted), invalid: count((e) => e.status.startsWith('invalid')),
    failed: count((e) => e.status.startsWith('failed')), timeouts: count((e) => e.status === 'timeout'),
    awaiting_resend: count((e) => e.status.startsWith(AWAITING_RESEND)),
    pending: count((e) => e.status === 'pending' || e.status === 'not dispatched'), unread: count((e) => e.unread),
    excluded_after_freeze: excluded.length, canceled: count((e) => e.status.startsWith('canceled')),
    packet_changes: changes.length, suspects: count((e) => e.suspect), duration_s: Math.round((Date.now() - collectStart) / 1000), ...closing,
    file: collectionPath(planFile) }))
  return entries
}

/** Refresh of the free pool (daily scheduled task): `pool [--force]`. */
async function poolCmd(flags) {
  const [catalog, proxy] = await Promise.all([getJson('https://openrouter.ai/api/v1/models'),
    getJson(`${PROXY}/models`, { Authorization: `Bearer ${proxyKey()}` })])
  console.log(JSON.stringify(updateFreePool(catalog.data, proxy.data.map((m) => m.id), Boolean(flags.force)), null, 1))
}

/** One cycle of the round: `collect` and then `pending`, to dispatch the next wave. */
async function cycle(flags) {
  await collect(flags)
  pendingCmd(flags)
}

/** Imports old collections into the history (--collections a.json,b.json) and shows the reliability. */
function historyCmd(flags) {
  for (const f of (flags.collections ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const c = JSON.parse(fs.readFileSync(path.resolve(f), 'utf8'))
    const plan = readJsonIf(path.join(path.dirname(path.resolve(f)), 'plan-t3.json'))
    if (!plan) throw new Error(`plan-t3.json missing next to ${f}`)
    writeHistory(roundId(plan), plan.created_at, c.entries)
  }
  const conf = reliability(readJsonIf(HISTORY_FILE()))
  console.log(JSON.stringify({ file: HISTORY_FILE(), criterion: RELIABILITY,
    models: Object.fromEntries(Object.entries(conf).sort((a, b) => (b[1].rate ?? 0) - (a[1].rate ?? 0))) }, null, 1))
}

/**
 * Closes the round before the deadline: writes closed.json and runs `collect`. Anyone who already answered counts;
 * anyone in flight becomes `canceled` and the queue is not dispatched. Returns the taskIds to cancel
 * with `task_cancel`. After that, `tally.mjs` and `agreement` run through the normal flow.
 */
async function closeRound(flags) {
  if (!flags.plan) throw new Error('--plan is required')
  const file = closedPath(flags.plan)
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), reason: flags.reason ?? 'closed by the conductor' }, null, 1))
  const entries = await collect(flags)
  console.log(JSON.stringify({ cancel: entries.filter((e) => e.status.startsWith('canceled') && e.taskId).map((e) => e.taskId) }, null, 1))
}

/** Writes the vote packet from items.json and the current artifact. */
function votePacketCmd(flags) {
  for (const k of ['items', 'artifact', 'out']) if (!flags[k]) throw new Error(`--${k} is required`)
  const items = JSON.parse(fs.readFileSync(path.resolve(flags.items), 'utf8'))
  const out = path.resolve(flags.out)
  if (fs.existsSync(out)) throw new Error('Packet already exists')
  fs.writeFileSync(out, votePacket(items, fs.readFileSync(path.resolve(flags.artifact), 'utf8')))
  console.log(JSON.stringify({ packet: out, items: items.length }))
}

/** Writes the decision council packet from { question, options, categories, evidence, mode }. */
function decisionPacketCmd(flags) {
  for (const k of ['input', 'out']) if (!flags[k]) throw new Error(`--${k} is required`)
  const out = path.resolve(flags.out)
  const input = JSON.parse(fs.readFileSync(path.resolve(flags.input), 'utf8'))
  // One rotation per option: <out> starts with the first, <name>.r1<ext> with the second and so on.
  const { dir, name, ext } = path.parse(out)
  const packets = input.options.map((_, k) => (k === 0 ? out : path.join(dir, `${name}.r${k}${ext}`)))
  const existing = packets.find((p) => fs.existsSync(p))
  if (existing) throw new Error(`Packet already exists: ${existing}`)
  packets.forEach((p, k) => fs.writeFileSync(p, decisionPacket(input, k)))
  console.log(JSON.stringify({ packet: out, packets, prompt: packets.join(','), options: input.options.map((o) => o.id),
    categories: input.categories, mode: input.mode ?? 'quick' }))
}

/** Reads the vote's collection.json and writes agreement.json with the decision per item. */
function agreementCmd(flags) {
  if (!flags.plan || !flags.items) throw new Error('--plan and --items are required')
  const dir = path.dirname(path.resolve(flags.plan))
  const collection = JSON.parse(fs.readFileSync(path.join(dir, 'collection.json'), 'utf8'))
  if (!collection.closing?.ready_for_analysis) throw new Error('Collection still open; run collect until ready_for_analysis')
  const ids = JSON.parse(fs.readFileSync(path.resolve(flags.items), 'utf8')).map((i) => i.id)
  const result = agreement(collection.entries, ids, Number(flags.threshold ?? AGREEMENT_THRESHOLD))
  fs.writeFileSync(path.join(dir, 'agreement.json'), JSON.stringify(result, null, 1))
  console.log(JSON.stringify(result, null, 1))
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const flags = parseFlags(rest)
  if (cmd === 'prepare') return prepare(flags)
  if (cmd === 'pending') return pendingCmd(flags)
  if (cmd === 'register') return registerCmd(flags)
  if (cmd === 'collect') return collect(flags)
  if (cmd === 'close') return closeRound(flags)
  if (cmd === 'cycle') return cycle(flags)
  if (cmd === 'history') return historyCmd(flags)
  if (cmd === 'pool') return poolCmd(flags)
  if (cmd === 'vote-packet') return votePacketCmd(flags)
  if (cmd === 'agreement') return agreementCmd(flags)
  if (cmd === 'decision-packet') return decisionPacketCmd(flags)
  console.error('Usage: council-t3.mjs prepare|pending|register|collect|cycle|close|history|pool|vote-packet|agreement|decision-packet (see the file header)')
  process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch((e) => { console.error(e.message); process.exitCode = 1 })
}
