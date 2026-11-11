// Generation tests: no paid or network calls. fetch and ffmpeg are simulated.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { buildGenerators, generate, projectedCost, readGenerators, forJudging, resolveVideoPrice, topItem } from './generation.mjs'
import { checkOptionsText } from './context.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-'))
const folder = (name) => path.join(tmp, name)
const sha = (b) => createHash('sha256').update(b).digest('hex')

// ---------- buildGenerators ----------

const cat = (id, out = ['image', 'text'], pricing = {}) => ({ id, name: id, architecture: { output_modalities: out }, pricing })
const rk = (model, extra = {}) => ({ model, name: model, score: 1000, source: `https://rank/${model}`, price: { estimated_per_image_usd: 0.03, how_calculated: 'x' }, ...extra })
const ranking = (models, extra = {}) => ({ category: 'image', benchmark: { name: 'Arena', version: 'v1', source: 'https://rank', queried_at: '2026-11-07' },
  identity_checked: { checked: true, source: 'https://rank', date: '2026-11-07' }, models, ...extra })
const NOW = '2026-11-08T00:00:00.000Z'

test('top = ranking ∩ catalog, in ranking order, up to 3, never filled with a model from outside the ranking', () => {
  const r = ranking(['a/one', 'b/two', 'c/three', 'd/four', 'e/five', 'f/six'].map((m) => rk(m)))
  const catalog = [cat('f/six'), cat('e/five'), cat('d/four'), cat('c/three'), cat('z/outside-ranking'), cat('b/two', ['text'])]
  const g = buildGenerators(catalog, r, 'image', { now: NOW })
  assert.deepEqual(g.top.map((x) => x.model), ['c/three', 'd/four', 'e/five'])
  assert.deepEqual(g.top.map((x) => x.position), [3, 4, 5])
  assert.equal(g.state, 'ok')
  assert.ok(!g.top.some((x) => x.model === 'z/outside-ranking'))
  assert.deepEqual(g.absent_from_catalog.map((x) => x.model), ['a/one', 'b/two'])
  assert.match(g.absent_from_catalog[1].reason, /catalog has no image output/)
  const t = g.top[0]
  assert.equal(t.benchmark, 'Arena')
  assert.equal(t.source, 'https://rank/c/three')
  assert.equal(t.date, '2026-11-07')
  assert.deepEqual([t.price.unit, t.price.usd], ['image', 0.03])
  assert.deepEqual(g.entered, ['c/three', 'd/four', 'e/five'])
})

test('entered and left compare against the previous build', () => {
  const r = ranking(['a/one', 'b/two', 'c/three', 'd/four'].map((m) => rk(m)))
  const before = buildGenerators([cat('a/one'), cat('b/two'), cat('c/three')], r, 'image', { now: NOW })
  const current = buildGenerators([cat('b/two'), cat('c/three'), cat('d/four')], r, 'image', { now: NOW, previous: before })
  assert.deepEqual(current.entered, ['d/four'])
  assert.deepEqual(current.left, ['a/one'])
})

test('image: measured price beats the catalog price, which beats the ranking estimate', () => {
  const r = ranking([rk('a/measured', { price: { measured_usd: 0.04, estimated_per_image_usd: 0.9 } }), rk('b/catalog', { price: { estimated_per_image_usd: 0.9 } }),
    rk('c/estimated', { price: { estimated_per_image_usd: 0.05 } })])
  const g = buildGenerators([cat('a/measured'), cat('b/catalog', ['image'], { image_output: '0.00003' }), cat('c/estimated')], r, 'image')
  assert.deepEqual(g.top.map((x) => x.price.usd), [0.04, 0.0336, 0.05])
  assert.match(g.top[1].price.origin, /catalog/)
})

test('video with no per-second price (tokens only) stays out of the top, with no substitute', () => {
  const v = (model, usd) => rk(model, { price: { per_second_usd: usd, how_calculated: usd ? 'SKU' : 'SKU priced per token only' } })
  const r = { ...ranking([v('alibaba/wan-3.0', 0.1), v('bytedance/seedance-2.5', null), v('minimax/hailuo-3-max', 0.08), v('bfl/flux-3-video', 0.17)]), category: 'video' }
  const g = buildGenerators(['alibaba/wan-3.0', 'bytedance/seedance-2.5', 'minimax/hailuo-3-max', 'bfl/flux-3-video'].map((id) => cat(id, ['video'])), r, 'video')
  assert.deepEqual(g.top.map((x) => x.model), ['alibaba/wan-3.0', 'minimax/hailuo-3-max'])
  assert.deepEqual(g.no_estimate.map((x) => x.model), ['bytedance/seedance-2.5'])
  assert.match(g.no_estimate[0].reason, /per token only/)
  assert.equal(g.top[0].price.unit, 'second')
})

test('unchecked identity or an empty intersection leaves the category judging_only', () => {
  const unchecked = ranking([rk('a/one')], { identity_checked: undefined })
  const g1 = buildGenerators([cat('a/one')], unchecked, 'image')
  assert.equal(g1.state, 'judging_only')
  assert.equal(g1.reason, 'identity_unchecked')
  assert.equal(g1.top.length, 1)
  const g2 = buildGenerators([cat('other/model')], ranking([rk('a/one')]), 'image')
  assert.deepEqual([g2.state, g2.reason, g2.top.length], ['judging_only', 'empty_intersection', 0])
  assert.throws(() => buildGenerators([], { ...ranking([rk('a/one')]), category: 'video' }, 'image'), /cannot be used/)
})

test('audio by subtype: music per track, speech per character; a per-token-only price stays without an estimate', () => {
  const bench = { name: 'AA', version: 'v', source: 'https://aa', queried_at: '2026-11-07' }
  const audio = { category: 'audio', subtypes: {
    music: { benchmark: bench, identity_checked: true, models: [{ model: 'google/lyria-3-pro-preview', score: { instrumental: 1080 }, source: 'f', price: { per_track_usd: 0.08 } }] },
    speech: { benchmark: bench, identity_checked: true, models: [
      { model: 'el/v4', score: 1339, source: 'f', price: { how_calculated: 'US$ 0,00008 per character of input, from the list' } },
      { model: 'g/tts', score: 1283, source: 'f', price: { how_calculated: 'Per token: US$ 0,0000005 of input. Charged per token, not per character' } },
      { model: 'f/drama', score: 1275, source: 'f', price: { how_calculated: 'US$ 0,000002 per character from the list' } }] } } }
  const catalog = [cat('google/lyria-3-pro-preview', ['text', 'audio']), cat('el/v4', ['speech']), cat('g/tts', ['speech']), cat('f/drama', ['speech'])]
  const m = buildGenerators(catalog, audio, 'music')
  assert.deepEqual([m.state, m.top[0].price.unit, m.top[0].price.usd], ['ok', 'track', 0.08])
  assert.ok(m.top[0].limits.some((l) => /wav returns an empty stream/.test(l)))
  assert.ok(m.top[0].limits.some((l) => /104/.test(l)))
  const f = buildGenerators(catalog, audio, 'speech')
  assert.deepEqual(f.top.map((x) => [x.model, x.price.usd, x.price.unit]), [['el/v4', 0.00008, 'character'], ['f/drama', 0.000002, 'character']])
  assert.deepEqual(f.no_estimate.map((x) => x.model), ['g/tts'])
  assert.deepEqual([f.state, f.reason], ['judging_only', 'no_verified_route'])
})

test('D16: image uses the largest measured cost when there is one and says where it came from', () => {
  const measured = [{ usd: 0.023, file: 'g1/candidates.json', date: '2026-11-08' }, { usd: 0.0646, file: 'g2/candidates.json', date: '2026-11-08' }]
  const g = buildGenerators([cat('a/measured', ['text', 'image'], { image_output: '0.00003' })], ranking([rk('a/measured', { price: { measured } })]), 'image')
  assert.equal(g.top[0].price.usd, 0.0646)
  assert.match(g.top[0].price.origin, /largest of 2: g2\/candidates\.json/)
  assert.equal(projectedCost(g.top[0], 'image', { text: 'x' }), 0.0646)
  const d = readGenerators('image')
  for (const x of d.top) assert.ok(x.price.measured?.length >= 2, x.model)
})

test("Omni 1.2's limits are recorded on the generator", () => {
  const r = { ...ranking([rk('google/gemini-omni-1.2-flash', { price: { per_second_usd: 0.069504 } })]), category: 'video' }
  const g = buildGenerators([cat('google/gemini-omni-1.2-flash', ['text', 'video'])], r, 'video')
  assert.equal(g.top[0].price.usd, 0.069504)
  assert.ok(g.top[0].limits.some((l) => /generate_audio/.test(l)))
  assert.ok(g.top[0].limits.some((l) => /640x360/.test(l)))
})

test('saved data/generators-*.json files have the expected shape', () => {
  for (const c of ['image', 'video']) {
    const d = readGenerators(c)
    assert.equal(d.category, c)
    assert.match(d.catalog.queried_at, /^2026-/)
    assert.ok(['ok', 'judging_only'].includes(d.state))
    assert.ok(d.top.length <= 3)
  }
  assert.ok(readGenerators('music').top.every((g) => g.price.unit === 'track'))
  assert.equal(readGenerators('speech').category, 'speech')
})

// ---------- pre-checks ----------

// ---------- generate: network simulation ----------

const g = (model, usd, position = 1) => ({ model, position, price: { unit: 'x', usd } })
const list = (...tops) => ({ state: 'ok', built_at: NOW, top: tops })
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

/** Simulated fetch: `routes` maps "METHOD /path" (without the base) to a function (body, url) → Response. Records the calls. */
function network(routes) {
  const calls = []
  const fetchFn = async (url, init = {}) => {
    const endpoint = url.replace('https://openrouter.ai/api/v1', '')
    const key = `${init.method ?? 'GET'} ${endpoint.split('?')[0]}`
    calls.push({ key, endpoint, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization })
    const route = routes[key]
    if (!route && key === 'GET /models') { calls.pop(); return json({ data: TEST_CATALOG }) }
    if (!route) throw new Error(`route not simulated: ${key}`)
    return route(init.body ? JSON.parse(init.body) : null, endpoint)
  }
  return { fetchFn, calls }
}
const ENV = { OPENROUTER_API_KEY: 'test-key' }
const ALL = ['text', 'image', 'video', 'audio', 'speech']
const TEST_CATALOG = ['a', 'a/one', 'a/wan', 'b/two', 'b/hailuo', 'c/three', 'el/v4', 'google/gemini-omni-1.2-flash', 'google/lyria', 'google/lyria-3-pro-preview', 'google/nano', 'heygen/hg', 'alibaba/wan-3.0', 'minimax/hailuo', 'old/no-field']
  .map((id) => cat(id, ALL))
const prompt = { text: 'a pixel art crow' }

test('no key: exits before any call', async () => {
  const { fetchFn, calls } = network({})
  const r = await generate({ category: 'image', prompt, out: folder('no-key'), fetchFn, env: {}, generators: list(g('a/one', 0.04)) })
  assert.equal(r.state, 'no_key')
  assert.equal(calls.length, 0)
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder('no-key'), 'candidates.json'), 'utf8')).state, 'no_key')
})

test('E3: generate does not require ffmpeg (no generate stage uses it), not even for video', async () => {
  const v = network({})
  const r = await generate({ category: 'video', prompt, estimateOnly: true, fetchFn: v.fetchFn, env: {}, generators: list(g('a/wan', 0.1)) })
  assert.equal(r.state, 'ok')
  assert.equal('ffmpeg' in r.pre_checks, false)
  const i = network({ 'POST /images': () => json({ data: [{ b64_json: PNG.toString('base64') }], usage: { cost: 0.04 } }) })
  const ok = await generate({ category: 'image', prompt, out: folder('img-no-ffmpeg'), fetchFn: i.fetchFn, env: ENV, generators: list(g('a/one', 0.04)) })
  assert.equal(ok.state, 'ok')
  // E6: the prompt used is kept next to candidates.json, to serve as --previous
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder('img-no-ffmpeg'), 'prompt.json'), 'utf8')), prompt)
})

test('video with no access to /videos: no_video_access, and no generation', async () => {
  const { fetchFn, calls } = network({ 'GET /videos/models': () => json({ error: 'nope' }, 403) })
  const r = await generate({ category: 'video', prompt, out: folder('no-videos'), fetchFn, env: ENV, generators: list(g('a/wan', 0.1)) })
  assert.equal(r.state, 'no_video_access')
  assert.deepEqual(calls.map((c) => c.key), ['GET /videos/models'])
})

test('estimate: image per image, video per second (default 7 s), music per track, speech per character', () => {
  assert.equal(projectedCost(g('a', 0.04), 'image', prompt), 0.04)
  assert.equal(projectedCost(g('a', 0.069504), 'video', prompt), 0.486528)
  assert.equal(projectedCost(g('a', 0.069504), 'video', { ...prompt, duration_s: 5 }), 0.34752)
  assert.equal(projectedCost(g('a', 0.08), 'music', prompt), 0.08)
  assert.equal(projectedCost(g('a', 0.00008), 'speech', { text: 'hey world' }), 0.00072)
  assert.equal(projectedCost({ price: { usd: null } }, 'image', prompt), null)
})

test('cut by cap: the first one that goes over and the ones after it drop out, recorded, with no substitute', async () => {
  const r = await generate({ category: 'image', prompt, cap: 0.1, estimateOnly: true, env: {}, fetchFn: network({}).fetchFn,
    generators: list(g('a/one', 0.04, 1), g('b/two', 0.05, 2), g('c/three', 0.02, 3)) })
  assert.equal(r.state, 'ok')
  assert.deepEqual(r.candidates.map((c) => c.model), ['a/one', 'b/two'])
  assert.equal(r.projected_usd, 0.09)
  assert.deepEqual(r.cuts, [{ model: 'c/three', reason: 'cut_by_cap', projected_cost: 0.02, accumulated_before: 0.09 }])
  assert.equal(fs.existsSync(folder('does-not-exist')), false)
})

test('cap_exceeded: not even the 1st fits, nothing is sent', async () => {
  const { fetchFn, calls } = network({})
  const r = await generate({ category: 'image', prompt, cap: 0.03, out: folder('cap-ex'), fetchFn, env: ENV,
    generators: list(g('a/one', 0.04), g('b/two', 0.01, 2)) })
  assert.equal(r.state, 'cap_exceeded')
  assert.equal(calls.length, 0)
  assert.deepEqual(r.cuts.map((c) => c.model), ['a/one', 'b/two'])
  assert.deepEqual(r.candidates, [])
})

test('image happy path: POST /images, file written, sha256 and measured cost', async () => {
  const { fetchFn, calls } = network({ 'POST /images': () => json({ data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.0406 } }) })
  const r = await generate({ category: 'image', prompt: { text: 'crow', aspect_ratio: '3:2' }, cap: 0.2, out: folder('img-ok'), fetchFn, env: ENV,
    generators: list(g('google/nano', 0.0406), g('b/two', 0.05, 2)) })
  assert.equal(r.state, 'ok')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].body, { model: 'google/nano', prompt: 'crow', aspect_ratio: '3:2', resolution: '1K' })
  assert.equal(calls[0].auth, 'Bearer test-key')
  const c = r.candidates[0]
  assert.deepEqual([c.model, c.prompt, c.state, c.error, c.projected_cost, c.measured_cost], ['google/nano', 'crow', 'ok', null, 0.0406, 0.0406])
  assert.ok(fs.readFileSync(c.file).equals(PNG))
  assert.equal(c.sha256, sha(PNG))
  assert.equal(r.measured_usd, 0.0812)
  const saved = JSON.parse(fs.readFileSync(path.join(folder('img-ok'), 'candidates.json'), 'utf8'))
  assert.equal(saved.candidates.length, 2)
  assert.equal(saved.cap, 0.2)
})

/** SSE response cut into chunks of `n` bytes, to prove the parser joins lines split in the middle. */
function sse(events, n) {
  const bytes = new TextEncoder().encode(events.join('\n\n') + '\n\n')
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += n) c.enqueue(bytes.slice(i, i + n)); c.close() } })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('music happy path: chunked SSE, concatenates delta.audio.data to the end, mp3 and cost from usage', async () => {
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.from(Array.from({ length: 60 }, (_, i) => i))])
  const b64 = mp3.toString('base64')
  const parts = [b64.slice(0, 20), b64.slice(20, 44), b64.slice(44)]
  const ev = (o) => `data: ${JSON.stringify(o)}`
  const events = [': OPENROUTER PROCESSING', ev({ id: 'gen-1', choices: [{ delta: { content: 'ok' } }] }), ...parts.map((p) => ev({ id: 'gen-1', choices: [{ delta: { audio: { data: p } } }] })),
    ev({ id: 'gen-1', choices: [], usage: { cost: 0.08 } }), 'data: [DONE]']
  const { fetchFn, calls } = network({ 'POST /chat/completions': () => sse(events, 7) })
  const r = await generate({ category: 'music', prompt: { text: 'battle theme' }, cap: 0.2, out: folder('music-ok'), fetchFn, env: ENV,
    generators: list(g('google/lyria-3-pro-preview', 0.08)) })
  assert.equal(r.state, 'ok')
  assert.deepEqual(calls[0].body, { model: 'google/lyria-3-pro-preview', messages: [{ role: 'user', content: 'battle theme' }], modalities: ['text', 'audio'], stream: true })
  const c = r.candidates[0]
  assert.match(c.file, /\.mp3$/)
  assert.ok(fs.readFileSync(c.file).equals(mp3))
  assert.equal(c.measured_cost, 0.08)
})

test('music with no usage.cost in the stream: cost looked up at /generation; an empty stream is a failure', async () => {
  const ev = (o) => `data: ${JSON.stringify(o)}`
  const b64 = Buffer.from('ID3xxxx').toString('base64')
  const { fetchFn, calls } = network({
    'POST /chat/completions': () => sse([ev({ id: 'gen-9', choices: [{ delta: { audio: { data: b64 } } }] }), 'data: [DONE]'], 11),
    'GET /generation': () => json({ data: { total_cost: 0.0799 } }) })
  const r = await generate({ category: 'music', prompt, cap: 1, out: folder('music-gen'), fetchFn, env: ENV, intervalMs: 0, generators: list(g('google/lyria', 0.08)) })
  assert.equal(r.candidates[0].measured_cost, 0.0799)
  assert.equal(calls[1].endpoint, '/generation?id=gen-9')

  const empty = network({ 'POST /chat/completions': () => sse(['data: {"id":"g","choices":[],"usage":{"cost":0}}', 'data: [DONE]'], 5) })
  const f = await generate({ category: 'music', prompt, cap: 1, out: folder('music-empty'), fetchFn: empty.fetchFn, env: ENV, generators: list(g('google/lyria', 0.08)) })
  assert.equal(f.state, 'zero_candidates')
  assert.deepEqual([f.candidates[0].state, f.candidates[0].error, f.candidates[0].measured_cost], ['failed', 'stream without audio', 0])
})

test('video happy path: POST /videos, polling until done, content download, job cost', async () => {
  const mp4 = Buffer.from('ftypisom-fake-video')
  let polls = 0
  const { fetchFn, calls } = network({
    'GET /videos/models': () => json({ data: [] }),
    'POST /videos': () => json({ id: 'job-1', status: 'pending' }, 202),
    'GET /videos/job-1': () => json(++polls < 3 ? { id: 'job-1', status: 'in_progress' } : { id: 'job-1', status: 'completed', usage: { cost: 0.486528 } }),
    'GET /videos/job-1/content': () => new Response(mp4, { status: 200 }) })
  const r = await generate({ category: 'video', prompt: { text: 'the crow flies' }, cap: 3, out: folder('video-ok'), fetchFn, env: ENV, intervalMs: 0,
    generators: list(g('google/gemini-omni-1.2-flash', 0.069504)) })
  assert.equal(r.state, 'ok')
  assert.equal(r.pre_checks.videos.ok, true)
  const post = calls.find((c) => c.key === 'POST /videos')
  assert.deepEqual(post.body, { model: 'google/gemini-omni-1.2-flash', prompt: 'the crow flies', duration: 7, resolution: '720p', aspect_ratio: '16:9' })
  assert.ok(!('generate_audio' in post.body) && !('frame_images' in post.body))
  assert.equal(polls, 3)
  assert.equal(calls.at(-1).endpoint, '/videos/job-1/content?index=0')
  const c = r.candidates[0]
  assert.equal(c.measured_cost, 0.486528)
  assert.equal(c.sha256, sha(mp4))
  assert.match(c.file, /\.mp4$/)
})

test('failure with no substitute: the generator that failed is recorded and the others go on; an uncharged failure counts 0', async () => {
  let n = 0
  const { fetchFn, calls } = network({ 'POST /images': () => (++n === 1 ? json({ error: { message: 'boom' } }, 500) : json({ data: [{ b64_json: PNG.toString('base64') }], usage: { cost: 0.05 } })) })
  const r = await generate({ category: 'image', prompt, cap: 1, out: folder('failure'), fetchFn, env: ENV,
    generators: list(g('a/one', 0.04), g('b/two', 0.05, 2), g('c/three', 0.05, 3)) })
  assert.equal(r.state, 'ok')
  assert.equal(calls.length, 3)
  assert.deepEqual(r.candidates.map((c) => c.state), ['failed', 'ok', 'ok'])
  assert.match(r.candidates[0].error, /HTTP 500/)
  assert.equal(r.candidates[0].measured_cost, 0)
  assert.equal(r.candidates[0].file, null)
  assert.equal(r.measured_usd, 0.1)
})

test('zero_candidates: all fail, or the category is judging_only', async () => {
  const { fetchFn } = network({ 'POST /images': () => json({ error: 'x' }, 400) })
  const r = await generate({ category: 'image', prompt, cap: 1, out: folder('zero'), fetchFn, env: ENV, generators: list(g('a/one', 0.04), g('b/two', 0.04, 2)) })
  assert.equal(r.state, 'zero_candidates')
  assert.equal(r.candidates.length, 2)
  const jo = await generate({ category: 'image', prompt, out: folder('zero-jo'), fetchFn, env: {}, generators: { state: 'judging_only', reason: 'identity_unchecked', top: [g('a/one', 0.04)] } })
  assert.equal(jo.state, 'zero_candidates')
  assert.equal(jo.reason, 'identity_unchecked')
  assert.equal(jo.candidates.length, 0)
})

test('exceeded deadline becomes a failure with no substitute, with the unknown cost counted as the projected one', async () => {
  const { fetchFn } = network({
    'GET /videos/models': () => json({ data: [] }),
    'POST /videos': () => json({ id: 'job-2', status: 'pending' }, 202),
    'GET /videos/job-2': () => json({ id: 'job-2', status: 'in_progress' }) })
  const r = await generate({ category: 'video', prompt, cap: 2, out: folder('deadline'), fetchFn, env: ENV, deadlineMs: 40, intervalMs: 5,
    generators: list(g('a/wan', 0.07), g('b/hailuo', 0.07, 2)) })
  assert.equal(r.state, 'zero_candidates')
  assert.match(r.candidates[0].error, /deadline/)
  assert.equal(r.candidates[0].measured_cost, null)
  assert.equal(r.unknown_costs, 2)
})

test('during the round, measured + projected over the cap blocks the next call', async () => {
  const { fetchFn, calls } = network({ 'POST /images': () => json({ data: [{ b64_json: PNG.toString('base64') }], usage: { cost: 0.09 } }) })
  const r = await generate({ category: 'image', prompt, cap: 0.1, out: folder('cap-during'), fetchFn, env: ENV,
    generators: list(g('a/one', 0.04), g('b/two', 0.04, 2)) })
  assert.equal(calls.length, 1)
  assert.deepEqual(r.candidates.map((c) => c.state), ['ok', 'not_started'])
  assert.match(r.candidates[1].error, /cap/)
  assert.equal(r.measured_usd, 0.09)
})

test('an output folder already used is refused and speech has no verified route', async () => {
  const dir = folder('used')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'candidates.json'), '{}')
  await assert.rejects(() => generate({ category: 'image', prompt, out: dir, env: ENV, generators: list(g('a/one', 0.04)) }), /new folder/)
  const r = await generate({ category: 'speech', prompt, out: folder('speech'), cap: 1, fetchFn: network({}).fetchFn, env: ENV, generators: list(g('el/v4', 0.00008)) })
  assert.equal(r.state, 'zero_candidates')
  assert.equal(r.reason, 'no_verified_route')
  assert.equal(r.candidates.length, 0)
  assert.equal(r.projected_usd, 0)
  assert.deepEqual([readGenerators('speech').state, readGenerators('speech').reason], ['judging_only', 'no_verified_route'])
})

// ---------- B9: per-second price at the SKU's resolution ----------

test('build video: writes the SKU resolution and the other per-resolution prices from the ranking into the top', () => {
  const v = (model, usd, resolution) => rk(model, { price: { per_second_usd: usd, resolution, how_calculated: 'SKU' } })
  const r = { ...ranking([v('alibaba/wan-3.0', 0.1, '720p (480p 0.05; 1080p 0.20)'), v('heygen/hg', 0.1, '1080p (480p 0.02; 768p 0.036; 2K 0.10)'),
    v('minimax/hailuo', 0.08, '768p (480p 0.05)')]), category: 'video' }
  const g3 = buildGenerators(['alibaba/wan-3.0', 'heygen/hg', 'minimax/hailuo'].map((id) => cat(id, ['video'])), r, 'video')
  const [wan, hey, hai] = g3.top
  assert.deepEqual([wan.price.resolution, hey.price.resolution, hai.price.resolution], ['720p', '1080p', '768p'])
  assert.deepEqual(wan.price.by_resolution, { '720p': 0.1, '480p': 0.05, '1080p': 0.2 })
  assert.equal(hey.price.by_resolution['2K'], 0.1)
  // a list with no prices ("480p, 720p") or a missing field is not a SKU resolution: nothing is written
  const bare = { ...ranking([rk('s/list', { price: { per_second_usd: 0.07, resolution: '480p, 720p' } }), rk('s/missing', { price: { per_second_usd: 0.07 } })]), category: 'video' }
  const gs = buildGenerators([cat('s/list', ['video']), cat('s/missing', ['video'])], bare, 'video')
  assert.deepEqual(gs.top.map((x) => x.price.resolution), [undefined, undefined])
})

test("video estimate: each generator uses the SKU's resolution when the prompt does not ask for one", () => {
  const pv = (usd, resolution, by_resolution) => ({ model: 'm', price: { unit: 'second', usd, resolution, ...(by_resolution ? { by_resolution } : {}) } })
  const wan = pv(0.1, '720p'), hey = pv(0.1, '1080p'), hai = pv(0.08, '768p')
  assert.deepEqual([wan, hey, hai].map((x) => resolveVideoPrice(x, {}).resolution), ['720p', '1080p', '768p'])
  assert.deepEqual([wan, hey, hai].map((x) => projectedCost(x, 'video', { text: 't', duration_s: 5 })), [0.5, 0.5, 0.4])
  // the prompt asks for the SKU's resolution, or another one with a price known from the ranking
  assert.equal(resolveVideoPrice(hey, { resolution: '1080P' }).resolution, '1080p')
  const wan2 = pv(0.1, '720p', { '720p': 0.1, '480p': 0.05, '1080p': 0.2 })
  assert.equal(projectedCost(wan2, 'video', { text: 't', duration_s: 10, resolution: '1080p' }), 2)
})

test('video: a requested resolution with no known price becomes no_estimate before any call', async () => {
  const hey = { model: 'heygen/hg', position: 1, price: { unit: 'second', usd: 0.1, resolution: '1080p' } }
  const wan = { model: 'alibaba/wan-3.0', position: 2, price: { unit: 'second', usd: 0.1, resolution: '720p', by_resolution: { '720p': 0.1, '480p': 0.05 } } }
  assert.equal(projectedCost(hey, 'video', { text: 't', resolution: '720p' }), null)
  const { fetchFn, calls } = network({ 'GET /videos/models': () => json({ data: [] }) })
  // a single generator, with no price for 720p: only the listing (a GET, generates nothing) and no generation
  const all = await generate({ category: 'video', prompt: { text: 't', resolution: '720p' }, out: folder('res-no-price'), fetchFn, env: ENV, generators: list(hey) })
  assert.deepEqual([all.state, all.reason, calls.length], ['zero_candidates', 'no_estimate_for_any', 1])
  assert.ok(!calls.some((c) => c.key.startsWith('POST')))
  assert.equal(all.cuts[0].reason, 'no_estimate')
  assert.match(all.cuts[0].detail, /720p has no known price \(the SKU is 1080p\)/)
  // with 2 generators the one with a price goes on and the other is recorded in cuts; the call carries the requested resolution
  const net = network({ 'GET /videos/models': () => json({ data: [] }), 'POST /videos': () => json({ id: 'j', status: 'pending' }, 202),
    'GET /videos/j': () => json({ id: 'j', status: 'completed', usage: { cost: 0.5 } }), 'GET /videos/j/content': () => new Response(Buffer.from('mp4'), { status: 200 }) })
  const r = await generate({ category: 'video', prompt: { text: 't', duration_s: 5, resolution: '480p' }, cap: 3, out: folder('res-two'), fetchFn: net.fetchFn, env: ENV,
    intervalMs: 0, generators: list(hey, wan) })
  assert.deepEqual(r.cuts.map((c) => [c.model, c.reason]), [['heygen/hg', 'no_estimate']])
  assert.equal(r.projected_usd, 0.25)
  assert.equal(net.calls.find((c) => c.key === 'POST /videos').body.resolution, '480p')
  assert.deepEqual([r.candidates[0].resolution, r.candidates[0].price_resolution], ['480p', '720p'])
})

test("video: the POST body carries each generator's SKU resolution; without price.resolution it falls back to the old default (720p), recorded", async () => {
  const net = network({ 'GET /videos/models': () => json({ data: [] }), 'POST /videos': () => json({ id: 'j', status: 'pending' }, 202),
    'GET /videos/j': () => json({ id: 'j', status: 'completed', usage: { cost: 0.1 } }), 'GET /videos/j/content': () => new Response(Buffer.from('mp4'), { status: 200 }) })
  const gen = (model, usd, resolution, position) => ({ model, position, price: { unit: 'second', usd, ...(resolution ? { resolution } : {}) } })
  const r = await generate({ category: 'video', prompt: { text: 't', duration_s: 2 }, cap: 3, out: folder('res-sku'), fetchFn: net.fetchFn, env: ENV, intervalMs: 0,
    generators: list(gen('heygen/hg', 0.1, '1080p', 1), gen('minimax/hailuo', 0.08, '768p', 2), gen('old/no-field', 0.07, null, 3)) })
  assert.deepEqual(net.calls.filter((c) => c.key === 'POST /videos').map((c) => c.body.resolution), ['1080p', '768p', '720p'])
  assert.deepEqual(r.candidates.map((c) => c.price_resolution), ['1080p', '768p', null])
})

// ---------- B1: for-judging ----------

/** Fake candidates.json: files for `n` ok candidates (named with the model, as generate writes them) and a current asset. */
function judgingScenario(name, { n = 2, failed = false } = {}) {
  const dir = folder(name)
  fs.mkdirSync(dir, { recursive: true })
  const cands = Array.from({ length: n }, (_, i) => {
    const file = path.join(dir, `0${i + 1}-openai_gpt-image-2.5-sunburst.png`)
    fs.writeFileSync(file, Buffer.concat([PNG, Buffer.from(`candidate-${i}`)]))
    return { model: `openai/gpt-image-2.${i}`, position: i + 1, prompt: `prompt ${i}`, file, sha256: null, measured_cost: 0.04 + i, state: 'ok', error: null }
  })
  if (failed) cands.push({ model: 'x/failed', position: 9, prompt: 'p', file: null, state: 'failed', error: 'boom', measured_cost: 0 })
  const candidatesFile = path.join(dir, 'candidates.json')
  fs.writeFileSync(candidatesFile, JSON.stringify({ category: 'image', state: 'ok', candidates: cands }))
  const current = path.join(dir, 'pro3_current.png')
  fs.writeFileSync(current, Buffer.concat([PNG, Buffer.from('current-asset')]))
  return { dir, candidatesFile, current, cands }
}

test('for-judging: 2 ok candidates + the current one become 3 neutral options that pass checkOptionsText', () => {
  const { candidatesFile, current, cands } = judgingScenario('fj-happy', { failed: true })
  const out = folder('fj-happy-out')
  const r = forJudging({ candidates: candidatesFile, current, out, categories: ['legibility', 'style'] })
  const input = JSON.parse(fs.readFileSync(path.join(out, 'input.json'), 'utf8'))
  assert.deepEqual(input, r.input)
  assert.ok(input.question.length > 0)
  assert.deepEqual(input.categories, ['legibility', 'style'])
  assert.deepEqual(input.options.map((o) => o.id), ['option-1', 'option-2', 'option-3'])
  assert.deepEqual(input.options.map((o) => o.text), ['version 1 of the asset', 'version 2 of the asset', 'version 3 of the asset'])
  assert.deepEqual(checkOptionsText(input.options), [])
  for (const o of input.options) {
    assert.equal(o.media.length, 1)
    assert.ok(path.isAbsolute(o.media[0]) && fs.existsSync(o.media[0]))
    assert.match(path.basename(o.media[0]), /^option-\d\.png$/)
  }
  // the order is by file sha256, not by generation order nor the current one's position
  const shas = input.options.map((o) => sha(fs.readFileSync(o.media[0])))
  assert.deepEqual(shas, [...shas].sort())
  const origin = JSON.parse(fs.readFileSync(path.join(out, 'origin.json'), 'utf8'))
  const generated = input.options.filter((o) => origin[o.id].origin === 'generator')
  assert.equal(generated.length, 2)
  const fromCurrent = input.options.find((o) => origin[o.id].origin === 'current')
  assert.ok(fs.readFileSync(fromCurrent.media[0]).equals(fs.readFileSync(current)))
  assert.equal(origin[fromCurrent.id].file, path.resolve(current))
  const g0 = generated.find((o) => origin[o.id].model === cands[0].model)
  assert.deepEqual(origin[g0.id], { origin: 'generator', model: cands[0].model, file: path.resolve(cands[0].file), measured_cost: 0.04, prompt_sha: sha('prompt 0') })
})

test('for-judging: origin.json stays out of the input, and nothing the juror sees mentions a model, the current asset or a cost', () => {
  const { candidatesFile, current } = judgingScenario('fj-neutral')
  const out = folder('fj-neutral-out')
  forJudging({ candidates: candidatesFile, current, out, categories: CATS })
  const raw = fs.readFileSync(path.join(out, 'input.json'), 'utf8')
  assert.ok(fs.existsSync(path.join(out, 'origin.json')))
  for (const forbidden of ['origin', 'generator', 'gpt', 'openai', 'sunburst', 'pro3_current', 'cost', 'prompt_sha']) assert.ok(!raw.includes(forbidden), forbidden)
  assert.deepEqual(JSON.parse(raw).categories, CATS)
})

test('for-judging: 4 ok candidates plus the current one are 5 options and the refusal writes nothing; 3 + the current one fits', () => {
  const big = judgingScenario('fj-five', { n: 4 })
  const out = folder('fj-five-out')
  assert.throws(() => forJudging({ candidates: big.candidatesFile, current: big.current, out }), /5 options.*2 to 4/)
  assert.equal(fs.existsSync(out), false)
  const four = judgingScenario('fj-four', { n: 3 })
  const r = forJudging({ candidates: four.candidatesFile, current: four.current, out: folder('fj-four-out'), categories: CATS })
  assert.equal(r.input.options.length, 4)
})

test('for-judging: refuses a folder with input.json, no ok candidate and a missing file', () => {
  const c = judgingScenario('fj-refuse')
  const used = folder('fj-used')
  fs.mkdirSync(used)
  fs.writeFileSync(path.join(used, 'input.json'), '{}')
  assert.throws(() => forJudging({ candidates: c.candidatesFile, current: c.current, out: used }), /already has input\.json/)
  assert.equal(fs.existsSync(path.join(used, 'origin.json')), false)
  const empty = { candidates: [{ model: 'a', state: 'failed', file: null }] }
  assert.throws(() => forJudging({ candidates: empty, current: c.current, out: folder('fj-only-current') }), /no candidate with state ok/)
  const gone = { candidates: [{ model: 'a', state: 'ok', file: path.join(c.dir, 'does-not-exist.png') }] }
  assert.throws(() => forJudging({ candidates: gone, current: c.current, out: folder('fj-gone') }), /file does not exist/)
})

test('an invalid cap in generation fails before spending', async () => {
  for (const cap of [NaN, 0, -1]) await assert.rejects(() => generate({ category: 'image', prompt: { text: 'x' }, cap, estimateOnly: true, env: {} }), /--cap must be/)
})

test('D3: for-judging refuses two sources with the same content', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'd3-'))
  const one = path.join(d, 'cand.png'); fs.writeFileSync(one, 'same')
  const current = path.join(d, 'current.png'); fs.writeFileSync(current, 'same')
  assert.throws(() => forJudging({ files: [one], current, out: path.join(d, 'j') }), /duplicate file/)
})

const CATS = ['fidelity_to_canon', 'readability_on_screen']

test('E4: generate checks the top against the live catalog; anyone who left stays out, with no substitute, and an old top raises a warning', async () => {
  const catalog = [cat('a/one', ['image', 'text']), cat('b/two', ['text'])]
  const r = await generate({ category: 'image', prompt, estimateOnly: true, env: {}, catalog, nowMs: Date.parse(NOW) + 20 * 86400000,
    generators: list(g('a/one', 0.04, 1), g('b/two', 0.05, 2), g('c/three', 0.02, 3)) })
  assert.deepEqual(r.candidates.map((c) => c.model), ['a/one'])
  assert.deepEqual(r.cuts.map((c) => [c.model, c.reason]), [['b/two', 'left_catalog'], ['c/three', 'left_catalog']])
  assert.match(r.warnings[0], /built 20 days ago/)
  const none = await generate({ category: 'image', prompt, estimateOnly: true, env: {}, catalog: [], generators: list(g('a/one', 0.04)) })
  assert.deepEqual([none.state, none.reason], ['zero_candidates', 'left_catalog'])
  const broken = async () => { throw new Error('ECONNRESET') }
  await assert.rejects(() => generate({ category: 'image', prompt, estimateOnly: true, env: {}, fetchFn: broken, generators: list(g('a/one', 0.04)) }), /OpenRouter catalog unavailable/)
})

test('E5: for-judging refuses with no categories or with only one', () => {
  const c = judgingScenario('fj-e5', { n: 1 })
  assert.throws(() => forJudging({ candidates: c.candidatesFile, current: c.current, out: folder('fj-e5-a') }), /--categories is required/)
  assert.throws(() => forJudging({ candidates: c.candidatesFile, current: c.current, out: folder('fj-e5-b'), categories: ['only_one'] }), /--categories is required/)
})

test('E6: topItem returns the generator by id or position and refuses anything not in the top', () => {
  const l = list(g('a/one', 0.04, 1), g('b/two', 0.05, 2))
  assert.equal(topItem(l, { model: 'b/two' }).model, 'b/two')
  assert.equal(topItem(l, { position: 1 }).model, 'a/one')
  assert.throws(() => topItem(l, { model: 'z/outside' }), /is not in the top/)
  assert.throws(() => topItem(l, { position: 3 }), /is not in the top/)
})

test("E11: the neutral evidence does not say that all the options come from the same request", () => {
  const c = judgingScenario('fj-e11', { n: 1 })
  const r = forJudging({ candidates: c.candidatesFile, current: c.current, out: folder('fj-e11-s'), categories: CATS })
  assert.doesNotMatch(r.input.evidence, /same request/)
  assert.match(r.input.evidence, /versions of the same asset/)
})
