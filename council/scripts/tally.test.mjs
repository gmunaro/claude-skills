import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tally } from './tally.mjs'
import { decisionPacket, validateDecision } from './council-t3.mjs'

// Synthetic indices. They do not represent real model scores.
const index = (value) => ({ value, scale: 'Artificial Analysis Intelligence Index', version: '4',
  source: 'https://artificialanalysis.ai/models/x', queried_at: new Date().toISOString() })
const review = (vote) => ({ vote, confidence: 'high', reasons: ['synthetic evidence'], what_would_change_my_vote: 'new test',
  ...(vote === 'X' ? { missing: 'test result' } : {}),
  scores: ['A', 'B'].map((option) => ({ option, category: 'risk', score: option === vote ? 9 : 6, gap: 'needs a test' })) })
// [model, published index | null, vote | null (failure)]
const entries = (rows) => rows.map(([model, value, vote], i) => ({ model, effort: `e${i}`,
  index: value == null ? null : index(value), estimate: null,
  admitted: vote != null, status: vote != null ? 'valid' : 'timeout', ...(vote != null ? { review: review(vote) } : {}) }))

test('the index decides even against a simple majority', () => {
  const r = tally(entries([['strong', 100, 'B'], ['light1', 20, 'A'], ['light2', 20, 'A']]), ['A', 'B'], ['risk'])
  assert.equal(r.counts.A, 2)
  assert.equal(r.result, 'decision')
  assert.equal(r.choice, 'B')
  assert.equal(r.scores_by_category.B.risk, +((9 * 100 + 6 * 40) / 140).toFixed(2))
})

test('anyone who did not answer leaves the denominator; the discarded are recorded by reason', () => {
  const r = tally(entries([['m1', 100, null], ['m2', 20, 'A'], ['m3', 20, 'A']]), ['A', 'B'])
  assert.equal(r.planned_weight, 140)
  assert.equal(r.valid_weight, 40)
  assert.equal(r.result, 'decision')
  assert.equal(r.choice, 'A')
  assert.deepEqual(r.discarded, { timeout: 1 })
})

test('quorum: valid weight below 2/3 of the weight of those who answered is insufficient', () => {
  const rows = entries([['m1', 30, 'A'], ['m2', 30, 'A'], ['m3', 100, 'A']])
  rows[2] = { ...rows[2], admitted: false, status: 'invalid: no JSON' } // answered off-format
  const r = tally(rows, ['A', 'B'])
  assert.equal(r.quorum.answered_weight, 160)
  assert.equal(r.result, 'insufficient')
  assert.deepEqual(r.reasons, ['valid_weight_over_answered'])
  assert.deepEqual(r.discarded, { off_format: 1 })
  // With the off-format one being light, it passes: 60 / 70 > 2/3.
  rows[2] = { ...rows[2], index: index(10) }
  assert.equal(tally(rows, ['A', 'B']).result, 'decision')
})

test('no index weighs the floor, votes, but does not count as an indexed model', () => {
  const r = tally(entries([['m1', 40, 'A'], ['no1', null, 'A'], ['no2', null, 'A']]), ['A', 'B'])
  assert.equal(r.table[1].weight_type, 'floor')
  assert.equal(r.table[1].weight, 20)
  assert.equal(r.result, 'insufficient')
  assert.deepEqual(r.reasons, ['fewer_than_two_indexed_models'])
})

test('X with a third of the weight becomes missing_fact; without a 2/3 majority it becomes divergence', () => {
  assert.equal(tally(entries([['m1', 40, 'X'], ['m2', 40, 'A'], ['m3', 40, 'A']]), ['A', 'B']).result, 'missing_fact')
  const d = tally(entries([['m1', 45, 'A'], ['m2', 40, 'B'], ['m3', 30, 'A']]), ['A', 'B'])
  assert.equal(d.result, 'divergence')
  assert.equal(d.top_voted, 'A')
  assert.equal(d.best_argument.B.model, 'm2')
})

test('invalid options are rejected', () => {
  assert.throws(() => tally([], ['A']), /invalid options/)
  assert.throws(() => tally([], ['A', 'X']), /invalid options/)
})

test('validateDecision requires a vote, reasons and a 1-10 score per option and category', () => {
  assert.deepEqual(validateDecision(review('A'), ['A', 'B'], ['risk']), [])
  const bad = { ...review('X'), missing: '', scores: [{ option: 'A', category: 'risk', score: 0, gap: 'x' }] }
  const p = validateDecision(bad, ['A', 'B'], ['risk'])
  assert.ok(p.includes('vote X without missing'))
  assert.ok(p.includes('invalid score in A/risk'))
  assert.ok(p.includes('score missing or repeated: B/risk'))
})

test('decision packet carries options, evidence and format, with no cutoff or lineup', () => {
  const t = decisionPacket({ question: 'Which queue?', options: [{ id: 'A', text: 'Redis' }, { id: 'B', text: 'Postgres' }],
    categories: ['cost', 'risk'], evidence: 'We already use Postgres.', mode: 'quick' })
  assert.match(t, /\*\*B\*\*: Postgres/)
  assert.match(t, /4 total/)
  assert.doesNotMatch(t, /2\/3|quorum|Intelligence|Opus|Haiku/i)
  assert.throws(() => decisionPacket({ question: 'q', options: [{ id: 'A', text: 'a' }], categories: ['c'], evidence: 'e' }), /2 to 4/)
})
