import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchPublicIndices, readPublicPage, PUBLIC_URL } from './public-indices.mjs'

const page = (score = 42, version = '5.0.1') => {
  const data = { title: `Artificial Analysis Intelligence Index v${version}`, initialModels: [
    { id: 'fixture-1', name: 'Fictional model', slug: 'fictional-model', creator: { name: 'Fixture' },
      intelligenceIndexEvaluations: [], intelligenceIndex: score, suffix: 'high' },
  ] }
  const record = `27:${JSON.stringify(data)}\n`
  const split = Math.floor(record.length / 2)
  return [record.slice(0, split), record.slice(split)].map((part) =>
    `<script>self.__next_f.push(${JSON.stringify([1, part])})</script>`).join('')
}
test('rebuilds public chunks without running JavaScript', () => {
  const r = readPublicPage(page(), PUBLIC_URL)
  assert.equal(r.version, '5.0.1')
  assert.equal(r.models[0].value, 42)
  assert.equal(r.models[0].evaluated_config, 'high')
  assert.match(r.evidence.sha256, /^[a-f0-9]{64}$/)
})
test('public GET needs no credentials and marks coverage as partial', async () => {
  const snapshot = await fetchPublicIndices({ fetcher: async (url, options) => {
    assert.equal(String(url), PUBLIC_URL)
    assert.equal(options.method, 'GET')
    assert.equal(options.headers, undefined)
    return new Response(page())
  } })
  assert.equal(snapshot.mode, 'public_no_login')
  assert.equal(snapshot.coverage, 'partial_queried_pages')
})
test('page without data or with an ambiguous version fails without inventing an index', () => {
  assert.throws(() => readPublicPage('<h1>Login</h1>', PUBLIC_URL), /version/)
  assert.throws(() => readPublicPage(page() + page(42, '4.0'), PUBLIC_URL), /ambiguous/)
})
test('an index change between pages prevents an inconsistent snapshot', async () => {
  let n = 0
  await assert.rejects(() => fetchPublicIndices({ urls: [`${PUBLIC_URL}/fictional-model`],
    fetcher: async () => new Response(page(n++ ? 43 : 42)) }), /Diverging/)
})
test('keeps published zero and null', () => {
  assert.equal(readPublicPage(page(0), PUBLIC_URL).models[0].value, 0)
  assert.equal(readPublicPage(page(null), PUBLIC_URL).models[0].value, null)
})
