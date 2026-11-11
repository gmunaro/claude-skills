import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchPublicIndices } from './public-indices.mjs'

export const ENDPOINT = 'https://artificialanalysis.ai/api/v2/language/models/free'
export const MAX_AGE_MS = 24 * 60 * 60 * 1000

export function isFresh(snapshot, now = Date.now()) {
  const age = now - Date.parse(snapshot?.queried_at)
  return Number.isFinite(age) && age >= 0 && age < MAX_AGE_MS
}

// Authenticated GET of the free API. Only returns the snapshot after all pages.
export async function fetchIndices({ apiKey, fetcher = fetch, now = () => new Date() }) {
  if (!apiKey?.trim()) throw new Error('Artificial Analysis API key missing')
  const started = now().toISOString()
  const models = []
  const ids = new Set()
  let version
  for (let page = 1; page <= 100; page++) {
    const url = new URL(ENDPOINT)
    url.searchParams.set('page', String(page))
    const res = await fetcher(url, { method: 'GET', redirect: 'error',
      signal: AbortSignal.timeout(30000), headers: { 'x-api-key': apiKey, Accept: 'application/json' } })
    if (!res.ok) throw new Error(`Artificial Analysis HTTP ${res.status}${res.status === 429 ? `; Retry-After=${res.headers.get('retry-after') ?? 'not provided'}` : ''}`)
    const body = await res.json()
    const v = body.intelligence_index_version
    if ((typeof v !== 'number' && typeof v !== 'string') || String(v).trim() === '') throw new Error('Index version missing')
    if (version !== undefined && version !== String(v)) throw new Error('Index version changed between pages')
    version = String(v)
    if (!Array.isArray(body.data) || !body.data.length) throw new Error('Model page empty or invalid')
    for (const m of body.data) {
      const value = m.evaluations?.artificial_analysis_intelligence_index
      if (typeof m.id !== 'string' || !m.id || typeof m.name !== 'string' || !m.name
        || typeof m.slug !== 'string' || !m.slug || ids.has(m.id)
        || !(value === null || (Number.isFinite(value) && value >= 0))) throw new Error('Invalid model or index in response')
      ids.add(m.id)
      models.push({ aa_id: m.id, name: m.name, slug: m.slug, creator: m.model_creator,
        openrouter_api_id: m.openrouter_api_id ?? null, value,
        source: `https://artificialanalysis.ai/models/${encodeURIComponent(m.slug)}` })
    }
    const pagination = body.pagination
    if (!pagination || pagination.page !== page || typeof pagination.has_more !== 'boolean'
      || !Number.isInteger(pagination.total_pages) || pagination.total_pages < page) throw new Error('Invalid pagination')
    if (!pagination.has_more) {
      if (pagination.total_pages !== page) throw new Error('Incomplete snapshot')
      return { source: ENDPOINT, attribution: 'Artificial Analysis https://artificialanalysis.ai/',
        queried_at: started, completed_at: now().toISOString(),
        scale: 'Artificial Analysis Intelligence Index', version, models }
    }
  }
  throw new Error('Page limit exceeded')
}

export async function update({ cacheFile, apiKey, force = false, fetcher = fetch, publicUrls }) {
  let previous
  try { previous = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) } catch {}
  if (!force && isFresh(previous)) return { state: 'cache_current', models: previous.models.length, queried_at: previous.queried_at }
  const snapshot = apiKey?.trim()
    ? await fetchIndices({ apiKey, fetcher })
    : await fetchPublicIndices({ urls: publicUrls, fetcher })
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
  const temporary = `${cacheFile}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, cacheFile)
  return { state: 'updated', models: snapshot.models.length,
    with_index: snapshot.models.filter((m) => m.value !== null).length,
    queried_at: snapshot.queried_at, version: snapshot.version,
    mode: snapshot.mode ?? 'authenticated_api', coverage: snapshot.coverage ?? 'api_catalog' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const home = os.homedir()
  const cacheDir = path.join(home, '.cache/council')
  const cacheFile = path.join(cacheDir, 'intelligence-index.json')
  const keyFile = path.join(home, '.t3/secrets/artificialanalysis-api-key.txt')
  let apiKey = process.env.AA_API_KEY
  if (!apiKey) try { apiKey = fs.readFileSync(keyFile, 'utf8').trim() } catch {}
  fs.mkdirSync(cacheDir, { recursive: true })
  try {
    let publicUrls
    try { publicUrls = JSON.parse(fs.readFileSync(path.join(cacheDir, 'public-sources.json'), 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (publicUrls !== undefined && (!Array.isArray(publicUrls) || publicUrls.some((u) => typeof u !== 'string'))) {
      throw new Error('public-sources.json must be a list of official URLs')
    }
    const result = await update({ cacheFile, apiKey, publicUrls, force: process.argv.includes('--force') })
    const status = { attempted_at: new Date().toISOString(), ...result }
    fs.writeFileSync(path.join(cacheDir, 'update-status.json'), JSON.stringify(status, null, 2))
    console.log(JSON.stringify(status))
  } catch (error) {
    const status = { attempted_at: new Date().toISOString(), state: 'error', error: error.message }
    fs.writeFileSync(path.join(cacheDir, 'update-status.json'), JSON.stringify(status, null, 2))
    console.error(JSON.stringify(status))
    process.exitCode = 1
  }
}
