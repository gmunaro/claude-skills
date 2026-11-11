#!/usr/bin/env node
// Tally for the decision council (a choice among 2 to 4 options). Reads the collection.json written by
// `council-t3.mjs collect --options ...` and writes decision.json next to it.
//
//   node tally.mjs --plan dir/plan-t3.json --options A,B[,C,D]
//
// Each vote is weighted by the three levels of weights.mjs (published, estimated, floor). Result:
//   insufficient  no quorum (see quorumByAnswer);
//   missing_fact  `X` adds up to at least 1/3 of the valid weight;
//   decision      one option adds up to at least 2/3 of the valid weight;
//   divergence    none of the above.
// Anyone who did not answer, timed out, failed, was canceled or did not follow the format stays out of the
// denominator (owner rule, 2026-11-07). The discarded show up in `discarded`, for the record only.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { weights } from './weights.mjs'

const EPS = 1e-9
/** Minimum fraction of the valid weight over the weight of those who answered (valid + off-format). */
export const MIN_ANSWERED_FRACTION = 2 / 3

const discardReason = (st = '') => (st.startsWith('invalid') ? 'off_format' : st === 'timeout' ? 'timeout'
  : st.startsWith('failed') ? 'failed' : st.startsWith('canceled') ? 'canceled' : st.startsWith('not dispatched') ? 'not_dispatched' : 'no_response')

/**
 * Quorum by answer. all = [{ e: collection entry, weight, type }]. Passes with at least 2 distinct models
 * with a published index among the valid ones and with valid weight / weight of those who answered
 * >= MIN_ANSWERED_FRACTION. Does not require a fraction of those planned. Also returns the discarded, by reason.
 */
export function quorumByAnswer(all) {
  const adm = all.filter((x) => x.e.admitted)
  const answered = all.filter((x) => x.e.admitted || (x.e.status ?? '').startsWith('invalid'))
  const valid_weight = adm.reduce((s, x) => s + x.weight, 0)
  const answered_weight = answered.reduce((s, x) => s + x.weight, 0)
  const quorum = {
    valid: adm.length, answered: answered.length, planned: all.length,
    valid_weight, answered_weight,
    answered_weight_fraction: answered_weight ? valid_weight / answered_weight : 0,
    // Estimates and the floor give a voice, but do not manufacture quorum.
    indexed_models: new Set(adm.filter((x) => x.type === 'published').map((x) => x.e.model)).size,
  }
  quorum.ok = quorum.indexed_models >= 2 && quorum.answered_weight_fraction + EPS >= MIN_ANSWERED_FRACTION
  const discarded = {}
  for (const x of all) if (!x.e.admitted) { const m = discardReason(x.e.status); discarded[m] = (discarded[m] ?? 0) + 1 }
  return { quorum, discarded }
}

/** entries = collection.entries (model, effort, index, estimate, admitted, review). `opts` goes to weights(). */
export function tally(entries, options, categories = [], opts = {}) {
  if (!Array.isArray(options) || options.length < 2 || options.length > 4 || options.includes('X')
    || new Set(options).size !== options.length) throw new Error('invalid options: 2 to 4 distinct IDs, no X')
  const w = weights(entries, opts)
  const all = entries.map((e, i) => ({ e, ...w[i] }))
  const adm = all.filter((x) => x.e.admitted)
  const planned = all.reduce((s, x) => s + x.weight, 0)
  const { quorum, discarded } = quorumByAnswer(all)
  const valid = quorum.valid_weight
  const zeros = () => Object.fromEntries([...options, 'X'].map((o) => [o, 0]))
  const counts = zeros()
  const weighted = zeros()
  for (const x of adm) { counts[x.e.review.vote]++; weighted[x.e.review.vote] += x.weight }

  // Argument of the heaviest vote on each option, for the question to the human in case of divergence.
  const best_argument = Object.fromEntries([...options, 'X'].map((o) => {
    const top = adm.filter((x) => x.e.review.vote === o).sort((a, b) => b.weight - a.weight)[0]
    return [o, top ? { model: top.e.model, effort: top.e.effort, reason: top.e.review.reasons[0],
      ...(o === 'X' ? { missing: top.e.review.missing } : {}) } : null]
  }))
  const scores_by_category = Object.fromEntries(options.map((o) => [o, Object.fromEntries(categories.map((c) => {
    const ns = adm.map((x) => ({ x, n: x.e.review.scores.find((n) => n.option === o && n.category === c) }))
    const p = ns.reduce((s, { x }) => s + x.weight, 0)
    return [c, p ? +(ns.reduce((s, { x, n }) => s + n.score * x.weight, 0) / p).toFixed(2) : null]
  }))]))
  const table = all.map((x) => ({ model: x.e.model, effort: x.e.effort, status: x.e.status ?? null,
    vote: x.e.admitted ? x.e.review.vote : null, weight: +x.weight.toFixed(3), weight_type: x.type,
    confidence: x.e.admitted ? x.e.review.confidence : null, reason: x.e.admitted ? x.e.review.reasons[0] : null,
    ...(x.e.suspect ? { suspect: x.e.suspect } : {}) }))
  const base = { options, counts, weighted, planned_weight: planned, valid_weight: valid, quorum, discarded,
    suspects: adm.filter((x) => x.e.suspect).length,
    weight_by_type: Object.fromEntries(['published', 'estimated', 'floor'].map((t) => [t, adm.filter((x) => x.type === t).length])),
    best_argument, scores_by_category, table }

  if (!quorum.ok) {
    return { ...base, result: 'insufficient', reasons: [
      ...(quorum.answered_weight_fraction + EPS < MIN_ANSWERED_FRACTION ? ['valid_weight_over_answered'] : []),
      ...(quorum.indexed_models < 2 ? ['fewer_than_two_indexed_models'] : []),
    ] }
  }
  if (weighted.X + EPS >= valid / 3) return { ...base, result: 'missing_fact' }
  const choice = options.find((o) => weighted[o] + EPS >= valid * 2 / 3)
  if (choice) return { ...base, result: 'decision', choice }
  const order = [...options].sort((a, b) => weighted[b] - weighted[a])
  return { ...base, result: 'divergence', top_voted: order[0] }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const opt = (k) => { const i = args.indexOf(k); return i < 0 ? null : args[i + 1] }
  const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!opt('--plan') || !opt('--options')) { console.error('Usage: node tally.mjs --plan dir/plan-t3.json --options A,B [--categories a,b]'); process.exit(2) }
  const dir = path.dirname(path.resolve(opt('--plan')))
  const collection = JSON.parse(fs.readFileSync(path.join(dir, 'collection.json'), 'utf8'))
  if (!collection.closing?.ready_for_analysis) { console.error('Collection still open; run collect until ready_for_analysis'); process.exit(1) }
  const r = tally(collection.entries, list(opt('--options')), list(opt('--categories') ?? collection.categories?.join(',')))
  fs.writeFileSync(path.join(dir, 'decision.json'), JSON.stringify(r, null, 1))
  console.log(JSON.stringify(r, null, 1))
}
