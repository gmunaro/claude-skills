// Cheap tests for prompt.mjs: `call` and the files are simulated; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readPreviousPrompt, GENERATION_FIELDS, extractCritiques, recommendPrompt, validateRecommendation, prepareReview, applyReview, readContext, readCostFromFiles,
  createLoop, canStart, recordStage, recordFinalists, nextStage, STAGES, FAILURES } from './prompt.mjs'
import { contextBlock } from './context.mjs'

const { agreement } = await import(new URL('../../council/scripts/council-t3.mjs', import.meta.url).href)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-'))
let n = 0
const folder = () => path.join(tmp, `p${n++}`)
const json = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); return f }
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
/** Fake call: returns the responses in order and records the requests. */
const fake = (...responses) => { const f = async (request) => { f.requests.push(request); const r = responses[Math.min(f.requests.length - 1, responses.length - 1)]; return typeof r === 'function' ? r(request) : { text: typeof r === 'string' ? r : JSON.stringify(r), cost_usd: 0.01 } }; f.requests = []; return f }

// ---------- A6 ----------

test('extractCritiques (scores mode): fix_points from scores.json and gap from collection.json, without repeats or invalid opinions', () => {
  const dir = folder()
  json(path.join(dir, 'scores.json'), { fix_points: [{ model: 'm/a', problem: 'pale nails', fix: 'paint them black' }, { model: 'm/b', problem: '' }] })
  json(path.join(dir, 'collection.json'), { entries: [
    { model: 'm/a', admitted: true, review: { fix_points: [{ problem: 'pale nails', fix: 'paint them black' }],
      scores: [{ category: 'readability_in_game', score: 8, gap: 'thin arms disappear at 2x' }, { category: 'finish', score: 10, gap: 'nothing' }] } },
    { model: 'm/c', admitted: false, review: { scores: [{ category: 'readability_in_game', score: 2, gap: 'from an invalid model' }] } },
  ] })
  const c = extractCritiques(dir)
  assert.deepEqual(c.map((x) => x.id), ['C1', 'C2'])
  assert.equal(c[0].text, 'pale nails -> paint them black')
  assert.equal(c[0].source, 'scores.json')
  assert.equal(c[1].text, '[readability_in_game 8/10] thin arms disappear at 2x')
  assert.equal(c[1].category, 'readability_in_game')
})

test('extractCritiques (decision mode): reasons and best argument per option, with an options filter', () => {
  const dir = folder()
  json(path.join(dir, 'collection.json'), { entries: [
    { model: 'm/a', admitted: true, review: { vote: 'C', reasons: ['C reads better at 128px'],
      scores: [{ option: 'A', category: 'canon', score: 5, gap: 'standing, not coiled' }, { option: 'C', category: 'canon', score: 6, gap: 'short nails' }] } },
  ] })
  json(path.join(dir, 'decision.json'), { best_argument: { A: { model: 'm/x', reason: 'A holds up the coiled tower' }, B: null, C: { model: 'm/a', reason: 'C reads better at 128px' } } })
  const all = extractCritiques(dir)
  assert.equal(all.length, 4, 'the reason repeated in collection and decision is listed once')
  assert.ok(all.some((c) => c.source === 'decision.json' && c.option === 'A'))
  const onlyA = extractCritiques(dir, { options: ['A'] })
  assert.deepEqual(onlyA.map((c) => c.option), ['A', 'A'])
  assert.throws(() => extractCritiques(folder()), /no scores\.json/)
})

const CRITIQUES = [{ id: 'C1', text: 'pale nails' }, { id: 'C2', text: 'upright pose, not coiled' }, { id: 'C3', text: 'thin arms disappear' }]
const CTX = 'canon: the Crowmother sleeps coiled on the hill; cold 32-color palette'
const GENERATOR = { id: 'google/nano-banana', limits: ['reference 640x360', 'no wav'] }
const PREVIOUS = 'Pixel art boss sprite. Pale nails.'
const ANSWER = { prompt: 'Pixel art boss sprite, coiled sleeping pose. Long black nails. Thick arms.',
  changes: [{ id: 'M1', source_critique: ['C1'], change: 'long black nails' }, { id: 'M2', source_critique: 'C2', change: 'coiled pose' },
    { id: 'M3', source_critique: ['C3', 'C1'], change: 'thick arms' }] }

test('validateRecommendation refuses a change without a source, with a nonexistent source, a repeated id and an empty prompt', () => {
  assert.deepEqual(validateRecommendation(ANSWER, CRITIQUES), [])
  const bad = { prompt: ' ', changes: [{ id: 'M1', change: 'x' }, { id: 'M1', source_critique: ['C9'], change: 'y' }, { id: 'X', source_critique: ['C1'], change: 'z' }] }
  const p = validateRecommendation(bad, CRITIQUES).join('|')
  assert.match(p, /empty prompt/)
  assert.match(p, /M1 has no source critique/)
  assert.match(p, /duplicate change: M1/)
  assert.match(p, /cites a nonexistent critique: C9/)
  assert.match(p, /invalid change id: X/)
  assert.deepEqual(validateRecommendation(null, CRITIQUES), ['no JSON'])
  assert.ok(validateRecommendation({ prompt: 'p', changes: [] }, CRITIQUES).includes('no changes'))
})

test('recommendPrompt writes prompt.json with text, generator, changes with their source and the context sha', async () => {
  const out = folder()
  const call = fake('Here it is:\n```json\n' + JSON.stringify(ANSWER) + '\n```')
  const r = await recommendPrompt({ critiques: CRITIQUES, context: CTX, generator: GENERATOR, previousPrompt: PREVIOUS, call, out })
  const g = readJson(path.join(out, 'prompt.json'))
  assert.equal(g.text, ANSWER.prompt)
  assert.deepEqual(g.generator, GENERATOR)
  assert.equal(g.context_sha256.length, 64)
  assert.deepEqual(g.changes.map((m) => [m.id, m.source_critique]), [['M1', ['C1']], ['M2', ['C2']], ['M3', ['C3', 'C1']]])
  assert.equal(g.previous_prompt, PREVIOUS)
  assert.equal(r.cost_usd, 0.01)
  assert.equal(call.requests.length, 1)
  const request = call.requests[0]
  for (const excerpt of [CTX, PREVIOUS, 'google/nano-banana', 'reference 640x360', '- C1: pale nails']) assert.ok(request.includes(excerpt), excerpt)
})

test('recommendPrompt resends once with the problems, and refuses for good when it still has no source', async () => {
  const noSource = { prompt: 'p', changes: [{ id: 'M1', change: 'something' }] }
  const recovers = fake(noSource, ANSWER)
  const r = await recommendPrompt({ critiques: CRITIQUES, context: CTX, generator: GENERATOR, previousPrompt: PREVIOUS, call: recovers })
  assert.equal(recovers.requests.length, 2)
  assert.match(recovers.requests[1], /M1 has no source critique/)
  assert.equal(r.cost_usd, 0.02)

  const stubborn = fake(noSource)
  await assert.rejects(() => recommendPrompt({ critiques: CRITIQUES, context: CTX, generator: GENERATOR, previousPrompt: PREVIOUS, call: stubborn }), /invalid recommendation.*has no source critique/)
  assert.equal(stubborn.requests.length, 2)

  await assert.rejects(() => recommendPrompt({ critiques: CRITIQUES, context: CTX, generator: GENERATOR, previousPrompt: PREVIOUS, call: fake(() => ({ error: 'HTTP 500' })) }), /call failed: HTTP 500/)
  await assert.rejects(() => recommendPrompt({ critiques: [], context: CTX, generator: GENERATOR, previousPrompt: PREVIOUS, call: fake(ANSWER) }), /no critiques/)
  await assert.rejects(() => recommendPrompt({ critiques: CRITIQUES, context: CTX, generator: {}, previousPrompt: PREVIOUS, call: fake(ANSWER) }), /generator has no id/)
})

// ---------- A7 ----------

async function recommended(out = folder()) {
  await recommendPrompt({ critiques: CRITIQUES, context: CTX, generator: GENERATOR, previousPrompt: PREVIOUS, call: fake(ANSWER), out })
  return path.join(out, 'prompt.json')
}

test('prepareReview writes items.json (one change per item) and packet.txt in the vote format', async () => {
  const pj = await recommended()
  const out = folder()
  const r = prepareReview(pj, { context: CTX, out })
  const items = readJson(path.join(out, 'items.json'))
  assert.deepEqual(items.map((i) => i.id), ['M1', 'M2', 'M3'])
  assert.ok(items.every((i) => i.section === 'prompt'))
  assert.deepEqual(items[0], { id: 'M1', section: 'prompt', problem: 'pale nails', fix: 'long black nails' })
  assert.equal(items[2].problem, 'thin arms disappear | pale nails')
  assert.equal(r.packet, path.join(out, 'packet.txt'))
  const packet = fs.readFileSync(r.packet, 'utf8')
  assert.match(packet, /### M1 \(prompt\)/)
  assert.match(packet, /Proposed fix: coiled pose/)
  for (const excerpt of [PREVIOUS, ANSWER.prompt, CTX, '- C2: upright pose, not coiled', '"votes"']) assert.ok(packet.includes(excerpt), excerpt)
  assert.throws(() => prepareReview(pj, { context: CTX, out }), /already exists/)
  assert.throws(() => prepareReview(pj, { context: 'another context', out: folder() }), /different sha/)
})

// Real council agreement from simulated votes: two indexed jurors of equal weight.
const pub = (value) => ({ value, scale: 'Artificial Analysis Intelligence Index', version: '5.0.1', source: 'https://artificialanalysis.ai/models/x', queried_at: '2026-11-06T02:44:37Z' })
const vote = (...scores) => ({ votes: scores.map((c, i) => ({ id: `M${i + 1}`, agreement: c, reason: 'm' })) })
const opinion = (model, review, admitted = true) => ({ model, index: pub(10), admitted, review })
const tally = (...opinions) => agreement(opinions, ['M1', 'M2', 'M3'])
const recompose = (txt = 'FINAL PROMPT', applied = ['M1', 'M2']) => fake({ prompt: txt, applied })

test('applyReview applies 7 to 10, discards below 7 and recomposes the text with only the approved changes', async () => {
  const pj = await recommended()
  const conc = tally(opinion('a', vote(10, 7, 4)), opinion('b', vote(8, 7, 6)))   // means 9, 7, 5
  const call = recompose('Pixel art boss sprite, coiled. Long black nails.')
  const r = await applyReview(pj, conc, { call })
  assert.equal(r.state, 'revised')
  assert.deepEqual(r.applied.map((m) => [m.id, m.mean]), [['M1', 9], ['M2', 7]])
  assert.deepEqual(r.discarded.map((m) => [m.id, m.mean]), [['M3', 5]])
  assert.match(r.discarded[0].reason, /below 7/)
  assert.equal(r.text, 'Pixel art boss sprite, coiled. Long black nails.')
  const request = call.requests[0]
  assert.ok(request.includes(PREVIOUS) && request.includes('long black nails') && request.includes('coiled pose'))
  assert.ok(!request.includes('thick arms'), 'the discarded change does not go into the recomposition')
  assert.ok(!request.includes(ANSWER.prompt), 'neither does the whole recommended prompt')
  assert.deepEqual(readJson(path.join(path.dirname(pj), 'prompt-revised.json')).applied.map((m) => m.id), ['M1', 'M2'])
})

test('applyReview with everything below 7 does not call the model and keeps the previous prompt', async () => {
  const pj = await recommended()
  const call = recompose()
  const r = await applyReview(pj, tally(opinion('a', vote(6, 3, 1)), opinion('b', vote(6, 5, 2))), { call })
  assert.equal(r.state, 'none_applied')
  assert.equal(r.text, PREVIOUS)
  assert.equal(r.applied.length, 0)
  assert.equal(r.discarded.length, 3)
  assert.equal(call.requests.length, 0)
})

test('applyReview without quorum: state no_quorum and no change goes in, even with a score of 10', async () => {
  const pj = await recommended()
  const call = recompose()
  const noQuorum = tally(opinion('a', vote(10, 10, 10)), opinion('b', null, false), opinion('c', null, false))
  assert.equal(noQuorum.quorum.ok, false)
  const r = await applyReview(pj, noQuorum, { call })
  assert.equal(r.state, 'no_quorum')
  assert.equal(r.text, PREVIOUS)
  assert.equal(r.applied.length, 0)
  assert.ok(r.discarded.every((m) => /no quorum/.test(m.reason) && m.mean === 10))
  assert.equal(call.requests.length, 0)
})

test('applyReview refuses an invalid recomposition and an item without a vote stays discarded', async () => {
  const pj = await recommended()
  const conc = tally(opinion('a', vote(9, 9, 9)), opinion('b', vote(9, 9, 9)))
  conc.items = conc.items.filter((i) => i.id !== 'M3')
  const r = await applyReview(pj, conc, { call: recompose() })
  assert.deepEqual(r.discarded.map((m) => [m.id, m.reason]), [['M3', 'no vote for this item']])
  const empty = await applyReview(pj, conc, { call: fake('no json', '{"prompt":""}'), out: folder() })
  assert.deepEqual([empty.state, empty.text], ['no_recommendation', PREVIOUS])
  assert.match(empty.reason, /invalid recomposition/)
})

// ---------- A8 ----------

const newLoop = (opts = {}) => createLoop({ target: 'boss', out: folder(), ...opts })
/** Runs the stage the normal way: can start -> record. */
const runStage = (loop, stage, projected, measured = projected, extra = {}) => {
  const p = canStart(loop, stage, projected)
  assert.equal(p.ok, true, p.reason)
  return recordStage(loop, stage, { measured_cost: measured, files: [`${stage}.json`], ...extra })
}
const finalFiles = () => { const d = folder(); fs.mkdirSync(d); const f = (name) => { const p = path.join(d, name); fs.writeFileSync(p, name); return p }; return { revised: f('rev.png'), old: [f('old1.png'), f('old2.png')], current: f('current.png') } }

test('createLoop declares the caps and the stages in order before spending', () => {
  const l = newLoop()
  const g = readJson(l.file)
  assert.deepEqual(g.stages.map((e) => e.name), ['judge', 'recommend', 'review', 'generate', 'judge_final'])
  assert.deepEqual(STAGES, g.stages.map((e) => e.name))
  assert.equal(g.stage_cap_usd, 3)
  assert.equal(g.iteration_cap_usd, 9)
  assert.equal(g.spent_usd, 0)
  assert.equal(g.state, 'in_progress')
  assert.equal(g.max_iterations, 1)
  assert.equal(nextStage(l), 'judge')
  assert.throws(() => createLoop({ target: 'boss', out: path.dirname(l.file) }), /already exists/)
  assert.throws(() => createLoop({ target: 'x', out: folder(), stageCap: 0 }), /greater than zero/)
})

test('loop: stages only advance in order and each one runs once', () => {
  const l = newLoop()
  assert.match(canStart(l, 'generate', 1).reason, /order: judge/)
  assert.throws(() => recordStage(l, 'review', { measured_cost: 0 }), /order: judge/)
  runStage(l, 'judge', 1)
  assert.match(canStart(l, 'judge', 1).reason, /already recorded.*at most 1 iteration/)
  assert.match(canStart(l, 'review', 0).reason, /order: recommend/)
  assert.equal(nextStage(l), 'recommend')
  assert.throws(() => canStart(l, 'made-up', 1), /unknown stage/)
  assert.throws(() => recordStage(l, 'recommend', { state: 'maybe' }), /invalid state/)
})

test('loop: the stage cap refuses before spending and ends at cap_exceeded', () => {
  const l = newLoop()
  const p = canStart(l, 'judge', 3.01)
  assert.equal(p.ok, false)
  assert.equal(p.state, 'cap_exceeded')
  assert.match(p.reason, /stage cap \$3/)
  const g = readJson(l.file)
  assert.equal(g.state, 'cap_exceeded')
  assert.equal(g.spent_usd, 0)
  assert.equal(g.stages[0].state, 'cap_exceeded')
  assert.match(canStart(l, 'recommend', 0).reason, /loop closed: cap_exceeded/)
  assert.equal(nextStage(l), null)
  assert.equal(canStart(newLoop(), 'judge', 3).ok, true, 'exactly at the cap passes')
})

test('loop: the iteration cap adds up the measured spend of the earlier stages', () => {
  const l = newLoop()
  runStage(l, 'judge', 2.5, 3)
  runStage(l, 'recommend', 1.5)
  runStage(l, 'review', 1.5)
  runStage(l, 'generate', 3)
  assert.equal(readJson(l.file).spent_usd, 9)
  const p = canStart(l, 'judge_final', 0.5)
  assert.equal(p.ok, false)
  assert.equal(p.state, 'cap_exceeded')
  assert.match(p.reason, /spent \$9 \+ projected \$0\.5 exceeds the iteration cap \$9/)
  assert.equal(readJson(l.file).state, 'cap_exceeded')
  // a stage that still fits: with room to spare
  const m = newLoop()
  runStage(m, 'judge', 3)
  assert.deepEqual(canStart(m, "recommend", 2), { ok: true, stage_cap_usd: 3, remaining_usd: 6 })
})

test('loop: measured spend above the stage cap counts and is flagged', () => {
  const l = newLoop({ stageCap: 1, iterationCap: 2 })
  recordStage(l, 'judge', { measured_cost: 1.4 })
  const g = readJson(l.file)
  assert.equal(g.spent_usd, 1.4)
  assert.equal(g.stages[0].above_cap, true)
  assert.equal(g.state, 'cap_exceeded', 'measured spend above the stage cap ends the iteration')
  assert.match(g.reason, /stage cap \$1/)
  assert.equal(canStart(l, 'recommend', 0.7).ok, false)
})

test('loop: a stage failure (no_quorum, zero_candidates) ends the iteration without continuing', () => {
  for (const state of ['no_quorum', 'zero_candidates']) {
    const l = newLoop()
    runStage(l, 'judge', 1)
    runStage(l, 'recommend', 0)
    recordStage(l, 'review', { measured_cost: 0, state })
    const g = readJson(l.file)
    assert.equal(g.state, state)
    assert.equal(g.stages[2].state, state)
    assert.match(canStart(l, 'generate', 1).reason, new RegExp(`loop closed: ${state}`))
    assert.throws(() => recordStage(l, 'generate', {}), /loop closed/)
  }
})

test('loop: one iteration per request; judge_final records the 3 finalists and completes, and nothing restarts afterwards', () => {
  const l = newLoop()
  for (const e of ['judge', 'recommend', 'review', 'generate']) runStage(l, e, 1)
  assert.throws(() => recordStage(l, 'judge_final', { measured_cost: 1 }), /record the finalists/)
  const f = finalFiles()
  assert.throws(() => recordFinalists(l, { ...f, current: path.join(tmp, 'does-not-exist.png') }), /does not exist/)
  assert.throws(() => recordFinalists(l, { ...f, old: [] }), /missing old_prompt/)
  recordFinalists(l, f)
  const end = runStage(l, 'judge_final', 1)
  assert.equal(end.state, 'completed')
  const g = readJson(l.file)
  assert.deepEqual(g.finalists, { revised_prompt: [f.revised], old_prompt: f.old, current_asset: [f.current] })
  assert.equal(g.spent_usd, 5)
  assert.equal(g.iteration, 1)
  assert.equal(nextStage(l), null)
  assert.match(canStart(l, 'judge', 0.1).reason, /loop closed: completed/)
  assert.throws(() => recordStage(l, 'judge', {}), /loop closed/)
})

test('loop CLI: create, can, record and next write the same loop.json', () => {
  const here = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompt.mjs')
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [here, ...args], { encoding: 'utf8' }))
  const dir = folder()
  cli('loop-create', '--target', 'boss', '--out', dir, '--cap-iteration', '6')
  const lf = path.join(dir, 'loop.json')
  assert.equal(cli('loop-next', '--loop', lf).next, 'judge')
  assert.equal(cli('loop-can', '--loop', lf, '--stage', 'judge', '--projected', '2').ok, true)
  cli('loop-record', '--loop', lf, '--stage', 'judge', '--cost', '2', '--files', 'a.json,b.json')
  const g = readJson(lf)
  assert.equal(g.iteration_cap_usd, 6)
  assert.deepEqual(g.stages[0].files, ['a.json', 'b.json'])
  assert.equal(cli('loop-next', '--loop', lf).next, 'recommend')
})

// ---------- v2: B2 (context.json), B3 (map and origin), B7 (cost read and states) ----------

const shaOf = (v) => createHash('sha256').update(v).digest('hex')
const here = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompt.mjs')
/** Context in buildContext's format: the sha256 is the block's. */
const contextObj = () => {
  const c = { media: 'image', subtype: null, name: 'Crowmother', fields: { canon: { text: CTX, source: { file: 'target.json', sha256: shaOf(CTX), excerpt: 'canon' } } } }
  return { ...c, sha256: shaOf(contextBlock(c)) }
}

test('B2: readContext accepts plain text and context.json (block built, sha checked) and refuses a wrong sha', () => {
  assert.equal(readContext(CTX), CTX)
  assert.equal(readContext('{ not json'), '{ not json')
  const c = contextObj()
  assert.equal(readContext(JSON.stringify(c)), contextBlock(c))
  assert.throws(() => readContext(JSON.stringify({ ...c, sha256: shaOf('other') })), /context\.json refused: block sha256/)
  const without = { ...c }; delete without.sha256
  assert.throws(() => readContext(JSON.stringify(without)), /no sha256/)
  const tampered = { ...c, fields: { canon: { ...c.fields.canon, text: 'canon swapped' } } }
  assert.throws(() => readContext(JSON.stringify(tampered)), /refused/)
})

test('B2: the recommend and prepare-review CLI read context.json and refuse a wrong sha', async () => {
  const c = contextObj()
  const block = contextBlock(c)
  const dir = folder()
  const ctxJson = json(path.join(dir, 'context.json'), c)
  const bad = json(path.join(dir, 'bad.json'), { ...c, sha256: shaOf('x') })
  // prepare-review: prompt.json was written with the block's sha
  const out = folder()
  await recommendPrompt({ critiques: CRITIQUES, context: block, generator: GENERATOR, previousPrompt: PREVIOUS, call: fake(ANSWER), out })
  const r = JSON.parse(execFileSync(process.execPath, [here, 'prepare-review', '--prompt', path.join(out, 'prompt.json'), '--context', ctxJson, '--out', folder()], { encoding: 'utf8' }))
  assert.deepEqual(r.items.map((i) => i.id), ['M1', 'M2', 'M3'])
  assert.throws(() => execFileSync(process.execPath, [here, 'prepare-review', '--prompt', path.join(out, 'prompt.json'), '--context', bad, '--out', folder()], { encoding: 'utf8', stdio: 'pipe' }), /sha256/)
  // recommend: refuses before any model call
  const round = folder()
  json(path.join(round, 'scores.json'), { fix_points: [{ model: 'm/a', problem: 'pale nails', fix: 'paint them' }] })
  const generator = json(path.join(dir, 'g.json'), GENERATOR)
  const previous = path.join(dir, 'prev.txt'); fs.writeFileSync(previous, PREVIOUS)
  assert.throws(() => execFileSync(process.execPath, [here, 'recommend', '--folder', round, '--context', bad, '--generator', generator, '--previous', previous, '--out', folder()], { encoding: 'utf8', stdio: 'pipe' }), /sha256/)
})

/** Anonymous decision folder: shuffled letters (A=new, B=old, C=current) with map.json, and a collection with scores per letter. */
function anonymousRound({ withOrigin = true } = {}) {
  const dir = folder()
  json(path.join(dir, 'map.json'), { seed: 's1', letter_to_option: { A: 'g1_nano', B: 'g2_flux', C: 'pro3_current' } })
  json(path.join(dir, 'collection.json'), { entries: [{ model: 'm/a', admitted: true, review: { vote: 'B', reasons: ['B has black nails'],
    scores: [{ option: 'A', category: 'canon', score: 5, gap: 'upright pose' }, { option: 'C', category: 'canon', score: 6, gap: 'short nails' }] } }] })
  if (withOrigin) json(path.join(dir, 'origin.json'), { g1_nano: { origin: 'generator', model: 'google/nano-banana' }, g2_flux: { origin: 'generator', model: 'bfl/flux' }, pro3_current: { origin: 'current', file: 'game/boss.png' } })
  return dir
}

test('B3: extractCritiques translates letters through map.json and origin.json; --options accepts a letter or an original id', () => {
  const dir = anonymousRound()
  const all = extractCritiques(dir)
  const a = all.find((c) => c.text.includes('upright pose'))
  assert.deepEqual([a.option, a.letter, a.original_id, a.origin], ['A', 'A', 'g1_nano', { origin: 'generator', model: 'google/nano-banana' }])
  const c = all.find((x) => x.text.includes('short nails'))
  assert.deepEqual([c.letter, c.original_id, c.origin], ['C', 'pro3_current', { origin: 'current', file: 'game/boss.png' }])
  assert.equal(all.find((x) => x.text.includes('B has black nails')).original_id, 'g2_flux')
  // by letter and by original id give the same result
  const byLetter = extractCritiques(dir, { options: ['A'] })
  const byId = extractCritiques(dir, { options: ['g1_nano'] })
  assert.deepEqual(byId, byLetter)
  assert.deepEqual(byId.map((x) => x.original_id), ['g1_nano'])
  assert.deepEqual(extractCritiques(dir, { options: ['g1_nano', 'C'] }).map((x) => x.letter), ['A', 'C'])
  assert.throws(() => extractCritiques(dir, { options: ['Z'] }), /neither a letter nor an original id/)
})

test('B3: origin by path (the origin option) and without map/origin the critiques stay as before', () => {
  const dir = anonymousRound({ withOrigin: false })
  assert.equal(extractCritiques(dir)[0].origin, undefined)
  assert.equal(extractCritiques(dir)[0].original_id, 'g1_nano')
  const outside = json(path.join(folder(), 'o.json'), { g1_nano: { origin: 'generator', model: 'x/y' } })
  assert.equal(extractCritiques(dir, { origin: outside }).find((c) => c.letter === 'A').origin.model, 'x/y')
  assert.throws(() => extractCritiques(dir, { origin: path.join(tmp, 'does-not-exist.json') }), /origin does not exist/)
  const noMap = folder()
  json(path.join(noMap, 'scores.json'), { fix_points: [{ model: 'm', problem: 'p' }] })
  assert.deepEqual(extractCritiques(noMap).map((c) => c.letter), [undefined])
})

test('B3: the critiques CLI --options accepts an original id and the recommender gets the translation in the request', async () => {
  const dir = anonymousRound()
  const cli = JSON.parse(execFileSync(process.execPath, [here, 'critiques', '--folder', dir, '--options', 'g2_flux'], { encoding: 'utf8' }))
  assert.deepEqual(cli.map((c) => [c.letter, c.original_id]), [['B', 'g2_flux']])
  const critiques = extractCritiques(dir, { options: ['A', 'pro3_current'] })
  const call = fake({ prompt: 'p', changes: [{ id: 'M1', source_critique: ['C1'], change: 'm' }] })
  await recommendPrompt({ critiques, context: CTX, generator: GENERATOR, previousPrompt: PREVIOUS, call })
  assert.match(call.requests[0], /- C1 \(option A: g1_nano; generated by google\/nano-banana\): \[canon 5\/10\] upright pose/)
  assert.match(call.requests[0], /\(option C: pro3_current; current asset \(boss\.png\)\)/)
})

/** Writes cost.json (and an optional collection.json) in a round folder and returns the path of cost.json. */
const costJson = (measured, collection = null) => { const d = folder(); if (collection) json(path.join(d, 'collection.json'), collection); return json(path.join(d, 'cost.json'), { measured_usd: measured }) }
const candidatesJson = (measured, candidates) => json(path.join(folder(), 'candidates.json'), { state: 'ok', measured_usd: measured, candidates })

test('B7: all failure states of generate and run/council are accepted and end the iteration; no_ffmpeg is gone (F4)', () => {
  for (const state of ['no_quorum', 'zero_candidates', 'cap_exceeded', 'no_key', 'no_video_access']) assert.ok(FAILURES.includes(state), state)
  assert.equal(FAILURES.includes('no_ffmpeg'), false)
  for (const state of ['no_key', 'no_video_access']) {
    const l = newLoop()
    runStage(l, 'judge', 1)
    runStage(l, 'recommend', 0)
    runStage(l, 'review', 0)
    recordStage(l, 'generate', { measured_cost: 0, state })
    const g = readJson(l.file)
    assert.equal(g.state, state)
    assert.equal(g.stages[3].state, state)
    assert.equal(nextStage(l), null)
    assert.match(canStart(l, 'judge_final', 1).reason, new RegExp(`loop closed: ${state}`))
  }
  assert.throws(() => recordStage(newLoop(), 'judge', { measured_cost: 0, state: 'broke' }), /invalid state/)
})

test('B7: the cost is read from cost.json (judging) and candidates.json (generation, with spend_limit_usd) and adds up in the loop', () => {
  const l = newLoop()
  const cj = costJson(1.25)
  const r1 = recordStage(l, 'judge', { files: [cj] })
  assert.equal(r1.stages[0].measured_cost, 1.25)
  assert.deepEqual(r1.stages[0].cost_read_from, [cj])
  recordStage(l, 'recommend', {})
  recordStage(l, 'review', {})
  const cand = candidatesJson(0.5, [
    { model: 'a', state: 'ok', projected_cost: 0.4, measured_cost: 0.5 },
    { model: 'b', state: 'failed', projected_cost: 0.3, measured_cost: null },      // unknown cost: counted at the projected cost
    { model: 'c', state: 'not_started', projected_cost: 2, measured_cost: null }, // did not run: left out
  ])
  const read = readCostFromFiles([cand])
  assert.deepEqual([read.cost, read.spend_limit_usd], [0.8, 0.3])
  const r4 = recordStage(l, 'generate', { files: [cand, 'other.png'] })
  assert.equal(r4.stages[3].measured_cost, 0.8)
  assert.equal(r4.stages[3].spend_limit_usd, 0.3)
  assert.equal(r4.spent_usd, 2.05)
  assert.equal(readCostFromFiles(['a.json', 'b.png']), null)
  assert.throws(() => readCostFromFiles([path.join(tmp, 'does-not-exist', 'cost.json')]), /does not exist/)
  assert.throws(() => readCostFromFiles([json(path.join(folder(), 'cost.json'), {})]), /no valid measured_usd/)
})

test('B7: a typed --cost that does not match what was read is refused (tolerance 1e-6); without a file, a paid stage requires the cost', () => {
  const l = newLoop()
  const cj = costJson(1.25)
  assert.throws(() => recordStage(l, 'judge', { measured_cost: 1.3, files: [cj] }), /does not match what was read.*1\.25/)
  assert.equal(readJson(l.file).stages[0].state, 'pending', 'the refusal writes nothing')
  assert.equal(recordStage(l, 'judge', { measured_cost: 1.25 + 5e-7, files: [cj] }).stages[0].measured_cost, 1.25)
  const m = newLoop()
  assert.throws(() => recordStage(m, 'judge', { files: ['a.json'] }), /unknown cost/)
  recordStage(m, 'judge', { measured_cost: 0.5 })
  assert.equal(recordStage(m, 'recommend', {}).stages[1].measured_cost, 0, 'recommend and review run on the subscription')
})

test('B7: measured spend above the stage or iteration cap ends at cap_exceeded; Claude via subscription does not count', () => {
  const byStage = newLoop({ stageCap: 1, iterationCap: 9 })
  const r = recordStage(byStage, 'judge', { files: [costJson(1.4)] })
  assert.equal([r.state, r.stages[0].above_cap, r.spent_usd].join(), 'cap_exceeded,true,1.4')
  assert.match(r.reason, /stage cap \$1/)

  const byIteration = newLoop({ stageCap: 3, iterationCap: 4 })
  recordStage(byIteration, 'judge', { files: [costJson(2.5)] })
  recordStage(byIteration, 'recommend', {})
  recordStage(byIteration, 'review', {})
  assert.equal(readJson(byIteration.file).state, 'in_progress')
  const r2 = recordStage(byIteration, 'generate', { files: [candidatesJson(2, [])] })
  assert.equal(r2.state, 'cap_exceeded')
  assert.equal(r2.above_iteration_cap, true)
  assert.match(r2.reason, /iteration cap \$4/)
  assert.equal(nextStage(byIteration), null)

  // proxy-claude: the cost_usd of subscription responses comes out of the measured cost (the $ equivalent is never read)
  const subscription = costJson(1.5, { entries: [{ route: 'proxy-claude', cost_usd: 0.5 }, { route: 'openrouter', cost_usd: 1.5 }] })
  assert.equal(readCostFromFiles([subscription]).cost, 1)
  const l = newLoop({ stageCap: 3 })
  assert.equal(recordStage(l, 'judge', { files: [costJson(0, { entries: [{ route: 'proxy-claude (x)', cost_usd: 0 }] })] }).state, 'in_progress')
})

test('B7: the loop-record CLI reads cost.json, refuses a diverging --cost and accepts no_key', () => {
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [here, ...args], { encoding: 'utf8', stdio: 'pipe' }))
  const dir = folder()
  cli('loop-create', '--target', 'boss', '--out', dir)
  const lf = path.join(dir, 'loop.json')
  const cj = costJson(0.75)
  assert.throws(() => cli('loop-record', '--loop', lf, '--stage', 'judge', '--files', cj, '--cost', '0.5'), /does not match/)
  assert.equal(cli('loop-record', '--loop', lf, '--stage', 'judge', '--files', cj).stages[0].measured_cost, 0.75)
  cli('loop-record', '--loop', lf, '--stage', 'recommend')
  cli('loop-record', '--loop', lf, '--stage', 'review')
  assert.equal(cli('loop-record', '--loop', lf, '--stage', 'generate', '--state', 'no_key', '--cost', '0').state, 'no_key')
})

// ---------- HC round 3 (C1, C2, C3, C5) ----------

test('C1: cost.json with uncertain costs counts spend_limit_usd in the loop', () => {
  const d = folder()
  const f = json(path.join(d, 'cost.json'), { measured_usd: 0.1, spend_limit_usd: 0.25, uncertain_costs: [{ model: 'x', projected_usd: 0.15 }] })
  assert.deepEqual(readCostFromFiles([f]), { cost: 0.25, spend_limit_usd: 0.15, sources: [f] })
  const l = newLoop()
  assert.equal(canStart(l, 'judge', 0.3).ok, true)
  recordStage(l, 'judge', { files: [f] })
  assert.equal(readJson(l.file).spent_usd, 0.25)
  // without spend_limit_usd the measured cost counts
  assert.equal(readCostFromFiles([json(path.join(folder(), 'cost.json'), { measured_usd: 0.1 })]).cost, 0.1)
})

test('C2: loop-can returns the stage cap (min of 3 and the iteration balance), without subtracting the projected cost', () => {
  const l = newLoop()
  assert.deepEqual(canStart(l, 'judge', 0.15), { ok: true, stage_cap_usd: 3, remaining_usd: 9 })
  const m = newLoop()
  runStage(m, 'judge', 3)
  runStage(m, 'recommend', 0)
  runStage(m, 'review', 0)
  runStage(m, 'generate', 3)
  // spent 6: stage cap 3 and balance 3; projected 2 fits and the --cap stays 3 (>= projected)
  const p = canStart(m, 'judge_final', 2)
  assert.deepEqual(p, { ok: true, stage_cap_usd: 3, remaining_usd: 3 })
  assert.ok(p.stage_cap_usd >= 2)
})

test('C3: generation fields from the previous prompt carry over to prompt.json and prompt-revised.json', async () => {
  const previous = JSON.stringify({ text: PREVIOUS, references: ['ref.png'], aspect_ratio: '1:1', resolution: '1K', other: 1 })
  const { text: t, fields } = readPreviousPrompt(previous)
  assert.equal(t, PREVIOUS)
  assert.deepEqual(fields, { references: ['ref.png'], aspect_ratio: '1:1', resolution: '1K' })
  assert.deepEqual(readPreviousPrompt('plain text'), { text: 'plain text', fields: {} })
  assert.throws(() => readPreviousPrompt('{"references":[]}'), /no text field/)
  assert.deepEqual(GENERATION_FIELDS, ['references', 'aspect_ratio', 'resolution', 'duration_s'])
  const out = folder()
  await recommendPrompt({ critiques: CRITIQUES, context: CTX, generator: GENERATOR, previousPrompt: t, generationFields: fields, call: fake(ANSWER), out })
  const pj = path.join(out, 'prompt.json')
  assert.deepEqual(readJson(pj).references, ['ref.png'])
  const r = await applyReview(pj, tally(opinion('a', vote(9, 9, 9)), opinion('b', vote(9, 9, 9))), { call: recompose('NEW') })
  const rev = readJson(path.join(out, 'prompt-revised.json'))
  assert.equal(r.text, ANSWER.prompt)
  for (const [k, v] of Object.entries(fields)) assert.deepEqual(rev[k], v, k)
  // without quorum the text is the previous one and the fields stay
  const noQuorum = await applyReview(pj, tally(opinion('a', vote(9, 9, 9)), opinion('b', null, false), opinion('c', null, false)), { call: recompose(), out: folder() })
  assert.equal(noQuorum.aspect_ratio, '1:1')
})

test('C5: insufficient and none_applied end the iteration, divergence is not a failure; finalists at most 4', () => {
  for (const st of ['insufficient', 'none_applied']) assert.ok(FAILURES.includes(st), st)
  assert.equal(FAILURES.includes('divergence'), false)
  const l = newLoop()
  canStart(l, 'judge', 0.1)
  assert.throws(() => recordStage(l, 'judge', { measured_cost: 0.1, state: 'divergence' }), /loop-chosen/)
  recordStage(l, 'judge', { measured_cost: 0.1, state: 'insufficient' })
  assert.equal(readJson(l.file).state, 'insufficient')
  assert.equal(nextStage(l), null)
  const m = newLoop()
  runStage(m, 'judge', 0.1); runStage(m, 'recommend', 0)
  recordStage(m, 'review', { measured_cost: 0, state: 'none_applied' })
  assert.equal(canStart(m, 'generate', 0.1).ok, false)
  const d = folder(); fs.mkdirSync(d)
  const f = (name) => { const p = path.join(d, name); fs.writeFileSync(p, name); return p }
  // D3: an old one identical to the current (same content) is refused
  const copy = path.join(d, 'copy-of-current.png'); fs.writeFileSync(copy, 'current.png')
  assert.throws(() => recordFinalists(newLoop(), { revised: f('r0.png'), old: copy, current: f('current.png') }), /the current asset itself/)
  const without = recordFinalists(newLoop(), { revised: [f('s1.png'), f('s2.png'), f('s3.png'), f('s4.png')], old: 'none', current: f('current.png') })
  assert.equal(without.finalists.revised_prompt.length, 3)
  assert.equal(without.finalists.old_left_out, 'the current asset won j1')
  const fin = recordFinalists(newLoop(), { revised: [f('r1.png'), f('r2.png'), f('r3.png')], old: f('j1.png'), current: f('current.png') })
  assert.equal(fin.finalists.revised_prompt.length, 2)
  assert.deepEqual(fin.finalists.cut, [path.join(d, 'r3.png')])
})

test('D5: the recommender receives the generator\'s capabilities, price resolution and note', async () => {
  const generator = { ...GENERATOR, capabilities: { accepts_reference: true, max_duration_s: 8 }, price: { usd: 0.1, resolution: '720p' }, note: 'ignores negative prompt' }
  const call = fake(ANSWER)
  const out = folder()
  await recommendPrompt({ critiques: CRITIQUES, context: CTX, generator, previousPrompt: PREVIOUS, call, out })
  const request = JSON.stringify(call.requests[0])
  for (const t of ['accepts_reference=true', 'max_duration_s=8', 'price resolution: 720p', 'note: ignores negative prompt']) assert.ok(request.includes(t), t)
  const g = readJson(path.join(out, 'prompt.json')).generator
  assert.deepEqual([g.capabilities, g.price_resolution, g.note], [generator.capabilities, '720p', 'ignores negative prompt'])
})

test('E1: divergence at j1 goes through the tiebreak on the highest weighted mean; a decision uses the choice; insufficient chooses nothing', async () => {
  const { chosenFromJudging, recordChosen } = await import('./prompt.mjs')
  const build = (decision) => {
    const d = folder(); fs.mkdirSync(path.join(d, 'round'), { recursive: true })
    fs.writeFileSync(path.join(d, 'round/decision.json'), JSON.stringify(decision))
    fs.writeFileSync(path.join(d, 'round/map.json'), JSON.stringify({ letter_to_option: { A: 'option-1', B: 'option-2', C: 'option-3' } }))
    fs.writeFileSync(path.join(d, 'origin.json'), JSON.stringify({ 'option-1': { origin: 'current', file: 'C:/x/current.png' },
      'option-2': { origin: 'generator', model: 'm/two', file: 'C:/x/2.png' }, 'option-3': { origin: 'generator', model: 'm/three', file: 'C:/x/3.png' } }))
    return d
  }
  const div = chosenFromJudging(build({ result: 'divergence', quorum: { ok: true }, weighted: { A: 10, B: 40, C: 52, X: 0 } }))
  assert.deepEqual([div.via, div.option, div.model, div.file], ['tiebreak', 'option-3', 'm/three', 'C:/x/3.png'])
  const tie = chosenFromJudging(build({ result: 'divergence', quorum: { ok: true }, weighted: { A: 0, B: 40, C: 40 } }))
  assert.deepEqual([tie.letter, tie.tie], ['B', ['B', 'C']])
  const dec = chosenFromJudging(build({ result: 'decision', quorum: { ok: true }, original_choice: 'option-1', weighted: { A: 90 } }))
  assert.deepEqual([dec.via, dec.origin], ['decision', 'current'])
  assert.equal(chosenFromJudging(build({ result: 'insufficient', quorum: { ok: true } })).state, 'insufficient')
  const l = newLoop()
  assert.equal(recordChosen(l, build({ result: 'divergence', quorum: { ok: true }, weighted: { A: 1, B: 2, C: 3 } })).chosen_j1.option, 'option-3')
  assert.throws(() => recordChosen(l, build({ result: 'insufficient', quorum: { ok: true } })), /no choice/)
})

test('F1: a file threshold below 7 does not lower the floor; it is recorded in file_threshold', async () => {
  const pj = await recommended()
  const conc = tally(opinion('a', vote(9, 7, 6)), opinion('b', vote(9, 6, 7)))   // means 9, 6.5, 6.5
  conc.threshold = 6
  for (const it of conc.items) it.decision = 'apply'
  const r = await applyReview(pj, conc, { call: recompose('ONLY M1', ['M1']) })
  assert.deepEqual(r.applied.map((m) => m.id), ['M1'])
  assert.deepEqual([r.threshold, r.file_threshold], [7, 6])
})

test('F2: all approved use the voted text without a call; a recomposition with the wrong applied becomes no_recommendation; diff saved', async () => {
  const pj = await recommended()
  const none = recompose()
  const all = await applyReview(pj, tally(opinion('a', vote(9, 8, 8)), opinion('b', vote(9, 8, 8))), { call: none, out: folder() })
  assert.deepEqual([all.state, all.via, all.text, none.requests.length], ['revised', 'recommended_voted', ANSWER.prompt, 0])
  assert.ok(all.diff.added.length > 0)
  const partial = tally(opinion('a', vote(9, 9, 4)), opinion('b', vote(9, 9, 4)))
  const wrong = recompose('TEXT', ['M1', 'M2', 'M3'])
  const r = await applyReview(pj, partial, { call: wrong, out: folder() })
  assert.deepEqual([r.state, r.text, wrong.requests.length], ['no_recommendation', PREVIOUS, 2])
  assert.match(r.reason, /applied must be exactly M1,M2/)
  const right = await applyReview(pj, partial, { call: recompose('ADJUSTED PREVIOUS', ['M2', 'M1']), out: folder() })
  assert.deepEqual([right.state, right.via, right.text], ['revised', 'recomposed', 'ADJUSTED PREVIOUS'])
  assert.deepEqual(right.diff.added, ['ADJUSTED PREVIOUS'])
})

test('F5: divergence is refused as a state at judge and judge_final (closes as ok); insufficient still ends judge_final', () => {
  const l = newLoop()
  canStart(l, 'judge', 0.1)
  assert.throws(() => recordStage(l, 'judge', { measured_cost: 0.1, state: 'divergence' }), /record judge as ok/)
  runStage(l, 'judge', 0.1); runStage(l, 'recommend', 0); runStage(l, 'review', 0); runStage(l, 'generate', 0.1)
  assert.throws(() => recordStage(l, 'judge_final', { measured_cost: 0.1, state: 'divergence' }), /record judge_final as ok and run loop-winner/)
  assert.equal(readJson(l.file).state, 'in_progress')
  recordStage(l, 'judge_final', { measured_cost: 0.1, state: 'insufficient' })
  assert.equal(readJson(l.file).state, 'insufficient')
})

test('E2: divergence at judge_final replaces the current asset with the one with the highest mean if it beats the current one; otherwise the current stays', async () => {
  const { finalJudgingWinner, recordFinalWinner } = await import('./prompt.mjs')
  // A = current (option-1), B and C = g2 candidates; scores_by_category per letter, as in the council's decision.json.
  const build = (decision) => {
    const d = folder(); fs.mkdirSync(path.join(d, 'round'), { recursive: true })
    fs.writeFileSync(path.join(d, 'round/decision.json'), JSON.stringify({ quorum: { ok: true }, ...decision }))
    fs.writeFileSync(path.join(d, 'round/map.json'), JSON.stringify({ letter_to_option: { A: 'option-1', B: 'option-2', C: 'option-3' } }))
    fs.writeFileSync(path.join(d, 'origin.json'), JSON.stringify({ 'option-1': { origin: 'current', file: 'C:/x/current.png' },
      'option-2': { origin: 'generator', model: 'm/two', file: 'C:/x/2.png' }, 'option-3': { origin: 'generator', model: 'm/three', file: 'C:/x/3.png' } }))
    return d
  }
  const scores = (a, b, c) => ({ A: { x: a[0], y: a[1] }, B: { x: b[0], y: b[1] }, C: { x: c[0], y: c[1] } })
  const div = (n) => build({ result: 'divergence', weighted: { A: 30, B: 30, C: 30, X: 0 }, scores_by_category: n })

  // a candidate above the current one: swap (even if the current one has more votes, the category mean decides)
  const swap = finalJudgingWinner(div(scores([6, 6], [7, 9], [5, 5])))
  assert.deepEqual([swap.state, swap.via, swap.option, swap.origin, swap.model, swap.file, swap.mean, swap.current_mean],
    ['ok', 'tiebreak', 'option-2', 'generator', 'm/two', 'C:/x/2.png', 8, 6])
  // between two candidates above the current one, the highest mean wins
  assert.equal(finalJudgingWinner(div(scores([6, 6], [7, 7], [8, 9]))).option, 'option-3')

  // current ahead: the current stays
  const stays = finalJudgingWinner(div(scores([8, 9], [7, 7], [6, 8])))
  assert.deepEqual([stays.via, stays.origin, stays.option, stays.file, stays.mean], ['current', 'current', 'option-1', 'C:/x/current.png', 8.5])

  // exact tie with the current: the current stays; tie only among candidates above the current: first letter, recorded
  assert.equal(finalJudgingWinner(div(scores([7, 7], [6, 8], [5, 5]))).via, 'current')
  const tiedCandidates = finalJudgingWinner(div(scores([5, 5], [7, 7], [6, 8])))
  assert.deepEqual([tiedCandidates.via, tiedCandidates.letter, tiedCandidates.tie], ['tiebreak', 'B', ['B', 'C']])

  // normal decision: follows the jury's choice, ignoring the means (even if the current one loses)
  const dec = finalJudgingWinner(build({ result: 'decision', original_choice: 'option-3', scores_by_category: scores([9, 9], [5, 5], [6, 6]) }))
  assert.deepEqual([dec.via, dec.option, dec.origin], ['decision', 'option-3', 'generator'])

  // insufficient chooses nothing; divergence without a score for the current asset or without a current option is an error (no guessing)
  assert.equal(finalJudgingWinner(build({ result: 'insufficient' })).state, 'insufficient')
  assert.throws(() => finalJudgingWinner(div({ B: { x: 9 }, C: { x: 9 } })), /no per-category scores/)

  // recordFinalWinner writes final_winner to loop.json and lets judge_final close as ok
  const l = newLoop()
  for (const e of ['judge', 'recommend', 'review', 'generate']) runStage(l, e, 1)
  recordFinalists(l, finalFiles())
  const r = recordFinalWinner(l, div(scores([6, 6], [7, 9], [5, 5])))
  assert.deepEqual([r.final_winner.via, r.final_winner.option], ['tiebreak', 'option-2'])
  assert.equal(recordStage(l, 'judge_final', { measured_cost: 1 }).state, 'completed')
  assert.equal(readJson(l.file).final_winner.file, 'C:/x/2.png')
  assert.throws(() => recordFinalWinner(newLoop(), build({ result: 'insufficient' })), /no choice/)
})
