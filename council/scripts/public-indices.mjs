import { createHash } from 'node:crypto'

export const PUBLIC_URL = 'https://artificialanalysis.ai/models'

// Reads only the JSON served on the public page. Does not run the site's scripts.
export function readPublicPage(html, source) {
  let payload = ''
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    const script = match[1].trim()
    if (!script.startsWith('self.__next_f.push(')) continue
    const call = script.endsWith(';') ? script.slice(0, -1) : script
    try {
      const chunk = JSON.parse(call.slice('self.__next_f.push('.length, -1))
      if (chunk[0] === 1 && typeof chunk[1] === 'string') payload += chunk[1]
    } catch {}
  }
  const versions = [...new Set([...payload.matchAll(/Artificial Analysis Intelligence Index v(\d+(?:\.\d+)+)/g)].map((m) => m[1]))]
  if (versions.length !== 1) throw new Error('Intelligence Index version missing or ambiguous on the public page')
  const models = new Map()
  function visit(value) {
    if (!value || typeof value !== 'object') return
    if (typeof value.id === 'string' && typeof value.slug === 'string' && typeof value.name === 'string'
      && value.creator && Object.hasOwn(value, 'intelligenceIndexEvaluations') && Object.hasOwn(value, 'intelligenceIndex')) {
      const score = value.intelligenceIndex
      if (!(score === null || Number.isFinite(score) && score >= 0)) throw new Error('Invalid public index')
      models.set(value.id, { aa_id: value.id, name: value.name, slug: value.slug, creator: value.creator,
        openrouter_api_id: null, value: score, evaluated_config: value.suffix ?? value.name,
        source: `https://artificialanalysis.ai/models/${encodeURIComponent(value.slug)}` })
    }
    for (const child of Object.values(value)) visit(child)
  }
  for (const line of payload.split('\n')) {
    const record = /^[0-9a-f]+:(.*)$/.exec(line)
    if (!record) continue
    let data
    try { data = JSON.parse(record[1]) } catch { continue }
    visit(data)
  }
  if (!models.size) throw new Error('No structured index found on the public page')
  return { version: versions[0], models: [...models.values()],
    evidence: { url: source, sha256: createHash('sha256').update(html).digest('hex') } }
}

export async function fetchPublicIndices({ urls = [PUBLIC_URL], fetcher = fetch, now = () => new Date() } = {}) {
  const queried = now().toISOString()
  const models = new Map()
  const pages = []
  let version
  for (const source of [...new Set([PUBLIC_URL, ...urls])]) {
    const url = new URL(source)
    if (url.origin !== 'https://artificialanalysis.ai' || !/^\/models(?:\/[a-z0-9-]+)?$/.test(url.pathname)
      || url.username || url.password || url.search || url.hash) throw new Error('Public source must be an official models page')
    const res = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`Artificial Analysis public page HTTP ${res.status}`)
    const page = readPublicPage(await res.text(), String(url))
    if (version !== undefined && version !== page.version) throw new Error('Different versions between public pages')
    version = page.version
    pages.push(page.evidence)
    for (const model of page.models) {
      const previous = models.get(model.aa_id)
      if (previous && previous.value !== model.value) throw new Error('Diverging index between public pages')
      models.set(model.aa_id, model)
    }
  }
  return { source: PUBLIC_URL, mode: 'public_no_login', coverage: 'partial_queried_pages',
    attribution: 'Artificial Analysis https://artificialanalysis.ai/',
    queried_at: queried, completed_at: now().toISOString(), scale: 'Artificial Analysis Intelligence Index',
    version, pages, models: [...models.values()] }
}
