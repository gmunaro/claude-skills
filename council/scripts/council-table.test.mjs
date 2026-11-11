import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderTable, tableRows } from './council-table.mjs'
import vm from 'node:vm'

const index = (value) => ({ value, scale: 'Artificial Analysis Intelligence Index', version: '5.0.1',
  source: 'https://artificialanalysis.ai/models/fixture', queried_at: '2026-11-06T03:00:00Z' })

test('the score is followed by the raw count of critiques/suggestions', () => {
  const rows = tableRows([{ model: 'a', effort: 'high', review: { overall_score: 9, fix_points: [{ id: 1 }, { id: 1 }] }, status: 'valid' }])
  assert.equal(rows[0].score, 9)
  assert.equal(rows[0].points, 2)
  const html = renderTable({ round: 1, entries: [] })
  assert.ok(html.indexOf("['score','Score']") < html.indexOf("['points','Critiques/suggestions']"))
})

test('a failure does not become zero and the score of an invalid review stays visible', () => {
  const rows = tableRows([
    { model: 'a', status: 'failed' },
    { model: 'b', status: 'invalid, not aggregated', review: { overall_score: 10, fix_points: [] } },
  ])
  assert.equal(rows[0].score, null)
  assert.equal(rows[0].points, null)
  assert.equal(rows[1].score, 10)
  assert.equal(rows[1].points, 0)
})

test('model or review text cannot end the script and inject HTML', () => {
  const attack = '</script><img src=x onerror=alert(1)>'
  const html = renderTable({ round: attack, entries: [{ model: attack, effort: attack, status: attack }] })
  assert.ok(!html.includes(attack))
  assert.ok(html.includes('\\u003c/script>'))
  assert.ok(html.includes('td.textContent='))
})

test('keeps rows per effort and per document without merging evaluations', () => {
  const rows = tableRows([
    { model: 'a', effort: 'low', document: 'P' },
    { model: 'a', effort: 'high', document: 'P' },
    { model: 'a', effort: 'low', document: 'Q' },
  ])
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => r.document), ['P', 'P', 'Q'])
})

test('score and contribution use the weight by level and only admitted reviews', () => {
  const rows = tableRows([
    { model: 'a', index: index(20), admitted: true, review: { overall_score: 9, fix_points: [] } },
    { model: 'b', index: index(80), admitted: true, review: { overall_score: 10, fix_points: [] } },
    { model: 'invalid', index: index(100), admitted: false, review: { overall_score: 10, fix_points: [] } },
    { model: 'no-source', admitted: true, review: { overall_score: 10, fix_points: [] } },
  ])
  assert.equal(rows[0].weighted_score, 180)
  assert.equal(rows[0].weight_percent, 20 / 110 * 100)
  assert.equal(rows[0].contribution_points, 180 / 110)
  assert.equal(rows[1].contribution_points, 800 / 110)
  assert.equal(rows[3].contribution_points, 100 / 110)
  assert.equal(rows[2].weighted_score, null)
  assert.equal(rows[3].index, null)
  assert.equal(rows[3].weight_type, 'floor')
  assert.equal(rows[3].weight, 10)
})

test('does not mix index versions and computes the denominator per document', () => {
  const rows = tableRows([
    { model: 'a', document: 'P', index: index(20), admitted: true, review: { overall_score: 9 } },
    { model: 'a', document: 'Q', index: index(20), admitted: true, review: { overall_score: 10 } },
  ])
  assert.equal(rows[0].contribution_points, 9)
  assert.equal(rows[1].contribution_points, 10)
  const mixed = tableRows([
    { model: 'a', index: index(20), admitted: true, review: { overall_score: 9 } },
    { model: 'b', index: { ...index(80), version: '4' }, admitted: true, review: { overall_score: 10 } },
  ])
  assert.ok(mixed.every((r) => r.weighted_score === null))
})

test('HTML shows zero critiques explicitly, without confusing it with a missing field', () => {
  function node(tag) { return { tag, textContent: '', style: {}, children: [], append(...nodes) { this.children.push(...nodes) } } }
  const elements = { caption: node('caption'), head: node('tr'), rows: node('tbody') }
  const document = { createElement: node, getElementById: (id) => elements[id] }
  const html = renderTable({ round: 1, entries: [{ model: 'a', review: { overall_score: 10, fix_points: [] } }] })
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1]
  vm.runInNewContext(script, { document })
  const column = elements.head.children.findIndex((n) => n.textContent === 'Critiques/suggestions')
  assert.equal(elements.rows.children[0].children[column].textContent, '0')
})

test('decision round shows vote, confidence and valid weight; admission is the validator\'s', () => {
  const pub = index(40)
  const entries = [
    { model: 'a', effort: 'low', index: pub, admitted: true, status: 'valid', review: { vote: 'A', confidence: 'high' } },
    { model: 'b', effort: 'low', index: index(10), admitted: true, status: 'valid', review: { vote: 'B', confidence: 'medium' } },
    { model: 'c', effort: 'low', admitted: false, status: 'invalid: x', review: { vote: 'A' } },
  ]
  const rows = tableRows(entries, { decision: true })
  assert.deepEqual(rows.map((r) => [r.choice, r.admitted]), [['A', true], ['B', true], ['', false]])
  assert.equal(rows[0].weight_percent, 80)
  assert.equal(rows[2].weight_percent, null)
  function node(tag) { return { tag, textContent: '', style: {}, children: [], append(...nodes) { this.children.push(...nodes) } } }
  const elements = { caption: node('caption'), head: node('tr'), rows: node('tbody') }
  const html = renderTable({ round: 'decision', options: ['A', 'B'], entries })
  vm.runInNewContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], { document: { createElement: node, getElementById: (id) => elements[id] } })
  const head = elements.head.children.map((n) => n.textContent)
  assert.deepEqual(head, ['Model', 'Effort', 'Vote', 'Confidence', 'Intelligence Index', 'Weight', 'Valid weight', 'Status'])
  const cell = (r, name) => elements.rows.children[r].children[head.indexOf(name)].textContent
  assert.equal(cell(0, 'Vote'), 'A')
  assert.equal(cell(0, 'Valid weight'), '80%')
  assert.equal(cell(2, 'Vote'), '—')
})
