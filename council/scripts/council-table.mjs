import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isValidEstimate, isPublishedIndex, weights } from './weights.mjs'

// The count comes from the raw list, not from a number typed by the conductor.
// Weight by level (published, estimated or floor), computed per document; see weights.mjs.
// Decision round (`decision`): the row shows vote and confidence; admission is the validator's,
// there is no overall score, and the contribution is the share of the valid weight.
export function tableRows(entries, { decision = false, published = isPublishedIndex } = {}) {
  const groups = new Map()
  entries.forEach((entry, i) => {
    const doc = String(entry.document ?? '')
    if (!groups.has(doc)) groups.set(doc, [])
    groups.get(doc).push(i)
  })
  const weight = new Array(entries.length)
  for (const idx of groups.values()) weights(idx.map((i) => entries[i]), { published }).forEach((w, k) => { weight[idx[k]] = w })
  const rows = entries.map((entry, n) => {
    const i = entry.index
    const verifiedIndex = published(i)
    const est = isValidEstimate(entry.estimate) ? entry.estimate : null
    const score = !decision && Number.isFinite(entry.review?.overall_score) ? entry.review.overall_score : null
    const admitted = decision ? entry.admitted === true : entry.admitted === true && score >= 1 && score <= 10
    return {
      model: String(entry.model), effort: String(entry.effort ?? 'default'),
      document: String(entry.document ?? ''), choice: String((decision ? admitted && entry.review?.vote : entry.vote) || ''), score,
      confidence: decision && admitted ? String(entry.review?.confidence ?? '') : '',
      points: Array.isArray(entry.review?.fix_points) ? entry.review.fix_points.length : null,
      index: verifiedIndex ? i.value : null, index_source: verifiedIndex ? new URL(i.source).href : null,
      index_version: verifiedIndex ? String(i.version) : null, index_date: verifiedIndex ? i.queried_at : null,
      weight: weight[n].weight, weight_type: weight[n].type,
      weight_label: weight[n].type === 'estimated' ? `estimated (${est.benchmark}, r² ${est.r2.toFixed(2)}, x0.5)` : weight[n].type,
      admitted,
      status: String(entry.status ?? 'pending') + (entry.suspect ? ` · suspect: ${entry.suspect}` : ''),
    }
  })
  for (const idx of groups.values()) {
    const group = idx.map((i) => rows[i])
    const versions = new Set(group.filter((r) => r.index !== null).map((r) => r.index_version))
    const comparable = versions.size <= 1
    const validWeight = comparable ? group.filter((r) => r.admitted).reduce((sum, r) => sum + r.weight, 0) : 0
    for (const row of group) {
      row.weighted_score = comparable && row.admitted && row.score !== null ? row.score * row.weight : null
      row.weight_percent = comparable && row.admitted && validWeight > 0 ? row.weight / validWeight * 100 : null
      row.contribution_points = row.weighted_score !== null && validWeight > 0 ? row.weighted_score / validWeight : null
      if (!comparable && row.index !== null) row.status += ' · indices not comparable, not aggregated'
    }
  }
  return rows
}

const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export const DEFAULT_NOTE = "Original scores and the raw count of critiques/suggestions. Weight: published Intelligence Index; without it, an estimated index from another benchmark calibrated against anchor models, at half weight; with no data at all, a floor of half the lowest weight in the document. Weighted score = score x weight. Contribution = share of the valid weight and the share, in points, of the document's weighted mean. Only rows explicitly admitted by the validator enter the sum; a failure does not become a zero score. Indices: Artificial Analysis, version and query date available in the link. Weights repeated per effort follow the requested lineup; this does not imply statistical independence."

/**
 * `options` present (collection from `collect --options`) turns on decision mode. `opts` (for a skill that
 * weights by another benchmark): `published` validates the published weight, `indexLabel` names the index
 * column, `note` replaces the footer and `extras` ([{ key, label }]) adds columns read from `entry[key]` (e.g. cost).
 */
export function renderTable({ round, entries, options }, { published = isPublishedIndex, indexLabel = 'Intelligence Index', note = DEFAULT_NOTE, extras = [] } = {}) {
  if (!Array.isArray(entries)) throw new Error('entries must be a list of reviews')
  const decision = Array.isArray(options) && options.length > 0
  const rows = tableRows(entries, { decision, published })
  extras.forEach(({ key }) => rows.forEach((r, n) => { r[key] = entries[n][key] ?? null }))
  const data = JSON.stringify({ round: String(round), decision, indexLabel, extras: extras.map((x) => [x.key, x.label]), rows })
    .replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
body{margin:0;color:var(--foreground);font-family:var(--font-sans)}
.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:12px;line-height:1.4}
caption{text-align:left;font-weight:600;padding:0 0 12px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted-foreground);font-weight:500}td:first-child{overflow-wrap:anywhere;max-width:240px}
.track{height:6px;width:65px;background:var(--secondary);border-radius:var(--radius);margin-top:4px;overflow:hidden}.bar{height:6px;background:var(--chart-1)}
.note{font-size:12px;color:var(--muted-foreground);margin:12px 0 0}.state{color:var(--muted-foreground)}a{color:var(--primary)}
@media(max-width:480px){th,td{padding:6px 3px}table{font-size:11px}.track{width:45px}}
</style></head><body><div class="wrap"><table><caption id="caption"></caption><thead><tr id="head"></tr></thead><tbody id="rows"></tbody></table></div>
<p class="note">${escapeHtml(note)}</p>
<script>
const data=${data};
document.getElementById('caption').textContent='Round '+data.round;
const root=document.getElementById('rows');
const columns=data.decision?[['model','Model'],['effort','Effort'],['choice','Vote'],['confidence','Confidence'],['index',data.indexLabel],['weight','Weight'],['share','Valid weight'],...data.extras,['status','Status']]:[['model','Model'],['effort','Effort'],...(data.rows.some(r=>r.document)?[['document','Document']]:[]),...(data.rows.some(r=>r.choice)?[['choice','Vote']]:[]),['score','Score'],['points','Critiques/suggestions'],['index',data.indexLabel],['weight','Weight'],['weighted_score','Weighted score'],['contribution','Contribution'],...data.extras,['status','Status']];
const number=new Intl.NumberFormat('en-US',{maximumFractionDigits:2});
for(const [,label]of columns){const th=document.createElement('th');th.textContent=label;document.getElementById('head').append(th)}
for(const row of data.rows){const tr=document.createElement('tr');
for(const [key]of columns){const td=document.createElement('td');
td.textContent=row[key]===null?(key==='index'?'no source':key==='weighted_score'?'not aggregated':'not received'):typeof row[key]==='number'?number.format(row[key]):String(row[key]??'');
if(key==='index'&&row.index_source){td.textContent='';const a=document.createElement('a');a.href=row.index_source;a.rel='noreferrer';a.textContent=number.format(row.index);a.title='Version '+row.index_version+' · queried at '+row.index_date;td.append(a)}
if(key==='choice'||key==='confidence')td.textContent=row[key]||'—';
if(key==='share')td.textContent=row.weight_percent===null?'not aggregated':number.format(row.weight_percent)+'%';
if(key==='contribution')td.textContent=row.contribution_points===null?'not aggregated':number.format(row.weight_percent)+'% · '+number.format(row.contribution_points)+' pt';
if(key==='weight')td.textContent=number.format(row.weight)+' · '+row.weight_label;
if(key==='status')td.className='state';
if(key==='score'&&row.score>=1&&row.score<=10){const track=document.createElement('div');track.className='track';const bar=document.createElement('div');bar.className='bar';bar.style.width=(row.score*10)+'%';track.append(bar);td.append(track)}
tr.append(td)}root.append(tr)}
</script></body></html>`
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) throw new Error('Usage: node scripts/council-table.mjs reviews.json table.html')
  const html = renderTable(JSON.parse(fs.readFileSync(input, 'utf8')))
  fs.writeFileSync(output, html)
  console.log(JSON.stringify({ output: path.resolve(output) }))
}
