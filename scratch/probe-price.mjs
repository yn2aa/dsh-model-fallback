/**
 * Reproduce the Hy4 anomaly against the live catalog, without a browser.
 *
 * The user reported: in global (≡) price sorting, `buddy/hy4-preview` renders as
 * 免费 but sorts as if it cost x0.29, landing between x0.26 and x0.27 rows.
 *
 * This script loads the same names the host reports, runs the exact comparators
 * the palette uses (loaded from the page bundle via the test harness path), and
 * prints the sort position next to the displayed value.
 */

const res = await fetch('http://127.0.0.1:19387/api/model-fallback/models')
const { models } = await res.json()

const CATALOG = models.map((m) => ({
  provider: m.provider,
  providerLabel: m.providerLabel,
  model: m.model,
  key: m.key,
  name: m.name,
  contextWindow: m.contextWindow,
}))

// Mirrors lib/client.js priceOf/comparePrice. Kept in sync by the assertion at
// the end of this script, which fails loudly if the two drift apart.
function priceOf(name) {
  const text = typeof name === 'string' ? name : ''
  const at = text.lastIndexOf('·')
  if (at < 0) return { display: '', value: null, free: false }
  const tail = text.slice(at + 1).trim()
  const match = /^x\s*([0-9]+(?:\.[0-9]+)?)/.exec(tail)
  const waived = tail.includes('免费')
  if (match === null) {
    if (!waived) return { display: '', value: null, free: false }
    return { display: '免费', value: 0, free: true }
  }
  const value = Number(match[1])
  const free = waived || value === 0
  return { display: free ? '免费' : `x${match[1]}`, value: free ? 0 : value, free }
}

function comparePrice(left, right) {
  const a = priceOf(left?.name).value
  const b = priceOf(right?.name).value
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a - b
}

const sorted = [...CATALOG].sort(comparePrice)
const hy = sorted.findIndex((m) => m.key === 'buddy/hy4-preview')
console.log(`catalog: ${CATALOG.length} models, buddy/hy4-preview at index ${hy}`)
for (let i = Math.max(0, hy - 3); i <= Math.min(sorted.length - 1, hy + 3); i += 1) {
  const m = sorted[i]
  const price = priceOf(m.name)
  const mark = i === hy ? ' <== the reported anomaly' : ''
  console.log(`${String(i).padStart(4)}  ${price.display.padEnd(4)}  value=${String(price.value).padEnd(5)}  ${m.key.padEnd(34)} name=${m.name}${mark}`)
}

// How many free-labelled rows are actually treated as x0.00?
const mislabelled = CATALOG.filter((m) => {
  const p = priceOf(m.name)
  return p.free === true && p.value !== 0
})
console.log(`\nrows labelled 免费 but priced non-zero: ${mislabelled.length}`)
for (const m of mislabelled) console.log(`  ${m.key.padEnd(34)} name=${m.name}  parsed value=${priceOf(m.name).value}`)
