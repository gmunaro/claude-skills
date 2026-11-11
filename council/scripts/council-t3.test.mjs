import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MARKER, buildPlan, dispatchMessage, freeJobs, indexFor, parseClaude, pending, record, taskText } from './council-t3.mjs'

const free = { pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } }
const catalog = [
  { id: 'free-a', ...free }, { id: 'free-b', ...free },
  { id: 'paid', ...free, pricing: { prompt: '0.000001', completion: '0' } },
  { id: 'free-no-proxy', ...free }, { id: 'openrouter/free', ...free },
]
const snapshot = { queried_at: '2026-11-06T02:44:37.523Z', models: [
  { aa_id: 'aa-opus-high', slug: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)', value: 51.8, source: 'https://x/opus-high', evaluated_config: 'High' },
  { aa_id: 'aa-free-a', slug: 'free-a', name: 'Free A', value: 20, source: 'https://x/free-a' },
] }
const base = { runtimeModels: ['free-a', 'free-b'], packetPath: 'C:/f/packet.txt', prompt: 'contract', threadId: 'parent-1' }
const jobs = () => [...freeJobs(catalog, ['free-a', 'free-b', 'paid', 'openrouter/free'], { 'free-a': { low: {}, high: {} } }).jobs,
  ...parseClaude('claude-opus-5-5:high;claude-haiku-5-5:low')]

test('free models require all prices zero, proxy and a fixed identity', () => {
  const { jobs: j, excluded } = freeJobs(catalog, ['free-a', 'free-b', 'paid', 'openrouter/free'], { 'free-a': { low: {}, high: { disabled: true } } })
  assert.deepEqual(j.map((x) => `${x.model}/${x.effort}`), ['free-a/low', 'free-b/default'])
  assert.deepEqual(excluded.map((x) => x.reason).sort(), ['absent_from_proxy', 'alias_without_fixed_identity'])
})

test('default Claude: Haiku and Sonnet low/medium/high, Opus low/medium, no Fable; rejects invalid input', () => {
  const j = parseClaude('default')
  assert.equal(j.length, 8)
  assert.ok(!j.some((x) => x.model.includes('fable')))
  assert.ok(!j.some((x) => x.model === 'claude-opus-5-5' && x.effort === 'high'))
  assert.ok(j.every((x) => x.group === 'claude'))
  assert.deepEqual(parseClaude('none'), [])
  assert.throws(() => parseClaude('gpt-5:low'), /Invalid/)
  assert.throws(() => parseClaude('claude-opus-5-5:ultra'), /Invalid effort/)
  assert.throws(() => parseClaude('claude-opus-5-5:low,low'), /Duplicate/)
})

test('free-only marker only on OpenCode tasks; Claude goes to claudeAgent with effort', () => {
  const plan = buildPlan({ ...base, jobs: jobs(), snapshot })
  const g = plan.calls.filter((c) => c.group === 'free')
  const c = plan.calls.filter((c) => c.group === 'claude')
  assert.ok(g.every((x) => x.parameters.task.startsWith(MARKER) && x.parameters.target.providerInstanceId === 'opencode'))
  assert.ok(c.every((x) => !x.parameters.task.includes(MARKER) && x.parameters.target.providerInstanceId === 'claudeAgent'))
  assert.deepEqual(c.map((x) => x.parameters.target.options), [{ effort: 'high' }, { effort: 'low' }])
  assert.equal(g.find((x) => x.effort === 'default').parameters.target.options.variant, undefined)
  assert.equal(taskText('p', 'claude'), taskText('p', 'free').slice(MARKER.length + 1))
})

test('clientRequestId is stable and changes with the packet or prompt', () => {
  const ids = buildPlan({ ...base, jobs: jobs() }).calls.map((c) => c.parameters.clientRequestId)
  assert.deepEqual(buildPlan({ ...base, jobs: jobs() }).calls.map((c) => c.parameters.clientRequestId), ids)
  assert.notEqual(buildPlan({ ...base, jobs: jobs(), prompt: 'other' }).calls[0].parameters.clientRequestId, ids[0])
  assert.notEqual(buildPlan({ ...base, jobs: jobs(), packetPath: 'C:/f/other.txt' }).calls[0].parameters.clientRequestId, ids[0])
})

test('index by exact identity: Claude by the effort slug, free by the mapping; missing stays null', () => {
  assert.equal(indexFor({ group: 'claude', model: 'claude-opus-5-5', effort: 'high' }, snapshot).value, 51.8)
  assert.equal(indexFor({ group: 'claude', model: 'claude-opus-5-5', effort: 'low' }, snapshot), null)
  assert.equal(indexFor({ group: 'free', model: 'free-a', effort: 'low' }, snapshot), null)
  assert.equal(indexFor({ group: 'free', model: 'free-a', effort: 'low' }, snapshot, { 'free-a': { aa_id: 'aa-free-a', evaluated_config: 'base' } }).value, 20)
  assert.equal(indexFor({ group: 'claude', model: 'claude-opus-5-5', effort: 'high' }, null), null)
})

test('a free model outside the T3 catalog is excluded without a substitute', () => {
  const plan = buildPlan({ ...base, runtimeModels: ['free-a'], jobs: jobs() })
  assert.ok(plan.excluded.some((e) => e.model === 'free-b' && e.reason === 'absent_from_T3_OpenCode_catalog'))
  assert.ok(!plan.calls.some((c) => c.model === 'free-b'))
})

test('register: a transport error stays without a task; mismatched taskId and an empty record are rejected', () => {
  const plan = buildPlan({ ...base, jobs: jobs() })
  const [a, , b] = plan.calls.map((c) => c.parameters.clientRequestId)
  let d = record(plan, {}, [{ clientRequestId: a, taskId: 't-a' }, { clientRequestId: b, error: 'ECONNRESET' }])
  assert.ok(pending(plan, d).some((c) => c.parameters.clientRequestId === b))
  d = record(plan, d, [{ clientRequestId: b, taskId: 't-b' }])
  assert.equal(d[b].attempts.length, 2)
  assert.ok(!pending(plan, d).some((c) => [a, b].includes(c.parameters.clientRequestId)))
  assert.throws(() => record(plan, d, [{ clientRequestId: a, taskId: 'other' }]), /mismatch/)
  assert.throws(() => record(plan, d, [{ clientRequestId: 'x', taskId: 'y' }]), /outside the plan/)
  assert.throws(() => record(plan, d, [{ clientRequestId: a }]), /exactly one of taskId, error or failure/)
  assert.throws(() => record(plan, {}, [{ clientRequestId: a, failure: '429' }]), /failure without a recorded taskId/)
})

test('waves: at most one free call in flight per model; Claude does not wait', () => {
  const plan = buildPlan({ ...base, jobs: jobs() })
  const id = (m, e) => plan.calls.find((c) => c.model === m && c.effort === e).parameters.clientRequestId
  const ids = (list) => list.map((c) => `${c.model}/${c.effort}`)
  assert.deepEqual(ids(pending(plan, {})), ['free-a/low', 'free-b/default', 'claude-opus-5-5/high', 'claude-haiku-5-5/low'])
  const d = record(plan, {}, [{ clientRequestId: id('free-a', 'low'), taskId: 't1' }])
  assert.ok(!ids(pending(plan, d)).includes('free-a/high'))
  const collection = { entries: [{ clientRequestId: id('free-a', 'low'), status: 'valid' }] }
  assert.ok(ids(pending(plan, d, collection)).includes('free-a/high'))
})

test('429: one resend with -r1 after the wait; an unavailable model leaves the queue', async () => {
  const { UNAVAILABLE } = await import('./council-t3.mjs')
  const plan = buildPlan({ ...base, jobs: jobs() })
  const a = plan.calls[0].parameters.clientRequestId
  let d = record(plan, {}, [{ clientRequestId: a, taskId: 't1' }])
  d = record(plan, d, [{ clientRequestId: a, failure: '429 rate-limited upstream' }])
  assert.equal(d[a].failure.taskId, 't1')
  const t0 = Date.parse('2026-11-07T01:00:00Z')
  const collection = { entries: [{ clientRequestId: a, status: 'awaiting resend: 429', resend_after: new Date(t0 + 60000).toISOString() }] }
  assert.ok(!pending(plan, d, collection, t0).some((c) => c.parameters.clientRequestId.startsWith(a)))
  const r = pending(plan, d, collection, t0 + 61000).find((c) => c.parameters.clientRequestId === `${a}-r1`)
  assert.ok(r)
  d = record(plan, d, [{ clientRequestId: `${a}-r1`, taskId: 't2' }])
  assert.equal(d[a].taskId, 't2')
  assert.equal(d[a].resent, true)
  assert.ok(!pending(plan, d, collection, t0 + 61000).some((c) => c.parameters.clientRequestId.startsWith(a)))
  assert.throws(() => record(plan, d, [{ clientRequestId: `${a}-r1`, taskId: 't3' }]), /resend already recorded/)
  const b = plan.calls[2].parameters.clientRequestId
  const msg = 'model_unavailable: Model openrouter/x is not advertised by provider opencode.'
  assert.match(msg, UNAVAILABLE)
  d = record(plan, d, [{ clientRequestId: b, error: msg }])
  assert.ok(!pending(plan, d).some((c) => c.parameters.clientRequestId === b))
  assert.equal(d[b].unavailable, msg)
})

test('participant state: failure text comes from the record; a 429 awaits resend once; start is the first task\'s', async () => {
  const { entryFrom, validateDecision } = await import('./council-t3.mjs')
  const validate = (r) => validateDecision(r, ['A', 'B'], ['c'])
  const base0 = { model: 'm', effort: 'low', clientRequestId: 'x' }
  const thread = (status, createdAt = '2026-11-07T01:00:00Z') => ({ thread: { status, createdAt, updatedAt: '2026-11-07T01:01:00Z' }, messages: [] })
  let r = entryFrom(base0, { taskId: 't1', failure: { taskId: 't1', text: 'All credentials cooling down (last error: 429)' } }, thread('failed'), validate)
  assert.match(r.entry.status, /^awaiting resend/)
  assert.equal(r.entry.resend_after, '2026-11-07T01:02:00.000Z')
  r = entryFrom(base0, { taskId: 't1', failure: { taskId: 't1', text: 'error 429 Retry-After: 30' } }, thread('failed'), validate)
  assert.equal(r.entry.resend_after, '2026-11-07T01:01:30.000Z')
  r = entryFrom(base0, { taskId: 't2', resent: true, failure: { taskId: 't2', text: '429 again' } }, thread('failed', '2026-11-07T01:03:00Z'), validate,
    { start: '2026-11-07T01:00:00Z' })
  assert.match(r.entry.status, /^failed: 429 again/)
  assert.equal(r.entry.start, '2026-11-07T01:00:00Z')
  r = entryFrom(base0, { taskId: 't2', failure: { taskId: 't1', text: 'old' } }, thread('failed'), validate)
  assert.match(r.entry.status, /^failed: no message; record/)
  const ok = { vote: 'A', confidence: 'high', reasons: ['r'], what_would_change_my_vote: 'x',
    scores: [{ option: 'A', category: 'c', score: 9, gap: 'y' }, { option: 'B', category: 'c', score: 3, gap: 'z' }] }
  r = entryFrom(base0, { taskId: 't1' }, { ...thread('completed'), messages: [{ role: 'assistant', text: JSON.stringify(ok) }] }, validate)
  assert.equal(r.entry.status, 'valid')
  assert.equal(r.entry.taskId, 't1')
})

test('rotation: packets round-robin, option order changes and IDs change with the packet', async () => {
  const { decisionPacket } = await import('./council-t3.mjs')
  const input = { question: 'q', options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }, { id: 'C', text: 'c' }], categories: ['k'], evidence: 'e' }
  const p = [0, 1, 2].map((k) => decisionPacket(input, k))
  assert.ok(p[0].indexOf('**A**') < p[0].indexOf('**B**'))
  assert.ok(p[1].indexOf('**B**') < p[1].indexOf('**C**') && p[1].indexOf('**C**') < p[1].indexOf('**A**'))
  assert.ok(p[2].indexOf('**C**') < p[2].indexOf('**A**'))
  const plan = buildPlan({ ...base, jobs: jobs(), phase: 'decision', packets: p.map((prompt, k) => ({ path: `C:/f/p${k}.txt`, prompt })) })
  assert.deepEqual(plan.calls.map((c) => c.packet), [0, 1, 2, 0, 1])
  assert.ok(plan.calls[1].parameters.task.includes('C:/f/p1.txt'))
  assert.equal(plan.packets.length, 3)
})

test('the task says what the packet is in each phase', () => {
  assert.match(taskText('p', 'claude', 'decision'), /decision packet.*question, the options.*Decide/)
  assert.match(taskText('p', 'claude', 'vote'), /vote packet.*Vote/)
  assert.match(taskText('p', 'claude'), /evaluation packet.*rubric.*Evaluate/)
  assert.doesNotMatch(taskText('p', 'claude', 'decision'), /code and rubric/)
})

test('gap "null", "none" or "-" counts as empty', async () => {
  const { validateDecision, validateReview } = await import('./council-t3.mjs')
  const vote = (gap) => ({ vote: 'A', confidence: 'high', reasons: ['r'], what_would_change_my_vote: 'x',
    scores: [{ option: 'A', category: 'c', score: 9, gap }, { option: 'B', category: 'c', score: 3, gap: 'z' }] })
  for (const f of ['null', 'None', ' - ', 'n/a']) assert.deepEqual(validateDecision(vote(f), ['A', 'B'], ['c']), ['empty gap in A/c'])
  assert.deepEqual(validateDecision(vote('no test yet'), ['A', 'B'], ['c']), [])
  const rev = { overall_score: 8, scores: [{ category: 'a', score: 8, gap: 'null' }], fix_points: [] }
  assert.deepEqual(validateReview(rev, ['a']), ['empty gap in a'])
})

test('queue: a free model waiting for its model\'s turn only starts counting when the previous one finishes', async () => {
  const { queueClock, closeWindow } = await import('./council-t3.mjs')
  const t0 = Date.parse('2026-11-07T02:00:00Z')
  const at = (s) => new Date(t0 + s * 1000).toISOString()
  const mk = (st1, end1) => [
    { group: 'free', model: 'm', taskId: 't1', status: st1, start: at(0), ...(end1 ? { end: end1 } : {}) },
    { group: 'free', model: 'm', status: 'not dispatched', start: at(0) },
    { group: 'free', model: 'n', status: 'not dispatched', start: at(0) },
    { group: 'claude', model: 'c', status: 'not dispatched', attempted: true, start: at(30) },
  ]
  let e = queueClock(mk('pending'), at(0))
  assert.equal(e[1].start, null)
  assert.equal(e[2].start, at(0))
  assert.equal(e[3].start, at(30))
  closeWindow(e, t0 + 700 * 1000)
  assert.equal(e[1].status, 'not dispatched')
  assert.equal(e[2].status, 'timeout')
  e = queueClock(mk('valid', at(120)), at(0))
  assert.equal(e[1].start, at(120))
  e = queueClock(mk('timeout'), at(0))
  assert.equal(e[1].start, at(600))
})

test('batched reads respect the limit and the budget', async () => {
  const { mapLimit } = await import('./council-t3.mjs')
  let active = 0
  let peak = 0
  const r = await mapLimit([1, 2, 3, 4, 5, 6], 2, Date.now() + 60000, async (x) => {
    peak = Math.max(peak, ++active); await new Promise((ok) => setTimeout(ok, 5)); active--; return x * 2
  })
  assert.deepEqual(r, [2, 4, 6, 8, 10, 12])
  assert.equal(peak, 2)
  const expired = await mapLimit([1, 2], 2, Date.now() - 1, async (x) => x)
  assert.equal(expired.length, 2)
  assert.ok([0, 1].every((i) => expired[i] === undefined))
})

test('input validation and orchestrator message without the marker', () => {
  assert.throws(() => buildPlan({ ...base, jobs: jobs(), threadId: 'x";y' }), /Invalid thread ID/)
  assert.throws(() => buildPlan({ ...base, jobs: jobs(), prompt: ' ' }), /Empty packet/)
  assert.throws(() => buildPlan({ ...base, jobs: jobs(), phase: 'meta-meta' }), /Invalid phase/)
  const msg = dispatchMessage('plan.json', 'h', 3, 'definition')
  assert.ok(!msg.includes(MARKER))
  assert.match(msg, /DEFINITION/)
})

test('extracts JSON with fences and surrounding text, and validates the review format', async () => {
  const { extractJson, validateReview } = await import('./council-t3.mjs')
  const cats = ['a', 'b']
  const ok = { overall_score: 8, scores: [{ category: 'a', score: 8, gap: 'x' }, { category: 'b', score: 10, gap: 'nothing' }], fix_points: [] }
  assert.deepEqual(extractJson('text\n```json\n' + JSON.stringify(ok) + '\n```\nend'), ok)
  assert.equal(extractJson('{"a":"key } in string"}').a, 'key } in string')
  assert.equal(extractJson('no json'), null)
  assert.deepEqual(validateReview(ok, cats), [])
  const bad = { overall_score: 11, scores: [{ category: 'a', score: 7, gap: 'nothing' }], fix_points: [] }
  const p = validateReview(bad, cats)
  assert.ok(p.some((x) => /overall_score/.test(x)) && p.some((x) => /missing: b/.test(x)) && p.some((x) => /"nothing" with score 7/.test(x)))
  assert.deepEqual(validateReview(null, cats), ['no JSON'])
})

test('window: fixed 10 min deadline per participant; lateness and a failed dispatch become timeout without leaving the total', async () => {
  const { closeWindow, DEADLINE_MS } = await import('./council-t3.mjs')
  assert.equal(DEADLINE_MS, 600000)
  const t0 = Date.parse('2026-11-06T05:00:00Z')
  const at = (s) => new Date(t0 + s * 1000).toISOString()
  const mk = () => [
    { group: 'claude', status: 'pending', start: at(0) },
    { group: 'free', status: 'pending', start: at(10) },
    { group: 'free', status: 'valid', start: at(0), end: at(50) },
    { group: 'free', status: 'not dispatched', start: at(5) },
  ]
  let e = mk()
  let w = closeWindow(e, t0 + 400 * 1000)
  assert.equal(w.timeout_s, 600)
  assert.equal(w.ready_for_analysis, false)
  assert.equal(w.waiting, 3)
  assert.equal(w.next_deadline, at(610))
  e = mk()
  w = closeWindow(e, t0 + 606 * 1000)
  assert.deepEqual(e.map((x) => x.status), ['timeout', 'pending', 'valid', 'timeout'])
  assert.equal(w.ready_for_analysis, false)
  e = mk()
  w = closeWindow(e, t0 + 611 * 1000)
  assert.deepEqual(e.map((x) => x.status), ['timeout', 'timeout', 'valid', 'timeout'])
  assert.equal(w.ready_for_analysis, true)
  assert.equal(e.length, 4)
  e = [{ group: 'free', status: 'awaiting resend: 429', start: at(0) }]
  assert.equal(closeWindow(e, t0 + 300 * 1000).ready_for_analysis, false)
  closeWindow(e, t0 + 601 * 1000)
  assert.equal(e[0].status, 'failed: 429', 'the recorded cause survives the deadline')
})

test('voting: validates each item once with an integer score and a reason', async () => {
  const { validateVotes } = await import('./council-t3.mjs')
  const ok = { votes: [{ id: 'C1', agreement: 8, reason: 'x' }, { id: 'C2', agreement: 3, reason: 'y' }] }
  assert.deepEqual(validateVotes(ok, ['C1', 'C2']), [])
  const bad = { votes: [{ id: 'C1', agreement: 7.5, reason: '' }, { id: 'C1', agreement: 8, reason: 'z' }, { id: 'C9', agreement: 5, reason: 'w' }] }
  const p = validateVotes(bad, ['C1', 'C2'])
  for (const re of [/repeated: C1/, /missing: C2/, /not in list: C9/, /invalid agreement in C1/, /empty reason in C1/]) assert.ok(p.some((x) => re.test(x)), re)
  assert.deepEqual(validateVotes(null, ['C1']), ['no JSON'])
})

test('agreement: mean weighted by weight level; applies only 7-10; without quorum the conductor decides', async () => {
  const { agreement } = await import('./council-t3.mjs')
  const pub = (value) => ({ value, scale: 'Artificial Analysis Intelligence Index', version: '5.0.1',
    source: 'https://artificialanalysis.ai/models/x', queried_at: '2026-11-06T02:44:37Z' })
  const v = (a, b) => ({ votes: [{ id: 'C1', agreement: a, reason: 'm' }, { id: 'C2', agreement: b, reason: 'm' }] })
  const e = (model, value, review, admitted = true) => ({ model, index: value ? pub(value) : null, admitted, review })
  // weights: a=30, b=10, free=floor 0.5x10=5 → C1 = (9·30+5·10+1·5)/45 = 7.22; C2 = (6·30+8·10+1·5)/45 = 5.89
  const r = agreement([e('a', 30, v(9, 6)), e('b', 10, v(5, 8)), e('free', null, v(1, 1))], ['C1', 'C2'])
  assert.equal(r.quorum.ok, true)
  assert.equal(r.quorum.indexed_models, 2)
  assert.deepEqual(r.items.map((i) => [i.id, i.agreement, i.decision]), [['C1', 7.22, 'apply'], ['C2', 5.89, 'reject']])
  assert.deepEqual(r.items[0].votes_by_type, { published: 2, estimated: 0, floor: 1 })
  const exact = agreement([e('a', 10, v(7, 6)), e('b', 10, v(7, 7))], ['C1', 'C2'])
  assert.deepEqual(exact.items.map((i) => i.decision), ['apply', 'reject'])
  const none = agreement([e('a', 30, v(10, 10)), e('b', 10, null, false), e('c', 10, null, false)], ['C1', 'C2'])
  assert.equal(none.quorum.ok, false)
  assert.ok(none.items.every((i) => i.decision === 'conductor_decides'), 'without quorum the vote is advisory')
  assert.deepEqual(none.items.map((i) => i.indication), ['favorable', 'favorable'])
  const floorOnly = agreement([e('x', null, v(10, 10)), e('y', null, v(10, 10))], ['C1', 'C2'])
  assert.equal(floorOnly.quorum.ok, false, 'the floor does not manufacture indexed models')
})

test('vote packet lists the items without the conductor\'s opinion and rejects duplicate IDs', async () => {
  const { votePacket } = await import('./council-t3.mjs')
  const t = votePacket([{ id: 'C1', section: 'states', problem: 'p', fix: 'c' }], 'ARTIFACT')
  assert.match(t, /### C1 \(states\)/)
  assert.match(t, /ARTIFACT/)
  assert.match(t, /"votes"/)
  assert.throws(() => votePacket([{ id: 'C1' }, { id: 'C1' }], 'x'), /Duplicate/)
  assert.throws(() => votePacket([], 'x'), /No items/)
})

test('decision packet: the example carries one score per option and category', async () => {
  const { decisionPacket, extractJson } = await import('./council-t3.mjs')
  const input = { question: 'Q?', options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }, { id: 'C', text: 'c' }],
    categories: ['x', 'y', 'z'], evidence: 'e' }
  const example = extractJson(decisionPacket(input, 1).split('in this format')[1])
  assert.equal(example.scores.length, 9)
  assert.deepEqual([...new Set(example.scores.map((n) => n.option))], ['B', 'C', 'A'])
  assert.deepEqual([...new Set(example.scores.map((n) => n.category))], ['x', 'y', 'z'])
})

test('packets: SHA-256 checked, changed one restored from the plan, a reader in the interval becomes suspect', async () => {
  const { buildPlan, checkPackets, markSuspects } = await import('./council-t3.mjs')
  const plan = buildPlan({ jobs: [{ model: 'claude-haiku-5-5', effort: 'low', group: 'claude' }], runtimeModels: [],
    packets: [{ path: 'p1.md', prompt: 'ONE' }, { path: 'p2.md', prompt: 'TWO' }], threadId: 't' })
  assert.equal(plan.packets[1].content, 'TWO')
  const disk = { 'p1.md': 'ONE', 'p2.md': 'TWO edited' }
  // real mtime: the restore rewrites the file and changes the mtime, as on disk.
  const mtimes = { 'p1.md': Date.parse('2026-11-07T09:00:00Z'), 'p2.md': Date.parse('2026-11-07T10:05:00Z') }
  const io = { read: (p) => disk[p] ?? null, mtime: (p) => mtimes[p], write: (p, t) => { disk[p] = t; mtimes[p] = Date.parse('2026-11-07T10:06:00Z') } }
  const now = Date.parse('2026-11-07T10:06:00Z')
  const changed = checkPackets(plan.packets, io, now)
  assert.equal(changed.length, 1)
  assert.equal(changed[0].path, 'p2.md')
  assert.equal(changed[0].restored, true)
  assert.equal(changed[0].changed_at, '2026-11-07T10:05:00.000Z', 'time of the tampering, not of the restore')
  assert.equal(disk['p2.md'], 'TWO')
  assert.deepEqual(checkPackets(plan.packets, io, now), [], 'a restored packet is not flagged again')
  const e = [
    { packet: 1, taskId: 't1', start: '2026-11-07T10:00:00Z', end: '2026-11-07T10:05:30Z' }, // read in the interval
    { packet: 1, taskId: 't2', start: '2026-11-07T10:00:00Z', end: '2026-11-07T10:04:00Z' }, // finished before
    { packet: 1, taskId: 't3', start: '2026-11-07T10:07:00Z' },                              // started after the restore
    { packet: 0, taskId: 't4', start: '2026-11-07T10:00:00Z', end: '2026-11-07T10:05:30Z' }, // another packet
  ]
  markSuspects(e, plan.packets, changed, now)
  assert.deepEqual(e.map((x) => Boolean(x.suspect)), [true, false, false, false])
  assert.match(e[0].suspect, /p2.md changed/)
})

test('close: in flight becomes canceled, the queue is not dispatched, a 429 keeps the cause and the collection is ready', async () => {
  const { closeWindow, pending } = await import('./council-t3.mjs')
  const now = Date.parse('2026-11-07T10:01:00Z')
  const e = [
    { status: 'valid', taskId: 'a', start: '2026-11-07T10:00:00Z' },
    { status: 'pending', taskId: 'b', start: '2026-11-07T10:00:00Z' },
    { status: 'not dispatched', start: null },
    { status: 'awaiting resend: 429 rate-limited', taskId: 'd', start: '2026-11-07T10:00:00Z' },
    { status: 'pending', taskId: 'e', start: '2026-11-07T09:50:00Z' },
  ]
  const w = closeWindow(e, now, 600000, '2026-11-07T10:01:00Z')
  assert.deepEqual(e.map((x) => x.status), ['valid', 'canceled: round closed', 'not dispatched: round closed', 'failed: 429 rate-limited', 'timeout'], 'anyone already past the deadline stays timeout')
  assert.equal(w.ready_for_analysis, true)
  assert.equal(w.closed_at, '2026-11-07T10:01:00Z')
  assert.deepEqual(pending({ calls: [{ group: 'claude', parameters: { clientRequestId: 'x' } }] }, {}, { closed_at: 'now', entries: [] }), [])
})

test('packet with images: only free models with image input', async () => {
  const { freeJobs } = await import('./council-t3.mjs')
  const m = (id, inp) => ({ id, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: inp, output_modalities: ['text'] } })
  const cat = [m('a/text:free', ['text']), m('b/vision:free', ['text', 'image'])]
  assert.deepEqual(freeJobs(cat, ['a/text:free', 'b/vision:free']).jobs.map((j) => j.model), ['a/text:free', 'b/vision:free'])
  const r = freeJobs(cat, ['a/text:free', 'b/vision:free'], {}, { image: true })
  assert.deepEqual(r.jobs.map((j) => j.model), ['b/vision:free'])
  assert.deepEqual(r.excluded, [{ model: 'a/text:free', reason: 'no_image_input' }])
})

test('history: a free model that does not deliver leaves the lineup; Claude and those with few attempts stay', async () => {
  const { roundSummary, reliability } = await import('./council-t3.mjs')
  const e = (model, group, status) => ({ model, group, taskId: 't', status, admitted: status === 'valid' })
  const r = roundSummary([e('bad', 'free', 'invalid: no JSON'), e('bad', 'free', 'failed: 429'),
    e('good', 'free', 'valid'), e('claude-x', 'claude', 'timeout'), e('bad', 'free', 'canceled: round closed'),
    { model: 'bad', group: 'free', status: 'not dispatched' }])
  assert.deepEqual(r.bad, { group: 'free', attempts: 2, valid: 0 })
  const now = Date.parse('2026-11-07T00:00:00Z')
  const hist = { rounds: {
    a: { at: '2026-11-06T00:00:00Z', models: r },
    b: { at: '2026-11-05T00:00:00Z', models: { bad: { group: 'free', attempts: 1, valid: 0 }, 'claude-x': { group: 'claude', attempts: 3, valid: 0 } } },
    old: { at: '2026-10-01T00:00:00Z', models: { good: { group: 'free', attempts: 9, valid: 0 } } },
  } }
  const c = reliability(hist, now)
  assert.equal(c.bad.attempts, 3)
  assert.equal(c.bad.exclude, true)
  assert.equal(c['claude-x'].exclude, false, 'Claude never leaves because of history')
  assert.equal(c.good.exclude, false, 'a round outside the window does not count')
  assert.equal(c.good.attempts, 1)
})

test('close does not cancel anyone that collect has not read yet', async () => {
  const { closeWindow } = await import('./council-t3.mjs')
  const e = [{ status: 'pending', taskId: 'x', start: new Date().toISOString(), unread: true }]
  const w = closeWindow(e, Date.now(), 600000, new Date().toISOString())
  assert.equal(e[0].status, 'pending')
  assert.equal(w.ready_for_analysis, false)
})

test('daily pool: keeps the day, records who joined and who left', async () => {
  const { refreshPool } = await import('./council-t3.mjs')
  const t0 = Date.parse('2026-11-06T06:00:00Z')
  const a = refreshPool(null, ['b:free', 'a:free', 'a:free'], t0)
  assert.deepEqual(a.pool.models, ['a:free', 'b:free'])
  assert.equal(a.change, null, 'the first snapshot is not a change')
  const early = refreshPool(a.pool, ['c:free'], t0 + 3600000)
  assert.equal(early.updated, false, 'under 24 h: does not update')
  assert.equal(refreshPool(a.pool, ['c:free'], t0 + 3600000, true).updated, true, '--force updates')
  const day = refreshPool(a.pool, ['a:free', 'c:free'], t0 + 86400000)
  assert.deepEqual(day.change, { at: '2026-11-07T06:00:00.000Z', entered: ['c:free'], left: ['b:free'] })
  assert.equal(day.pool.changes.length, 1)
  const same = refreshPool(day.pool, ['c:free', 'a:free'], t0 + 2 * 86400000)
  assert.equal(same.updated, true)
  assert.equal(same.change, null)
  assert.equal(same.pool.changes.length, 1, 'a day without changes adds no entry')
})
