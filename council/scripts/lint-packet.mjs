#!/usr/bin/env node
// Lint of an evaluation packet before dispatch (hill-climb.md, "Packet with enough material").
//
//   node lint-packet.mjs --packet packet.txt [--forbidden "Fable,12 pairs"] [--sections "## Evidence,## Scenario"] [--no-rubric]
//
// A decision packet (council-t3.mjs decision-packet) has no embedded rubric:
//   node lint-packet.mjs --packet packet.txt --sections "## Options,## Evidence,## How to respond" --no-rubric
//
// Fails (exit 1) when a required section is missing, a forbidden term appears (removed name, outdated number),
// the rubric is missing (unless --no-rubric) or one of its categories lacks anchors 1, 5 and 10, or the packet
// cites an `x.y` field that does not exist in the JSON embedded between the <<<ARTIFACT and ARTIFACT>>> marks.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_SECTIONS = ['## User requirements', '## Evidence', '## Scenario', '## Rubric for this evaluation']

/** Problems found in the packet text; an empty list = ready for the dry run. */
export function lintPacket(text, { forbidden = [], sections = DEFAULT_SECTIONS, requireRubric = true } = {}) {
  const problems = []
  for (const s of sections) if (!text.includes(s)) problems.push(`missing section: ${s}`)
  for (const p of forbidden) if (p && text.includes(p)) problems.push(`forbidden term present: ${p}`)
  const rubric = /<<<RUBRIC\n([\s\S]*?)\nRUBRIC>>>/.exec(text)
  if (!rubric) { if (requireRubric) problems.push('packet rubric missing (block <<<RUBRIC ... RUBRIC>>>)') }
  else {
    let cats = []
    try { cats = JSON.parse(rubric[1]) } catch { problems.push('packet rubric is not JSON') }
    for (const c of cats) for (const a of ['1', '5', '10']) if (!c.anchors?.[a]) problems.push(`category ${c.category} without anchor ${a}`)
  }
  const art = /<<<ARTIFACT\n([\s\S]*?)\nARTIFACT>>>/.exec(text)
  if (art) {
    let obj = null
    try { obj = JSON.parse(art[1]) } catch { /* artifact is not JSON: no field check */ }
    if (obj) {
      const outside = text.replace(art[0], '')
      for (const [, field] of outside.matchAll(/`([a-z_]+(?:\.[a-z_]+)+)`/g)) {
        const ok = field.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj) !== undefined
        if (!ok) problems.push(`cited field does not exist in the artifact: ${field}`)
      }
    }
  }
  return problems
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const opt = (k) => { const i = args.indexOf(k); return i < 0 ? null : args[i + 1] }
  if (!opt('--packet')) { console.error('--packet is required'); process.exit(2) }
  const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const problems = lintPacket(fs.readFileSync(opt('--packet'), 'utf8'), {
    forbidden: list(opt('--forbidden')), sections: opt('--sections') ? list(opt('--sections')) : DEFAULT_SECTIONS,
    requireRubric: !args.includes('--no-rubric') })
  console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 1))
  process.exitCode = problems.length ? 1 : 0
}
