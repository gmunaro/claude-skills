// Player context (A3) and anonymous options (A4) for curation. Node 24+, no dependencies, no network.
//
//   buildContext(target, { gameRoot, readFile }) -> context   (fields with text + source {file, sha256, excerpt})
//   contextBlock(context) -> markdown text, identical for every juror
//   anonymizeOptions(options, { seed }) -> { options, map, seed }
//   checkOptionsText(options) -> problems;  categoryWarnings(categories) -> warnings
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const sha = (v) => createHash('sha256').update(v).digest('hex')
const MEDIA = ['image', 'audio', 'video']
const SUBTYPES = ['music', 'speech']
const STYLE = 'docs/v3/ART_DIRECTION.md'
const PALETTE = 'game/assets/palette.json'
const CAST = 'docs/v3/voice/cast.json'
const LINES = (npc) => `docs/v3/voice/lines/${npc}.json`
/** ART_DIRECTION sections per media (the "## N." number): image gets shape, light, outline, texture and scale; music and video get the pillars and the light. */
const SECTIONS = { image: ['1', '3', '4', '5', '6', '7'], audio: ['1', '3'], video: ['1', '3'] }
const MEDIA_NAME = { image: 'image', music: 'music', speech: 'speech', video: 'video' }

const isEmpty = (v) => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length)
const asText = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(v.every(Number.isFinite) ? 'x' : ', ') : v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}: ${x}`).join(', ') : String(v))

/** Default reader: returns the file contents as a Buffer. Tests inject another. */
const defaultReader = (f) => fs.readFileSync(f)

/**
 * Builds the context for a target. target = { media: image|audio|video, subtype?: music|speech (required for audio), name,
 * appears_in: { screen, size_px (image and video), moment }, current_asset (path; relative to the game root or absolute),
 * canon (text, or { file, excerpt } with the excerpt verbatim inside the file), scene? (music and video), npc? (speech),
 * style_sections?: ['1','4'] (replaces the default ART_DIRECTION sections), palette?: JSON path (default game/assets/palette.json) }.
 * Canon as text and appears_in come from the request itself: their source is "target.json". Everything else comes from a game file, with sha256.
 * Refuses (Error listing the problems) if a required field, the current asset or any source is missing.
 */
export function buildContext(target, { gameRoot, readFile = defaultReader } = {}) {
  if (!gameRoot) throw new Error('context refused: gameRoot required')
  const failures = []
  const fail = (m) => failures.push(m)
  const abs = (f) => (path.isAbsolute(f) ? f : path.join(gameRoot, f))
  const read = (f) => { try { return Buffer.from(readFile(abs(f))) } catch (e) { fail(`unreadable source: ${f} (${e.code ?? e.message})`); return null } }

  const media = target?.media
  if (!MEDIA.includes(media)) throw new Error(`context refused: media must be ${MEDIA.join(', ')}`)
  const type = media === 'audio' ? target.subtype : media
  if (media === 'audio' && !SUBTYPES.includes(target.subtype)) fail(`audio requires subtype ${SUBTYPES.join(' or ')}`)
  if (isEmpty(target.name)) fail('name required')
  const appears = target.appears_in
  for (const k of media === 'audio' ? ['screen', 'moment'] : ['screen', 'size_px', 'moment']) if (isEmpty(appears?.[k])) fail(`appears_in.${k} required`)
  if (isEmpty(target.current_asset)) fail('current_asset required')
  if (isEmpty(target.canon)) fail('canon required')
  if ((type === 'music' || media === 'video') && isEmpty(target.scene)) fail('scene required for music and video')
  if (type === 'speech' && isEmpty(target.npc)) fail('npc required for speech')
  if (failures.length) throw new Error(`context refused: ${failures.join('; ')}`)

  const fields = {}
  const fromTarget = (field, text) => { fields[field] = { text, source: { file: 'target.json', sha256: sha(text), excerpt: field } } }

  fromTarget('appears_in', Object.entries(appears).filter(([, v]) => !isEmpty(v)).map(([k, v]) => `${k}: ${asText(v)}`).join('; '))

  // Canon: text from the request, or a verbatim excerpt of a game file.
  if (typeof target.canon === 'string') fromTarget('canon', target.canon)
  else {
    const buf = target.canon.file && read(target.canon.file)
    if (!target.canon.file || isEmpty(target.canon.excerpt)) fail('canon object requires file and excerpt')
    else if (buf) {
      if (!buf.toString('utf8').includes(target.canon.excerpt)) fail(`canon: excerpt not found in ${target.canon.file}`)
      else fields.canon = { text: target.canon.excerpt, source: { file: target.canon.file, sha256: sha(buf), excerpt: target.canon.excerpt.slice(0, 80) } }
    }
  }

  // Current asset: the file must exist; its sha identifies the version the player sees.
  const asset = read(target.current_asset)
  if (asset) fields.current_asset = { text: `${target.current_asset} (${asset.length} bytes)`, source: { file: target.current_asset, sha256: sha(asset), excerpt: 'whole file' } }

  if (media === 'image' || type === 'music' || media === 'video') {
    const buf = read(STYLE)
    if (buf) {
      const numbers = target.style_sections ?? SECTIONS[media]
      const sections = buf.toString('utf8').split(/^(?=## )/m).filter((s) => numbers.some((n) => s.startsWith(`## ${n}.`)))
      if (sections.length !== numbers.length) fail(`style: sections ${numbers.join(', ')} not found in ${STYLE}`)
      // Headings go down one level so they sit below the block's "## Style".
      else fields.style = { text: sections.map((s) => s.trim().replace(/^(#{2,5}) /gm, '#$1 ')).join('\n\n'), source: { file: STYLE, sha256: sha(buf), excerpt: sections.map((s) => s.split('\n')[0].replace(/^## /, '')).join(' | ') } }
    }
  }
  if (media === 'image') {
    const fname = target.palette ?? PALETTE
    const buf = read(fname)
    if (buf) {
      const p = JSON.parse(buf.toString('utf8'))
      if (!Array.isArray(p.colors) || p.colors.length !== 32) fail(`palette: ${fname} does not have exactly 32 colors`)
      else fields.palette = { text: `${p.name ?? 'palette'} ${p.version ?? ''}: ${p.colors.join(' ')}`.replace(' :', ':'), source: { file: fname, sha256: sha(buf), excerpt: 'colors (32)' } }
    }
  }
  if (type === 'music' || media === 'video') fromTarget('scene', asText(target.scene))
  if (type === 'speech') {
    const cast = read(CAST)
    if (cast) {
      const voice = JSON.parse(cast.toString('utf8'))[target.npc]
      if (voice === undefined) fail(`speech: npc "${target.npc}" is not in ${CAST}`)
      else fields.character_voice = { text: `${target.npc}: ${asText(voice)}`, source: { file: CAST, sha256: sha(cast), excerpt: `"${target.npc}"` } }
    }
    const fname = LINES(target.npc)
    const linesBuf = read(fname)
    if (linesBuf) {
      const l = JSON.parse(linesBuf.toString('utf8')).lines
      if (!Array.isArray(l) || !l.length) fail(`speech: ${fname} has no lines`)
      else fields.lines = { text: l.map((x) => `- ${x.id}: "${x.text}"${x.delivery ? ` (${x.delivery})` : ''}`).join('\n'), source: { file: fname, sha256: sha(linesBuf), excerpt: `lines (${l.length})` } }
    }
  }
  if (failures.length) throw new Error(`context refused: ${failures.join('; ')}`)

  const context = { media, subtype: target.subtype ?? null, name: target.name, fields }
  context.sha256 = sha(contextBlock(context))
  return context
}

const TITLES = { appears_in: 'Where it appears', canon: 'Canon', style: 'Style', palette: 'Palette', scene: 'Scene', character_voice: 'Character voice', lines: 'Lines already written', current_asset: 'Attached material' }

/**
 * Single markdown text for the context, identical for every juror (no timestamps or anything else that varies), with the source of each field.
 * The context's sha256 is the hash of this text.
 */
export function contextBlock(context) {
  const { media, subtype, name, fields } = context
  const parts = [`# Player context: ${name} (${MEDIA_NAME[subtype ?? media]})`]
  for (const [field, { text, source }] of Object.entries(fields)) {
    if (field === 'current_asset') continue // the current file is attached as one more option, unlabeled
    parts.push(`## ${TITLES[field] ?? field}\n\n${text}\n\nSource: ${source.file} (sha256 ${source.sha256.slice(0, 12)}, ${source.excerpt})`)
  }
  // The current asset is left out: its path and sha would tell jurors which option is the current one. It is still in context.fields.
  const sources = Object.entries(fields).filter(([c]) => c !== 'current_asset').map(([, { source }]) => `- ${source.file}: ${source.sha256}`)
  parts.push(`## Sources\n\n${[...new Set(sources)].join('\n')}`)
  return `${parts.join('\n\n')}\n`
}

// ---------- A4: anonymous options ----------

/** mulberry32 PRNG from any seed (text or number), via sha256. */
function prng(seed) {
  let a = createHash('sha256').update(String(seed)).digest().readUInt32LE(0)
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function shuffle(list, rnd) {
  const r = [...list]
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [r[i], r[j]] = [r[j], r[i]] }
  return r
}

/**
 * Replaces ids with neutral letters (A, B, C...) drawn by a seeded PRNG and shuffles the list order (a second draw).
 * Same seed and same options give the same output. `map` {letter: original_id} is stored outside the packet (map.json).
 */
export function anonymizeOptions(options, { seed } = {}) {
  if (seed == null || seed === '') throw new Error('anonymize: seed required')
  if (!Array.isArray(options) || options.length < 2 || options.length > 26) throw new Error('anonymize: 2 to 26 options')
  const ids = options.map((o) => o.id)
  if (new Set(ids).size !== ids.length || ids.some(isEmpty)) throw new Error('anonymize: empty or duplicate ids')
  const rnd = prng(seed)
  const letters = shuffle(options.map((_, i) => String.fromCharCode(65 + i)), rnd)
  const map = {}
  const relabeled = options.map((o, i) => { map[letters[i]] = o.id; return { ...o, id: letters[i] } })
  const ordered = shuffle(relabeled, rnd)
  return { options: ordered, map, seed }
}

// Whole word, but _ and - separate words (file names like pro3_current.png).
// Unicode boundary: 'éudio' does not match 'udio'.
const word = (alt, flags = 'iu') => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, flags)
const PROBLEMS = [
  ['status quo', word('current|currently|keep|keeping|kept|maintain\\w*|existing')],
  ['model name', word('gemini|gpt\\w*|flux\\w*|lyria|omni|seedance|wan|veo|imagen|sora|kling|suno|udio|claude|opus|sonnet|haiku|nano[ -]?banana|dall-?e|midjourney|stable[ -]?diffusion|sdxl|elevenlabs|v\\d+(?:\\.\\d+)*')],
  ['cost', /(US\$|R\$|\$\s?\d|\b\d+([.,]\d+)?\s?(usd|dollars)\b|\b(cost|costed|price)\b)/i],
]

/**
 * Scans each option's text (plus its id and media file names, which the juror also sees) for anything that gives away
 * which one is the current asset, the model or the cost. Returns [{ option, where, problem, excerpt }]; empty list = clean.
 * (`where` = where the leak was found: text, id or media; the key name is shared with curation.mjs and generation.mjs.)
 */
export function checkOptionsText(options) {
  const found = []
  for (const o of options) {
    const targets = [['text', o.text ?? ''], ['id', o.id ?? ''], ...(o.media ?? []).map((f) => ['media', path.basename(f)])]
    for (const [where, value] of targets) {
      if (where === 'id' && /^[A-Z]$/.test(value)) continue
      for (const [problem, re] of PROBLEMS) {
        const m = String(value).match(re)
        if (m) found.push({ option: o.id, where, problem, excerpt: m[0] })
      }
    }
  }
  return found
}

const REWARDS_STATUS_QUO = /(ready|immediate_use|current|consist|continuity|keep|maint|status.?quo|familiar|backward.?compat)/i

/**
 * Warnings for score categories that reward the status quo (the current asset is already "ready", "consistent with the current game").
 * categories = list of names or of { category|name }. Returns [{ category, warning }].
 */
export function categoryWarnings(categories) {
  return categories.map((c) => (typeof c === 'string' ? c : c.category ?? c.name)).filter((c) => REWARDS_STATUS_QUO.test(c))
    .map((category) => ({ category, warning: `"${category}" tends to reward the status quo (the current asset is already ready and consistent); measure it through facts common to all options, or drop the category` }))
}
