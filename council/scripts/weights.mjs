// Weight of each council review. Owner request (2026-11-06): variety is good in the vote and no
// model goes without a voice. Three levels, in this order of preference:
//   published: Artificial Analysis Intelligence Index, weight = index;
//   estimated: index calibrated from another benchmark against anchors with a published index, weight = estimate x ESTIMATE_DISCOUNT;
//   floor:     no data at all, weight = FLOOR_FRACTION x lowest published or estimated weight in the same group.
export const ESTIMATE_DISCOUNT = 0.5
export const FLOOR_FRACTION = 0.5
export const MIN_ANCHORS = 5
export const MIN_R2 = 0.5

const url = (u) => { try { return new URL(u) } catch { return null } }

/** Published, comparable index: Artificial Analysis scale, version, date and source. */
export function isPublishedIndex(i) {
  return Number.isFinite(i?.value) && i.value >= 0 && i.scale === 'Artificial Analysis Intelligence Index'
    && Boolean(String(i.version ?? '').trim()) && Number.isFinite(Date.parse(i.queried_at))
    && url(i.source)?.origin === 'https://artificialanalysis.ai'
}

/** Usable estimate: benchmark source, calibration with enough anchors and a minimum fit. */
export function isValidEstimate(e) {
  return Number.isFinite(e?.value) && e.value >= 0 && Boolean(url(e.source)) && typeof e.benchmark === 'string'
    && Number.isInteger(e.n_anchors) && e.n_anchors >= MIN_ANCHORS && Number.isFinite(e.r2) && e.r2 >= MIN_R2
}

/**
 * Regression index = a + b x score over the anchors (models with a published index and a score on the
 * same benchmark). Returns null with fewer than MIN_ANCHORS or r² below MIN_R2. The result is never negative.
 * With { log: true }, fits ln(index) and returns exp(·): the v5 index is compressed at the bottom, and a
 * linear fit zeroes out the weak models. The returned r² is from the space the fit was made in.
 */
export function calibrate(anchors, score, { log = false } = {}) {
  if (log) {
    const pos = anchors.filter((p) => p.index > 0)
    if (pos.length !== anchors.length) return null
    const fit = calibrate(pos.map((p) => ({ score: p.score, index: Math.log(p.index) })), score)
    return fit && { ...fit, value: Math.exp(fit.a + fit.b * score), scale: 'log' }
  }
  const n = anchors.length
  if (n < MIN_ANCHORS || !Number.isFinite(score)) return null
  const mx = anchors.reduce((s, p) => s + p.score, 0) / n
  const my = anchors.reduce((s, p) => s + p.index, 0) / n
  const sxx = anchors.reduce((s, p) => s + (p.score - mx) ** 2, 0)
  if (!sxx) return null
  const b = anchors.reduce((s, p) => s + (p.score - mx) * (p.index - my), 0) / sxx
  const a = my - b * mx
  const sst = anchors.reduce((s, p) => s + (p.index - my) ** 2, 0)
  const sse = anchors.reduce((s, p) => s + (p.index - (a + b * p.score)) ** 2, 0)
  const r2 = sst ? 1 - sse / sst : 0
  if (r2 < MIN_R2) return null
  return { value: Math.max(0, a + b * score), a, b, r2, n_anchors: n }
}

/**
 * Weight of each entry in one group (a round or a document). Returns [{ weight, type }] in the same order.
 * The floor uses the lowest published or estimated weight in the group; if nobody has data, everyone weighs 1.
 * `published` decides whether `e.index` counts as a published weight; the default is the Intelligence Index.
 * A skill that judges media can pass the validator of that category's benchmark (image, audio or video).
 */
export function weights(entries, { published = isPublishedIndex } = {}) {
  const base = entries.map((e) => (published(e.index) ? { weight: e.index.value, type: 'published' }
    : isValidEstimate(e.estimate) ? { weight: e.estimate.value * ESTIMATE_DISCOUNT, type: 'estimated' } : null))
  const known = base.filter(Boolean).map((b) => b.weight).filter((w) => w > 0)
  const floor = known.length ? FLOOR_FRACTION * Math.min(...known) : 1
  return base.map((b) => b ?? { weight: floor, type: 'floor' })
}
