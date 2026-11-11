import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hillClimbGate } from './hill-climb-gate.mjs'

const complete = { observable_goal: true, editable_artifact: true, bounded_input_and_scope: true,
  rubric_with_anchors: true, repeatable_evaluation: true, oracles_defined: true,
  budget_and_stop: true, comparison_and_history: true }
const hash = 'a'.repeat(64)

test('a complete given contract can run without creating an unnecessary meta loop', () => {
  assert.equal(hillClimbGate({ origin: 'given', fields: complete }).state, 'RUN_HC')
})
test('filling in a proposal alone does not release the problem', () => {
  const r = hillClimbGate({ origin: 'proposed', fields: complete })
  assert.equal(r.state, 'REFINE_DEFINITION')
  assert.equal(r.main_loop_allowed, false)
  assert.equal(r.meta_depth, 1)
})
test('approval requires the same hash and approved definition checks', () => {
  const input = { origin: 'proposed', fields: complete, definitionHash: hash,
    approval: { by: 'council', accepted: true, protocolHash: hash }, definitionChecksPassed: false }
  assert.equal(hillClimbGate(input).main_loop_allowed, false)
  input.definitionChecksPassed = true
  assert.equal(hillClimbGate(input).main_loop_allowed, true)
  input.approval.protocolHash = 'b'.repeat(64)
  assert.equal(hillClimbGate(input).main_loop_allowed, false)
})
test('meta stays at level one and stops at the budget', () => {
  assert.equal(hillClimbGate({ origin: 'proposed', fields: {}, metaDepth: 1, metaRounds: 1 }).meta_depth, 1)
  assert.equal(hillClimbGate({ origin: 'proposed', fields: {}, metaDepth: 1, metaRounds: 3 }).state, 'BLOCKED')
  assert.equal(hillClimbGate({ origin: 'proposed', fields: {}, metaDepth: 2 }).state, 'BLOCKED')
})
test('a missing indispensable fact blocks even a complete contract', () => {
  const r = hillClimbGate({ origin: 'given', fields: complete, blockedReason: 'missing_credential' })
  assert.equal(r.state, 'BLOCKED')
  assert.equal(r.main_loop_allowed, false)
})
test('approval does not replace fields that are still incomplete', () => {
  const r = hillClimbGate({ origin: 'proposed', fields: { ...complete, oracles_defined: false },
    definitionHash: hash, approval: { by: 'council', accepted: true, protocolHash: hash }, definitionChecksPassed: true })
  assert.equal(r.main_loop_allowed, false)
})

test('approval must say who approved: owner or council', () => {
  const base = { origin: 'proposed', fields: complete, definitionHash: hash, definitionChecksPassed: true }
  assert.equal(hillClimbGate({ ...base, approval: { accepted: true, protocolHash: hash } }).main_loop_allowed, false)
  const r = hillClimbGate({ ...base, approval: { by: 'owner', accepted: true, protocolHash: hash } })
  assert.equal(r.state, 'RUN_HC')
  assert.equal(r.reason, 'definition_approved_by_owner_and_verified')
  assert.equal(hillClimbGate({ ...base, approval: { by: 'conductor', accepted: true, protocolHash: hash } }).main_loop_allowed, false)
})
