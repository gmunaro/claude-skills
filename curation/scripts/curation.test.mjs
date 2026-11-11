// Cheap tests for curation: no paid call. The network is a fake fetch.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { buildJury, message, duration, publishedFor, run, projectedCost, readJury, aggregateScores, juryChanges, scoresPacket, route, callOpenRouter, CURRENT_CLAUDE } from './curation.mjs'
import { execFileSync } from 'node:child_process'
import { contextBlock } from './context.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curation-'))
// Valid 1x1 PNG.
function png(name) {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])
  const f = path.join(tmp, name)
  fs.writeFileSync(f, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))]))
  return f
}
const a = png('a.png')
const b = png('b.png')

const model = (id, input = ['text', 'image'], extra = {}) => ({ id, name: id, architecture: { input_modalities: input, output_modalities: ['text'] },
  pricing: { prompt: '0.000001', completion: '0.000004' }, supported_parameters: ['reasoning'], ...extra })

test('buildJury seats every current Claude and fills up from the benchmark, recording shortfalls', () => {
  const cat = [...Object.keys(CURRENT_CLAUDE).map((id) => model(id)), model('x/one'), model('x/two', ['text', 'image'], { supported_parameters: [] }), model('x/audio', ['text', 'audio'])]
  const scores = { benchmark: { name: 'Bench', version: 'v1', source: 'https://e.x', queried_at: '2026-11-07T00:00:00Z' },
    models: [{ model: 'x/one', value: 90, source: 'https://e.x' }, { model: 'x/two', value: 95, source: 'https://e.x' }, { model: 'x/audio', value: 99, source: 'https://e.x' }] }
  const s = buildJury(cat, scores, 'image', { currentClaude: true })
  assert.deepEqual(s.jury.map((m) => m.model).slice(4), ['x/two', 'x/one'])
  assert.equal(s.jury.length, 6)
  assert.equal(s.jury.find((m) => m.model === 'x/two').effort_note, 'no effort control')
  assert.equal(s.jury.find((m) => m.model === 'x/one').effort, 'medium')
  assert.ok(s.shortfalls.some((f) => f.model === 'x/audio'))
  assert.ok(s.shortfalls.some((f) => /only 6 models/.test(f.reason)))
  assert.equal(s.jury[0].proxy, 'claude-fable-5-1')
})

test('published weight requires the scale of the category benchmark', () => {
  const ok = publishedFor('Arena Vision')
  const i = { value: 1290, scale: 'Arena Vision', version: 'x', queried_at: '2026-11-07T00:00:00Z', source: 'https://arena.ai' }
  assert.equal(ok(i), true)
  assert.equal(ok({ ...i, scale: 'Artificial Analysis Intelligence Index' }), false)
  assert.equal(ok(null), false)
})

test('decision message rotates options and attachments together', () => {
  const input = { question: 'Which capture?', options: [{ id: 'A', text: 'a', media: [a] }, { id: 'B', text: 'b', media: [b] }],
    categories: ['legibility'], evidence: 'facts', mode: 'quick' }
  const r0 = message(input, 'decision', 0)
  const r1 = message(input, 'decision', 1)
  assert.match(r0[1].text, /option A/)
  assert.match(r1[1].text, /option B/)
  assert.equal(r1[2].file, path.resolve(b))
  assert.equal(r0.filter((x) => x.type === 'image').length, 2)
})

// Minimal mp4: ftyp + moov/mvhd version 0 with timescale 1000 and duration 13000 (13 s).
function mp4(name) {
  const box = (t, d) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + d.length); h.write(t, 4); return Buffer.concat([h, d]) }
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(13000, 16)
  const f = path.join(tmp, name)
  fs.writeFileSync(f, Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', box('mvhd', mvhd))]))
  return f
}
// Minimal Ogg Opus: a page with OpusHead and a last page with granule 48000*3 (3 s).
function ogg(name) {
  const page = (granule, payload) => { const h = Buffer.alloc(27); h.write('OggS'); h.writeBigUInt64LE(BigInt(granule), 6); h[26] = 1
    return Buffer.concat([h, Buffer.from([payload.length]), payload]) }
  const f = path.join(tmp, name)
  fs.writeFileSync(f, Buffer.concat([page(0, Buffer.from('OpusHead\x01\x01')), page(48000 * 3, Buffer.alloc(10))]))
  return f
}

test('duration is read from the header of mp4 and ogg files generated in the test', () => {
  assert.ok(Math.abs(duration(mp4('c.mp4')) - 13) < 1e-9)
  assert.ok(Math.abs(duration(ogg('c.ogg')) - 3) < 1e-9)
})

test('projected cost uses the snapshot price and grows with the media', () => {
  const m = { price: { prompt: 1e-6, completion: 4e-6 } }
  const little = projectedCost(m, [{ text: 'x' }])
  const much = projectedCost(m, [{ text: 'x' }, { type: 'image' }, { type: 'image' }])
  assert.ok(much > little)
})

// Fake responses: OpenRouter returns a valid vote with a cost; one model fails; Claude answers through the proxy.
function fakeFetch({ fail = [] } = {}) {
  const vote = { vote: 'A', confidence: 'medium', reasons: ['sharper'], what_would_change_my_vote: 'another capture',
    scores: [{ option: 'A', category: 'legibility', score: 8, gap: 'contrast' }, { option: 'B', category: 'legibility', score: 6, gap: 'small' }] }
  return async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {}
    const ok = (j) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(j), json: async () => j })
    if (url.endsWith('/messages')) return ok({ content: [{ type: 'text', text: JSON.stringify(vote) }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'end_turn' })
    if (fail.includes(body.model)) return { ok: false, status: 400, headers: new Headers(), text: async () => '{"error":{"message":"model refused"}}' }
    return ok({ id: 'gen', choices: [{ message: { content: JSON.stringify(vote) }, finish_reason: 'stop' }], usage: { cost: 0.01 } })
  }
}

test('run (image, simulated): collection in the council format, failure listed without a substitute, measured cost and table', async () => {
  const snap = readJury('image')
  const catalog = snap.jury.map((m) => model(m.model))
  const input = { question: 'Which capture should we use?', options: [{ id: 'A', text: 'large', media: [a] }, { id: 'B', text: 'small', media: [b] }],
    categories: ['legibility'], evidence: 'two captures of the same screen', mode: 'quick' }
  const out = path.join(tmp, 'round')
  const failing = snap.jury.find((m) => !m.proxy).model
  const r = await run({ category: 'image', input, out, cap: 3, fetchFn: fakeFetch({ fail: [failing] }), catalog })
  assert.equal(r.planned, snap.jury.length)
  assert.equal(r.valid, snap.jury.length - 1)
  const collection = JSON.parse(fs.readFileSync(path.join(out, 'collection.json'), 'utf8'))
  assert.match(collection.entries.find((e) => e.model === failing).status, /^failed: HTTP 400/)
  assert.equal(r.result.result, 'decision')
  assert.equal(r.result.choice, 'A')
  const paid = collection.entries.filter((e) => e.route === 'openrouter' && e.admitted).length
  assert.ok(Math.abs(r.cost.measured_usd - 0.01 * paid) < 1e-9)
  assert.ok(collection.entries.filter((e) => e.route === 'proxy-claude').length === 4)
  const html = fs.readFileSync(path.join(out, 'table.html'), 'utf8')
  assert.match(html, /Arena Vision/)
  assert.match(html, /Route/)
  await assert.rejects(() => run({ category: 'image', input, out, cap: 3, fetchFn: fakeFetch(), catalog }), /new folder/)
})

test('run rejects a projected cost above the cap before calling any juror', async () => {
  const snap = readJury('image')
  const catalog = snap.jury.map((m) => model(m.model, ['text', 'image'], { pricing: { prompt: '0.01', completion: '0.01' } }))
  const input = { question: 'Which?', options: [{ id: 'A', text: 'a', media: [a] }, { id: 'B', text: 'b', media: [b] }], categories: ['c'], evidence: 'e' }
  let calls = 0
  const f = async (...x) => { calls++; return fakeFetch()(...x) }
  await assert.rejects(() => run({ category: 'image', input, out: path.join(tmp, 'expensive'), cap: 0.5, fetchFn: f, catalog }), /exceeds cap/)
  assert.equal(calls, 4, 'only the Claude probes (no cost) ran')
})

test('aggregateScores weights by category and ignores invalid reviews', () => {
  const ind = (v) => ({ value: v, scale: 'B', version: '1', queried_at: '2026-11-07T00:00:00Z', source: 'https://e.x' })
  const rev = (n) => ({ overall_score: n, scores: [{ category: 'c', score: n, gap: 'x' }], fix_points: [] })
  const entries = [{ model: 'm1', index: ind(3), admitted: true, review: rev(9), status: 'valid' },
    { model: 'm2', index: ind(1), admitted: true, review: rev(5), status: 'valid' },
    { model: 'm3', index: ind(5), admitted: false, review: null, status: 'failed: x' }]
  const r = aggregateScores(entries, ['c'], { published: publishedFor('B') })
  assert.equal(r.overall_mean, 8)
  assert.equal(r.by_category.c, 8)
  assert.equal(r.quorum.ok, true)
  assert.equal(r.discarded.failed, 1)
})

// Fake fetch with a configurable response per model; counts calls per model.
function fetchWith(response, { cost = 0.01, counts = {} } = {}) {
  return async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {}
    const ok = (j) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(j), json: async () => j })
    counts[body.model] = (counts[body.model] ?? 0) + 1
    const txt = typeof response === 'function' ? response(body.model, counts[body.model]) : JSON.stringify(response)
    if (url.endsWith('/messages')) return ok({ content: [{ type: 'text', text: txt }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'end_turn' })
    return ok({ id: 'gen', choices: [{ message: { content: txt }, finish_reason: 'stop' }], usage: { cost } })
  }
}
const voteA = { vote: 'A', confidence: 'medium', reasons: ['x'], what_would_change_my_vote: 'y',
  scores: [{ option: 'A', category: 'legibility', score: 8, gap: 'f' }, { option: 'B', category: 'legibility', score: 6, gap: 'f' }] }

test('run in scores mode: player context label, weighted mean and fix points', async () => {
  const snap = readJury('image')
  const catalog = snap.jury.map((m) => model(m.model))
  const input = { objective: 'Score the portrait.', context: 'Canon: ancestral raven.', categories: ['reading', 'style'], media: [a] }
  assert.match(scoresPacket(input), /## Player context\n\nCanon: ancestral raven\./)
  const review = { overall_score: 6, scores: [{ category: 'reading', score: 6, gap: 'contrast' }, { category: 'style', score: 7, gap: 'palette' }],
    fix_points: [{ problem: 'weak silhouette', fix: 'increase the contrast' }] }
  const r = await run({ category: 'image', input, out: path.join(tmp, 'scores'), cap: 3, mode: 'scores', fetchFn: fetchWith(review), catalog })
  assert.equal(r.valid, snap.jury.length)
  assert.equal(r.result.overall_mean, 6)
  assert.equal(r.result.by_category.style, 7)
  assert.equal(r.result.fix_points.length, snap.jury.length)
  assert.ok(fs.existsSync(path.join(tmp, 'scores', 'scores.json')))
})

test('run in vote mode: agreement per item', async () => {
  const snap = readJury('image')
  const catalog = snap.jury.map((m) => model(m.model))
  const items = [{ id: 'V1', section: 's', problem: 'p', fix: 'c' }, { id: 'V2', section: 's', problem: 'p2', fix: 'c2' }]
  const vote = { votes: [{ id: 'V1', agreement: 9, reason: 'fixes it' }, { id: 'V2', agreement: 3, reason: 'makes it worse' }] }
  const input = { artifact: 'generation prompt', media: [a] }
  const r = await run({ category: 'image', input, out: path.join(tmp, 'votes'), cap: 3, mode: 'vote', items, fetchFn: fetchWith(vote), catalog })
  assert.equal(r.valid, snap.jury.length)
  assert.ok(fs.existsSync(path.join(tmp, 'votes', 'agreement.json')))
  assert.match(JSON.stringify(r.result), /V1/)
})

test('resend of an invalid JSON happens when it fits under the cap (without counting the projected cost twice)', async () => {
  const snap = readJury('image')
  const paid = snap.jury.find((m) => !m.proxy).model
  // Only one paid juror in the catalog, at a high price; the other paid ones leave the catalog.
  const catalog = snap.jury.filter((m) => m.proxy || m.model === paid)
    .map((m) => model(m.model, ['text', 'image'], m.model === paid ? { pricing: { prompt: '0.0001', completion: '0.0004' } } : {}))
  const input = { question: 'Which?', options: [{ id: 'A', text: 'a', media: [a] }, { id: 'B', text: 'b', media: [b] }], categories: ['legibility'], evidence: 'e' }
  const est = await run({ category: 'image', input, out: path.join(tmp, 'est'), cap: 3, estimateOnly: true, catalog })
  assert.ok(est.projected_usd > 0.01)
  const counts = {}
  const resp = (model, n) => (model === paid && n === 1 ? '{"vote":' : JSON.stringify(voteA))
  await run({ category: 'image', input, out: path.join(tmp, 'resend'), cap: est.projected_usd + 1e-4, fetchFn: fetchWith(resp, { cost: 0, counts }), catalog })
  assert.equal(counts[paid], 2, 'the resend ran')
  const collection = JSON.parse(fs.readFileSync(path.join(tmp, 'resend', 'collection.json'), 'utf8'))
  assert.equal(collection.entries.find((e) => e.model === paid).status, 'valid')
})

test('estimate-only does not probe Claude, separates the paid cost from the subscription equivalent and records jury changes', async () => {
  const snap = readJury('image')
  const catalog = snap.jury.map((m) => model(m.model))
  let calls = 0
  const input = { question: 'Which?', options: [{ id: 'A', text: 'a', media: [a] }, { id: 'B', text: 'b', media: [b] }], categories: ['c'], evidence: 'e' }
  const est = await run({ category: 'image', input, out: path.join(tmp, 'only'), cap: 3, estimateOnly: true, fetchFn: async () => { calls++ }, catalog })
  assert.equal(calls, 0)
  assert.ok(est.by_juror.filter((j) => j.route === 'proxy-claude').length >= 1)
  assert.ok(est.claude_subscription_equivalent_usd > 0)
  assert.ok('jury_changes' in est)
})

test('juryChanges: a model that stops answering in text leaves, with a warning', () => {
  const snap = readJury('image')
  const catalog = snap.jury.map((m) => model(m.model))
  assert.equal(juryChanges(snap, catalog, 'image').checked, true)
  const leaves = snap.jury.find((m) => !m.proxy).model
  const noText = catalog.map((m) => (m.id === leaves ? { ...m, architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] } } : m))
  const r = juryChanges(snap, noText, 'image')
  assert.ok(r.left.includes(leaves))
  assert.match(r.warning, /build-jury/)
})

test('anonymous decision: letters drawn with a seed, map outside the packet, context with sha and rejection of text that reveals the current one', async () => {
  const snap = readJury('image')
  const catalog = snap.jury.map((m) => model(m.model))
  const context0 = { media: 'image', subtype: null, name: 'Test', fields: { canon: { text: 'Ancestral raven.', source: { file: 'target.json', sha256: 'f'.repeat(64), excerpt: 'canon' } } } }
  const context = { ...context0, sha256: createHashSha(contextBlock(context0)) }
  const input = { question: 'Which?', options: [{ id: 'new', text: 'portrait one', media: [a] }, { id: 'old', text: 'portrait two', media: [b] }], categories: ['legibility'], evidence: 'e' }
  const out = path.join(tmp, 'anon')
  const r = await run({ category: 'image', input, out, cap: 3, fetchFn: fetchWith(voteA), catalog, context, seed: 's1' })
  const map = JSON.parse(fs.readFileSync(path.join(out, 'map.json'), 'utf8'))
  assert.deepEqual(Object.values(map.letter_to_option).sort(), ['new', 'old'])
  assert.equal(r.result.original_choice, map.letter_to_option.A)
  const collection = JSON.parse(fs.readFileSync(path.join(out, 'collection.json'), 'utf8'))
  assert.equal(collection.context_sha256, context.sha256)
  // D2: a context tampered with after build-context is rejected before any call
  const tampered = { ...context, fields: { canon: { ...context.fields.canon, text: 'Raven edited by hand.' } } }
  await assert.rejects(() => run({ category: 'image', input, out: path.join(tmp, 'anon3'), cap: 3, fetchFn: fetchWith(voteA), catalog, context: tampered, seed: 's1' }), /context rejected/)
  assert.deepEqual(collection.options.sort(), ['A', 'B'])
  const packet = message({ ...input, options: [{ id: 'A', text: 'x', media: [a] }, { id: 'B', text: 'y', media: [b] }] }, 'decision').map((x) => x.text ?? '').join('\n')
  assert.doesNotMatch(packet, /\bnew\b|\bold\b/)
  const bad = { ...input, options: [{ id: 'A', text: 'the current portrait', media: [a] }, { id: 'B', text: 'b', media: [b] }] }
  await assert.rejects(() => run({ category: 'image', input: bad, out: path.join(tmp, 'anon2'), cap: 3, fetchFn: fetchWith(voteA), catalog }), /reveals its origin/)
})

test('B8: Claude with a failed probe stays out without --claude-openrouter; with the flag it goes paid and the result warns', async () => {
  const m = { model: 'anthropic/claude-x', proxy: 'claude-x' }
  assert.equal(route(m, { [m.model]: { ok: false, error: 'HTTP 500' } }).route, 'none')
  assert.equal(route(m, { [m.model]: { ok: false, error: 'HTTP 500' } }, { claudeOpenrouter: true }).route, 'openrouter')
  const snap = readJury('image')
  const catalog = snap.jury.map((x) => model(x.model))
  const input = { question: 'Which?', options: [{ id: 'A', text: 'a', media: [a] }, { id: 'B', text: 'b', media: [b] }], categories: ['legibility'], evidence: 'e' }
  // Proxy down: /messages returns 500.
  const base = fetchWith(voteA)
  const noProxy = async (url, init) => (url.endsWith('/messages') ? { ok: false, status: 500, headers: new Headers({ 'retry-after': '0.01' }), text: async () => 'down' } : base(url, init))
  const r = await run({ category: 'image', input, out: path.join(tmp, 'b8'), cap: 3, fetchFn: noProxy, catalog })
  const collection = JSON.parse(fs.readFileSync(path.join(tmp, 'b8', 'collection.json'), 'utf8'))
  const claudes = collection.entries.filter((e) => snap.jury.find((j) => j.model === e.model)?.proxy)
  assert.ok(claudes.length >= 1 && claudes.every((e) => /^none/.test(e.route) && e.cost_usd === 0))
  assert.ok(r.result.route_warnings.length === claudes.length)
  const r2 = await run({ category: 'image', input, out: path.join(tmp, 'b8b'), cap: 3, fetchFn: noProxy, catalog, claudeOpenrouter: true })
  assert.ok(r2.result.route_warnings.every((x) => x.route === 'openrouter'))
  assert.equal(r2.valid, snap.jury.length)
})

test('B13: a paid call is not resent after a network error; a 503 with a response is resent', async () => {
  let n = 0
  const network = async () => { n++; throw new Error('socket hang up') }
  const r = await callOpenRouter({ model: 'x/y' }, [{ text: 'hi' }], { fetchFn: network })
  assert.equal(n, 1)
  assert.equal(r.uncertain_cost, true)
  let k = 0
  const ok = { id: 'g', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { cost: 0.01 } }
  const f503 = async () => (++k === 1 ? { ok: false, status: 503, headers: new Headers({ 'retry-after': '0.01' }), text: async () => 'busy' }
    : { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(ok) })
  const r2 = await callOpenRouter({ model: 'x/y' }, [{ text: 'hi' }], { fetchFn: f503 })
  assert.equal(k, 2)
  assert.equal(r2.text, 'ok')
  assert.equal(r2.attempts.length, 2)
})

test('B13: uncertain cost goes into the spend_limit_usd of cost.json', async () => {
  const snap = readJury('image')
  const catalog = snap.jury.map((x) => model(x.model))
  const paid = snap.jury.find((x) => !x.proxy).model
  const base = fetchWith(voteA)
  const f = async (url, init) => (JSON.parse(init?.body ?? '{}').model === paid ? Promise.reject(new Error('timeout')) : base(url, init))
  const input = { question: 'Which?', options: [{ id: 'A', text: 'a', media: [a] }, { id: 'B', text: 'b', media: [b] }], categories: ['legibility'], evidence: 'e' }
  await run({ category: 'image', input, out: path.join(tmp, 'b13'), cap: 3, fetchFn: f, catalog })
  const cost = JSON.parse(fs.readFileSync(path.join(tmp, 'b13', 'cost.json'), 'utf8'))
  assert.deepEqual(cost.uncertain_costs, [paid])
  assert.ok(cost.spend_limit_usd > cost.measured_usd)
})

test('B2: build-context writes context.json and context.block.txt with the same sha', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'game-'))
  fs.mkdirSync(path.join(root, 'docs/v3'), { recursive: true }); fs.mkdirSync(path.join(root, 'game/assets'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs/v3/ART_DIRECTION.md'), ['1', '3', '4', '5', '6', '7'].map((n) => `## ${n}. Section ${n}\n\ntext ${n}\n`).join('\n'))
  fs.writeFileSync(path.join(root, 'game/assets/palette.json'), JSON.stringify({ name: 'p', colors: Array.from({ length: 32 }, (_, i) => `#${String(i).padStart(6, '0')}`) }))
  fs.copyFileSync(a, path.join(root, 'sprite.png'))
  const target = path.join(root, 'target.json')
  fs.writeFileSync(target, JSON.stringify({ media: 'image', name: 'Test', appears_in: { screen: 'fight', size_px: [128, 128], moment: 'boss' }, current_asset: 'sprite.png', canon: 'Raven.' }))
  const out = path.join(root, 'ctx', 'context.json')
  execFileSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'curation.mjs'), 'build-context', '--target', target, '--root', root, '--out', out])
  const c = JSON.parse(fs.readFileSync(out, 'utf8'))
  const block = fs.readFileSync(path.join(root, 'ctx', 'context.block.txt'), 'utf8')
  assert.equal(createHashSha(block), c.sha256)
  assert.doesNotMatch(block, /sprite\.png/)
})
import { createHash } from 'node:crypto'
function createHashSha(t) { return createHash('sha256').update(t).digest('hex') }

test('B1: candidates from generate go through for-judging and enter run without revealing the origin', async () => {
  const { forJudging } = await import('./generation.mjs')
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cand-'))
  const c1 = path.join(folder, '01-openai_gpt-image-2.5-sunburst.png'); fs.copyFileSync(a, c1)
  const c2 = path.join(folder, '02-openai_gpt-image-2.6-sunburst.png'); fs.writeFileSync(c2, Buffer.concat([fs.readFileSync(b), Buffer.from([0])]))
  const cand = path.join(folder, 'candidates.json')
  fs.writeFileSync(cand, JSON.stringify({ state: 'ok', candidates: [
    { model: 'openai/gpt-image-2.5-sunburst', state: 'ok', file: c1, measured_cost: 0.03 },
    { model: 'openai/gpt-image-2.6-sunburst', state: 'ok', file: c2, measured_cost: 0.03 }] }))
  const current = path.join(folder, 'boss_current.png'); fs.writeFileSync(current, Buffer.concat([fs.readFileSync(b), Buffer.from([1])]))
  const judgeOut = path.join(folder, 'judge')
  await forJudging({ candidates: cand, current, out: judgeOut, question: 'Which version should we use?', categories: ['legibility', 'fidelity'] })
  const input = JSON.parse(fs.readFileSync(path.join(judgeOut, 'input.json'), 'utf8'))
  assert.equal(input.options.length, 3)
  const origin = JSON.parse(fs.readFileSync(path.join(judgeOut, 'origin.json'), 'utf8'))
  assert.deepEqual(Object.values(origin).filter((o) => o.origin === 'generator').map((o) => o.model).sort(),
    ['openai/gpt-image-2.5-sunburst', 'openai/gpt-image-2.6-sunburst'])
  const snap = readJury('image')
  const catalog = snap.jury.map((x) => model(x.model))
  const vote = (m, n) => JSON.stringify({ vote: 'A', confidence: 'medium', reasons: ['x'], what_would_change_my_vote: 'y',
    scores: ['A', 'B', 'C'].flatMap((o) => ['legibility', 'fidelity'].map((category) => ({ option: o, category, score: 7, gap: 'f' }))) })
  const r = await run({ category: 'image', input, out: path.join(judgeOut, 'round'), cap: 3, fetchFn: fetchWith(vote), catalog })
  assert.equal(r.valid, snap.jury.length)
  assert.ok(r.result.original_choice)
})

test('C4: for-judging merges candidates from several generations and loose files', async () => {
  const { forJudging } = await import('./generation.mjs')
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cand4-'))
  const one = (name, bytes) => { const f = path.join(folder, name); fs.writeFileSync(f, bytes); return f }
  const g1 = path.join(folder, 'g1.json'); const g2 = path.join(folder, 'g2.json')
  fs.writeFileSync(g1, JSON.stringify({ candidates: [{ model: 'x/one', state: 'ok', file: one('a.png', Buffer.from('a')) }] }))
  fs.writeFileSync(g2, JSON.stringify({ candidates: [{ model: 'x/two', state: 'ok', file: one('b.png', Buffer.from('b')) },
    { model: 'x/three', state: 'failed', file: null }] }))
  const r = forJudging({ candidates: [g1, g2], files: [one('j1.png', Buffer.from('c'))], current: one('current.png', Buffer.from('d')), out: path.join(folder, 'j'), categories: ['a', 'b'] })
  assert.equal(r.input.options.length, 4)
  assert.deepEqual(Object.values(r.origin).map((o) => o.origin).sort(), ['current', 'file', 'generator', 'generator'])
  assert.throws(() => forJudging({ candidates: [g1, g2], files: [one('e.png', Buffer.from('e')), one('f.png', Buffer.from('f'))],
    current: one('current2.png', Buffer.from('g')), out: path.join(folder, 'k') }), /accepts 2 to 4/)
})

test('D1: run rejects a cap that is not a finite number greater than zero', async () => {
  for (const cap of [NaN, 0, -1, Infinity, undefined]) {
    await assert.rejects(run({ category: 'image', input: {}, out: path.join(tmp, 'd1'), cap, estimateOnly: true, catalog: [] }), /invalid cap/, String(cap))
  }
})
