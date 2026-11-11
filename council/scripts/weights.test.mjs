import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calibrate, isValidEstimate, weights } from './weights.mjs'

const pub = (value) => ({ value, scale: 'Artificial Analysis Intelligence Index', version: '5.0.1',
  source: 'https://artificialanalysis.ai/models/x', queried_at: '2026-11-06T02:44:37Z' })
const est = (value, extra = {}) => ({ value, benchmark: 'GPQA Diamond', source: 'https://example.org/gpqa', n_anchors: 6, r2: 0.8, ...extra })

test('linear calibration needs 5 anchors and a minimum r²; never returns a negative index', () => {
  const anchors = [10, 20, 30, 40, 50].map((score) => ({ score, index: 2 + score / 2 }))
  const c = calibrate(anchors, 60)
  assert.equal(+c.value.toFixed(6), 32)
  assert.equal(+c.r2.toFixed(6), 1)
  assert.equal(calibrate(anchors.slice(0, 4), 60), null)
  assert.equal(calibrate([1, 2, 3, 4, 5].map((s, i) => ({ score: s, index: [5, 1, 9, 2, 6][i] })), 3), null)
  assert.equal(calibrate(anchors, -100).value, 0)
})

test('weight: published in full, estimated at half, floor = half of the lowest known weight', () => {
  const w = weights([{ index: pub(40) }, { estimate: est(20) }, {}, { estimate: est(30, { r2: 0.2 }) }])
  assert.deepEqual(w, [{ weight: 40, type: 'published' }, { weight: 10, type: 'estimated' }, { weight: 5, type: 'floor' }, { weight: 5, type: 'floor' }])
  assert.deepEqual(weights([{}, {}]), [{ weight: 1, type: 'floor' }, { weight: 1, type: 'floor' }])
  assert.ok(!isValidEstimate(est(20, { n_anchors: 4 })))
  assert.ok(!isValidEstimate(est(20, { source: 'not a url' })))
})

test('log-linear calibration recovers an exponential curve and rejects a non-positive index', () => {
  const anchors = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((score) => ({ score, index: 2 * Math.exp(5 * score) }))
  const c = calibrate(anchors, 0.25, { log: true })
  assert.equal(+c.value.toFixed(6), +(2 * Math.exp(1.25)).toFixed(6))
  assert.equal(c.scale, 'log')
  assert.equal(calibrate([...anchors, { score: 0.7, index: 0 }], 0.25, { log: true }), null)
})
