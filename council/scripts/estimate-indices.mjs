#!/usr/bin/env node
// Estimated index for free models without a published Intelligence Index. Uses the benchmarks Artificial
// Analysis itself measures (GPQA, HLE, SciCode, LCR, IFBench, tau2, Terminal-Bench Hard), read from the
// public pages, and calibrates log-linearly against the models that have a published index and the same benchmarks.
//
//   node estimate-indices.mjs --targets targets.json [--out ~/.cache/council/estimated-indices.json]
//
// targets.json: { "<OpenRouter id>": "<AA slug>" }. A model without an AA page is left out: it gets the floor.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { calibrate } from './weights.mjs'

export const COMPONENTS = ['gpqa', 'hle', 'scicode', 'lcr', 'ifbench', 'tau2', 'terminalbenchHard']
const BASE = 'https://artificialanalysis.ai/models'

/** Model records embedded in the Next.js payload of a public AA page. */
export function readRecords(html) {
  const h = html.replace(/\\"/g, '"')
  const starts = [...h.matchAll(/\{"id":"([0-9a-f-]{36})","slug":"([^"]+)","name":"([^"]+)"/g)]
  const out = {}
  starts.forEach((m, k) => {
    const chunk = h.slice(m.index, starts[k + 1]?.index ?? m.index + 20000)
    const rec = { slug: m[2], aa_id: m[1], name: m[3] }
    for (const c of ['intelligenceIndex', ...COMPONENTS]) {
      const v = new RegExp(`"${c}":(-?[0-9.eE+-]+|null)[,}]`).exec(chunk)
      if (v) rec[c] = v[1] === 'null' ? null : Number(v[1])
    }
    if (['intelligenceIndex', ...COMPONENTS].some((c) => c in rec)) out[rec.slug] = merge(out[rec.slug], rec)
  })
  return out
}

/** The same model appears several times in the payload, each time with different fields: the numeric value of each field wins. */
export function merge(a, b) {
  if (!a) return b
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) if (out[k] === undefined || (out[k] === null && v !== null)) out[k] = v
  return out
}

/** Estimate for one target: mean of the components it has, calibrated on the anchors that have the same components. */
export function estimate(records, slug) {
  const t = records[slug]
  if (!t || Number.isFinite(t.intelligenceIndex)) return null
  const comps = COMPONENTS.filter((c) => Number.isFinite(t[c]))
  if (comps.length < 3) return null
  const mean = (r) => comps.reduce((s, c) => s + r[c], 0) / comps.length
  const anchors = Object.values(records).filter((r) => r.slug !== slug && r.intelligenceIndex > 0 && comps.every((c) => Number.isFinite(r[c])))
  const fit = calibrate(anchors.map((r) => ({ score: mean(r), index: r.intelligenceIndex })), mean(t), { log: true })
  if (!fit) return null
  return { value: fit.value, benchmark: `AA mean of ${comps.join('+')}`, source: `${BASE}/${slug}`, r2: fit.r2,
    n_anchors: fit.n_anchors, method: 'log-linear over anchors with a published Intelligence Index', score: mean(t) }
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (k) => { const i = args.indexOf(k); return i < 0 ? null : args[i + 1] }
  if (!opt('--targets')) throw new Error('--targets is required')
  const targets = JSON.parse(fs.readFileSync(path.resolve(opt('--targets')), 'utf8'))
  const out = path.resolve(opt('--out') ?? path.join(os.homedir(), '.cache/council/estimated-indices.json'))
  const records = {}
  const pages = []
  for (const url of [BASE, ...Object.values(targets).map((s) => `${BASE}/${s}`)]) {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
    const html = await res.text()
    pages.push({ url, status: res.status, sha256: createHash('sha256').update(html).digest('hex') })
    for (const [slug, r] of Object.entries(readRecords(html))) records[slug] = merge(records[slug], r)
  }
  const queried_at = new Date().toISOString()
  const estimates = {}
  const report = {}
  for (const [id, slug] of Object.entries(targets)) {
    const r = records[slug]
    const e = estimate(records, slug)
    if (e) estimates[id] = { ...e, queried_at }
    report[id] = e ? `estimated ${e.value.toFixed(2)} (r² ${e.r2.toFixed(2)}, ${e.n_anchors} anchors)`
      : Number.isFinite(r?.intelligenceIndex) ? `published ${r.intelligenceIndex.toFixed(2)}: map it in mappings.json, do not estimate`
        : r ? 'not enough components or fit: floor' : 'no AA page: floor'
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({ ...estimates, _meta: { queried_at, pages } }, null, 2))
  console.log(JSON.stringify({ out, ...report }, null, 1))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch((e) => { console.error(e.message); process.exitCode = 1 })
}
