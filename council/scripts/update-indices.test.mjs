import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isFresh, update, fetchIndices, ENDPOINT, MAX_AGE_MS } from './update-indices.mjs'

const clock = () => new Date('2026-11-06T03:00:00Z')
const model = (id, score) => ({ id, name: id, slug: id,
  evaluations: { artificial_analysis_intelligence_index: score } })
const page = (n, more, data) => ({ intelligence_index_version: '5.0', data,
  pagination: { page: n, total_pages: 2, has_more: more } })

test('GET uses the free endpoint, authentication and all pages', async () => {
  const calls = []
  const snapshot = await fetchIndices({ apiKey: 'fixture-not-secret', now: clock,
    fetcher: async (url, options) => {
      calls.push([String(url), options])
      const n = Number(url.searchParams.get('page'))
      return Response.json(n === 1 ? page(1, true, [model('m1', 42)]) : page(2, false, [model('m2', null), model('m3', 0)]))
    } })
  assert.equal(calls.length, 2)
  assert.equal(calls[0][0], `${ENDPOINT}?page=1`)
  assert.equal(calls[0][1].method, 'GET')
  assert.equal(calls[0][1].headers['x-api-key'], 'fixture-not-secret')
  assert.equal(snapshot.version, '5.0')
  assert.deepEqual(snapshot.models.map((m) => m.value), [42, null, 0])
})

test('snapshot expires after 24h and future dates are not valid', () => {
  const now = clock().getTime()
  assert.ok(isFresh({ queried_at: new Date(now - MAX_AGE_MS + 1).toISOString() }, now))
  assert.ok(!isFresh({ queried_at: new Date(now - MAX_AGE_MS).toISOString() }, now))
  assert.ok(!isFresh({ queried_at: new Date(now + 1).toISOString() }, now))
})

test('429 error does not loop or overwrite the previous snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-aa-test-'))
  const cacheFile = path.join(dir, 'index.json')
  const previous = JSON.stringify({ queried_at: '2020-01-01', models: [{ value: 1 }] })
  fs.writeFileSync(cacheFile, previous)
  let calls = 0
  await assert.rejects(() => update({ cacheFile, apiKey: 'fixture', fetcher: async () => {
    calls++; return new Response('', { status: 429, headers: { 'retry-after': '3600' } })
  } }), /HTTP 429; Retry-After=3600/)
  assert.equal(calls, 1)
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), previous)
})

test('current cache avoids GET; --force requires a new query', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-aa-test-'))
  const cacheFile = path.join(dir, 'index.json')
  fs.writeFileSync(cacheFile, JSON.stringify({ queried_at: new Date().toISOString(), models: [] }))
  const fetcher = async () => { throw new Error('GET performed') }
  assert.equal((await update({ cacheFile, fetcher })).state, 'cache_current')
  await assert.rejects(() => update({ cacheFile, apiKey: 'fixture', force: true, fetcher }), /GET performed/)
})

test('version changes between pages: rejects the snapshot', async () => {
  await assert.rejects(() => fetchIndices({ apiKey: 'fixture', now: clock, fetcher: async (url) => {
    const n = Number(url.searchParams.get('page'))
    const body = page(n, n === 1, [model(`m${n}`, 20)])
    body.intelligence_index_version = String(n)
    return Response.json(body)
  } }), /changed between pages/)
})

test('invalid data and missing authentication produce no indices', async () => {
  await assert.rejects(() => fetchIndices({}), /key.*missing/)
  await assert.rejects(() => fetchIndices({ apiKey: 'fixture', fetcher: async () => Response.json({ data: [] }) }), /version/)
})
