import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const fields = ['observable_goal', 'editable_artifact', 'bounded_input_and_scope', 'rubric_with_anchors',
  'repeatable_evaluation', 'oracles_defined', 'budget_and_stop', 'comparison_and_history']

// The fields and the approval are evidence from the controller, not a self-assessment by the juror.
export function hillClimbGate(input) {
  const depth = input.metaDepth ?? 0
  const rounds = input.metaRounds ?? 0
  const maximum = input.maxMetaRounds ?? 3
  const blocked = (reason, metaDepth = depth) => ({ state: 'BLOCKED', main_loop_allowed: false, meta_depth: metaDepth, reason })
  if (![0, 1].includes(depth)) return blocked('meta_depth_exceeded', 1)
  if (!Number.isInteger(rounds) || rounds < 0 || !Number.isInteger(maximum) || maximum < 1) throw new Error('Invalid meta budget')
  if (!['given', 'proposed'].includes(input.origin)) throw new Error('Definition origin is required')
  if (input.blockedReason) return blocked(String(input.blockedReason))
  const complete = fields.every((key) => input.fields?.[key] === true)
  // Approval of the definition: by the owner (conversation in section 2) or by the council (no owner in the conversation).
  const approved = input.approval?.accepted === true && ['owner', 'council'].includes(input.approval?.by)
    && input.definitionChecksPassed === true
    && typeof input.definitionHash === 'string' && /^[a-f0-9]{64}$/.test(input.definitionHash)
    && input.approval.protocolHash === input.definitionHash
  if (complete && (input.origin === 'given' || approved)) {
    return { state: 'RUN_HC', main_loop_allowed: true, meta_depth: 0,
      reason: approved ? `definition_approved_by_${input.approval.by}_and_verified` : 'given_contract_complete' }
  }
  if (rounds >= maximum) return blocked('definition_budget_exhausted', 1)
  return { state: 'REFINE_DEFINITION', main_loop_allowed: false, meta_depth: 1,
    reason: !complete ? 'definition_incomplete' : 'proposal_not_yet_approved' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node hill-climb-gate.mjs triage.json')
  console.log(JSON.stringify(hillClimbGate(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))), null, 2))
}
