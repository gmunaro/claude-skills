import test from 'node:test'
import assert from 'node:assert/strict'
import { lintPacket } from './lint-packet.mjs'

const rubric = (anchors) => `<<<RUBRIC\n${JSON.stringify([{ category: 'clarity', anchors }])}\nRUBRIC>>>`
const sections = '## User requirements\n## Evidence\n## Scenario\n## Rubric for this evaluation\n'
const art = (o) => `<<<ARTIFACT\n${JSON.stringify(o)}\nARTIFACT>>>`

test('complete packet passes', () => {
  const t = sections + rubric({ 1: 'a', 5: 'b', 10: 'c' }) + art({ aggregation: { weight: 'x' } }) + '\nsee `aggregation.weight`'
  assert.deepEqual(lintPacket(t), [])
})

test('flags missing section, anchor, forbidden term and nonexistent field', () => {
  const t = '## Evidence\n' + rubric({ 1: 'a', 10: 'c' }) + art({ a: 1 }) + '\nFable 5.1; see `rubric_meta.x`'
  const p = lintPacket(t, { forbidden: ['Fable'] })
  assert.ok(p.includes('missing section: ## Scenario'))
  assert.ok(p.includes('category clarity without anchor 5'))
  assert.ok(p.includes('forbidden term present: Fable'))
  assert.ok(p.includes('cited field does not exist in the artifact: rubric_meta.x'))
})

test('no embedded rubric fails', () => {
  assert.ok(lintPacket(sections).some((p) => p.startsWith('packet rubric missing')))
})

test('decision packet: no rubric passes with requireRubric=false, a present rubric is still checked', () => {
  const dec = '## Options\n## Evidence\n## How to respond\n'
  const opts = { sections: ['## Options', '## Evidence', '## How to respond'], requireRubric: false }
  assert.deepEqual(lintPacket(dec, opts), [])
  assert.ok(lintPacket(dec + rubric({ 1: 'a', 5: 'b' }), opts).includes('category clarity without anchor 10'))
})
