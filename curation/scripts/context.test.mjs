// Tests for the context and the anonymous options: no network and no game files; the game is an in-memory map injected as readFile.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildContext, contextBlock, anonymizeOptions, checkOptionsText, categoryWarnings } from './context.mjs'

const R = '/game'
const sha = (v) => createHash('sha256').update(v).digest('hex')
const ART = '# Art direction\n\nintro\n\n## 1. Pillars\n\npillar one\n\n## 2. Palette\n\nexcluded\n\n## 3. Lighting\n\nlow light\n\n## 4. Shape language\n\nshapes\n\n## 5. Outline and line\n\noutline\n\n## 6. Texture and materials at 2x\n\ntexture\n\n## 7. Scale\n\nscale\n\n## 8. Items\n\nexcluded\n'
const files = {
  [`${R}/docs/v3/ART_DIRECTION.md`]: ART,
  [`${R}/game/assets/palette.json`]: JSON.stringify({ name: 'Dark Fantasy 32', version: '1.0.0', colors: Array.from({ length: 32 }, (_, i) => `#${(i * 8).toString(16).padStart(2, '0')}0000`) }),
  [`${R}/docs/v3/voice/cast.json`]: JSON.stringify({ maud: 'matilda', fennick: 'roger' }),
  [`${R}/docs/v3/voice/lines/maud.json`]: JSON.stringify({ npc: 'maud', lines: [{ id: 'maud_01', text: 'Sit down.', delivery: 'warm' }, { id: 'maud_02', text: 'Bread.' }] }),
  [`${R}/docs/v3/lore.md`]: 'The Crowmother guards the bridge.\nShe never sleeps.',
  [`${R}/art/boss.png`]: Buffer.from('boss-png'),
  [`${R}/audio/maud.ogg`]: Buffer.from('maud-ogg'),
}
const readFile = (f) => { f = f.replaceAll('\\', '/'); if (!(f in files)) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return files[f] }
const ctx = (target) => buildContext(target, { gameRoot: R, readFile })

const image = { media: 'image', name: 'Crowmother', appears_in: { screen: 'side combat', size_px: [128, 128], moment: 'start of the fight' },
  current_asset: 'art/boss.png', canon: { file: 'docs/v3/lore.md', excerpt: 'She never sleeps.' } }
const speech = { media: 'audio', subtype: 'speech', name: 'Maud welcomes', appears_in: { screen: 'camp', moment: 'first visit' },
  current_asset: 'audio/maud.ogg', canon: 'Maud is the old bread woman.', npc: 'maud' }
const music = { media: 'audio', subtype: 'music', name: 'Camp theme', appears_in: { screen: 'camp', moment: 'background loop' },
  current_asset: 'audio/maud.ogg', canon: 'Safe place, fragile.', scene: 'Campfire at night, wind.' }

test('image: style (only the right sections), 32-color palette, canon from a file and asset with sha', () => {
  const c = ctx(image)
  assert.deepEqual(Object.keys(c.fields), ['appears_in', 'canon', 'current_asset', 'style', 'palette'])
  assert.equal(c.fields.appears_in.text, 'screen: side combat; size_px: 128x128; moment: start of the fight')
  assert.match(c.fields.style.text, /pillar one[\s\S]*low light[\s\S]*shapes[\s\S]*outline[\s\S]*texture[\s\S]*scale/)
  assert.doesNotMatch(c.fields.style.text, /excluded/)
  assert.equal(c.fields.style.source.sha256, sha(ART))
  assert.equal(c.fields.palette.source.file, 'game/assets/palette.json')
  assert.equal(c.fields.palette.source.sha256, sha(files[`${R}/game/assets/palette.json`]))
  assert.equal(c.fields.canon.text, 'She never sleeps.')
  assert.equal(c.fields.canon.source.sha256, sha(files[`${R}/docs/v3/lore.md`]))
  assert.equal(c.fields.current_asset.source.sha256, sha(Buffer.from('boss-png')))
  for (const { source } of Object.values(c.fields)) assert.match(source.sha256, /^[0-9a-f]{64}$/)
})

test('speech brings the npc character_voice and lines, without style or palette', () => {
  const c = ctx(speech)
  assert.equal(c.fields.character_voice.text, 'maud: matilda')
  assert.match(c.fields.lines.text, /maud_01: "Sit down\." \(warm\)/)
  assert.equal(c.fields.lines.source.file, 'docs/v3/voice/lines/maud.json')
  assert.equal(c.fields.style, undefined)
  assert.equal(c.fields.palette, undefined)
  assert.equal(c.fields.canon.source.file, 'target.json')
})

test('music brings style and scene, without palette or character_voice', () => {
  const c = ctx(music)
  assert.ok(c.fields.style && c.fields.scene)
  assert.equal(c.fields.scene.text, 'Campfire at night, wind.')
  assert.equal(c.fields.palette, undefined)
  assert.equal(c.fields.character_voice, undefined)
  assert.match(contextBlock(c), /\(music\)/)
})

test('same inputs give the same block and the same sha; changing a file changes the sha', () => {
  const a = ctx(image)
  const b = ctx(structuredClone(image))
  assert.equal(contextBlock(a), contextBlock(b))
  assert.equal(a.sha256, b.sha256)
  assert.equal(a.sha256, sha(contextBlock(a)))
  const before = files[`${R}/docs/v3/ART_DIRECTION.md`]
  files[`${R}/docs/v3/ART_DIRECTION.md`] = ART.replace('shapes', 'new shapes')
  try { assert.notEqual(ctx(image).sha256, a.sha256) } finally { files[`${R}/docs/v3/ART_DIRECTION.md`] = before }
})

test('the block cites its sources and does not reveal which asset is the current one', () => {
  const block = contextBlock(ctx(image))
  assert.match(block, /Source: docs\/v3\/ART_DIRECTION\.md \(sha256 [0-9a-f]{12}/)
  assert.match(block, /## Sources[\s\S]*game\/assets\/palette\.json: [0-9a-f]{64}/)
  assert.doesNotMatch(block, /boss\.png/)
  assert.doesNotMatch(block, new RegExp(sha(Buffer.from('boss-png'))))
})

test('refusals: required field, missing asset, missing source', () => {
  const without = (target, k) => { const c = structuredClone(target); delete c[k]; return c }
  assert.throws(() => ctx(without(image, 'appears_in')), /appears_in\.screen required/)
  assert.throws(() => ctx({ ...image, appears_in: { screen: 'x', moment: 'y' } }), /size_px required/)
  assert.throws(() => ctx(without(image, 'current_asset')), /current_asset required/)
  assert.throws(() => ctx(without(image, 'canon')), /canon required/)
  assert.throws(() => ctx(without(image, 'name')), /name required/)
  assert.throws(() => ctx(without(music, 'scene')), /scene required/)
  assert.throws(() => ctx(without(speech, 'npc')), /npc required/)
  assert.throws(() => ctx(without(speech, 'subtype')), /subtype/)
  assert.throws(() => ctx({ ...image, media: 'text' }), /media must be/)
  assert.throws(() => ctx({ ...image, current_asset: 'art/missing.png' }), /unreadable source: art\/missing\.png/)
  assert.throws(() => ctx({ ...speech, npc: 'fennick' }), /unreadable source: docs\/v3\/voice\/lines\/fennick\.json/)
  assert.throws(() => ctx({ ...speech, npc: 'nobody' }), /npc "nobody" is not/)
  assert.throws(() => ctx({ ...image, canon: { file: 'docs/v3/lore.md', excerpt: 'made-up phrase' } }), /excerpt not found/)
  assert.throws(() => ctx({ ...image, canon: { file: 'docs/v3/missing.md', excerpt: 'x' } }), /unreadable source: docs\/v3\/missing\.md/)
  assert.throws(() => ctx({ ...image, style_sections: ['99'] }), /sections 99 not found/)
  assert.throws(() => buildContext(image, { readFile }), /gameRoot/)
  files[`${R}/game/assets/palette.json.short`] = JSON.stringify({ colors: ['#000000'] })
  assert.throws(() => ctx({ ...image, palette: 'game/assets/palette.json.short' }), /32 colors/)
})

const opts = [{ id: 'current', text: 'one', media: ['a.png'] }, { id: 'f31', text: 'two' }, { id: 'nb21', text: 'three' }, { id: 'pro3', text: 'four' }]

test('anonymizeOptions: deterministic with the seed, reversible map, neutral letters', () => {
  const a = anonymizeOptions(opts, { seed: 'v07-boss' })
  const b = anonymizeOptions(opts, { seed: 'v07-boss' })
  assert.deepEqual(a, b)
  assert.equal(a.seed, 'v07-boss')
  assert.deepEqual(a.options.map((o) => o.id).sort(), ['A', 'B', 'C', 'D'])
  for (const o of a.options) {
    const original = opts.find((x) => x.id === a.map[o.id])
    assert.equal(o.text, original.text) // the map returns the right option
    assert.deepEqual(o.media, original.media)
  }
  assert.deepEqual(Object.values(a.map).sort(), opts.map((o) => o.id).sort())
  assert.equal(opts[0].id, 'current') // input untouched
})

test('anonymizeOptions: different seeds shuffle differently; order is not always A,B,C', () => {
  const seen = new Set()
  const orders = new Set()
  for (let s = 0; s < 30; s++) {
    const r = anonymizeOptions(opts, { seed: s })
    seen.add(JSON.stringify(r.map))
    orders.add(r.options.map((o) => o.id).join(''))
  }
  assert.ok(seen.size > 10 && orders.size > 10)
  assert.throws(() => anonymizeOptions(opts, {}), /seed/)
  assert.throws(() => anonymizeOptions([opts[0]], { seed: 1 }), /2 to 26/)
  assert.throws(() => anonymizeOptions([opts[0], opts[0]], { seed: 1 }), /duplicate/)
})

test('checkOptionsText catches current, keep, model name and cost', () => {
  const problems = (text, extra = {}) => checkOptionsText([{ id: 'A', text, ...extra }]).map((p) => p.problem)
  assert.deepEqual(problems('Keep the current'), ['status quo'])
  assert.ok(problems('current game version').includes('status quo'))
  for (const m of ['Gemini 3 Pro', 'made with Flux', 'Lyria clip', 'gpt-image', 'Omni 1.2', 'Seedance', 'Wan 2.2', 'variant v2', 'Nano Banana']) assert.ok(problems(m).includes('model name'), m)
  for (const c of ['costed US$ 0.35', 'only $2 per image', 'R$ 3', 'the cost is low']) assert.ok(problems(c).includes('cost'), c)
  assert.deepEqual(problems('Raven with open wings, dark outline, bridge background.'), [])
  assert.deepEqual(problems('Raven with the word updated and value 5 beside it.'), [])
})

test('checkOptionsText also sees the non-neutral id and the media file name', () => {
  const p = checkOptionsText([{ id: 'current', text: 'ok' }, { id: 'B', text: 'ok', media: ['x/pro3_current.png'] }])
  assert.ok(p.some((x) => x.where === 'id' && x.option === 'current'))
  assert.ok(p.some((x) => x.where === 'media' && x.option === 'B' && x.problem === 'status quo'))
  assert.deepEqual(checkOptionsText(anonymizeOptions([{ id: 'x', text: 'a' }, { id: 'y', text: 'b' }], { seed: 1 }).options), [])
})

test('categoryWarnings flags the categories that reward the status quo', () => {
  const warnings = categoryWarnings(['ready_to_use', 'consistency_with_current_game', { category: 'legibility' }, 'fidelity_to_canon'])
  assert.deepEqual(warnings.map((a) => a.category), ['ready_to_use', 'consistency_with_current_game'])
  assert.match(warnings[0].warning, /status quo/)
  assert.deepEqual(categoryWarnings(['legibility', 'silhouette']), [])
})

test('D14: Unicode boundary, an accented letter before "udio" does not match a model name', () => {
  const problems = (text) => checkOptionsText([{ id: 'A', text }]).map((p) => p.problem)
  assert.deepEqual(problems('Short audio track, a 4 s video and a caféudio blend.'), [])
  assert.ok(problems('made with Udio').includes('model name'))
})
