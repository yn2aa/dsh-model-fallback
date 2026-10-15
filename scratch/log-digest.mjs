/**
 * Digest `<DSH_HOME>/model-fallback/log.ndjson` — real observed shapes only.
 *
 * Written for task 7.x acceptance: before arming anything, find out what the
 * live host actually recorded. Prints the kind histogram, every non-probe record
 * in full, and the distinct `resolved` shapes the probe saw (so a redirect test
 * knows what "provider/model changed" looks like on disk).
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const logPath = path.join(home, 'model-fallback', 'log.ndjson')

const rows = []
for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
  if (!line.trim()) continue
  try { rows.push(JSON.parse(line)) } catch { /* skip bad line */ }
}

const kinds = new Map()
for (const r of rows) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1)

console.log(`log: ${logPath}`)
console.log(`lines: ${rows.length}`)
console.log('kinds:')
for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${kind}`)

console.log('\n=== non-probe records (all) ===')
for (const r of rows) {
  if (r.kind === 'probe') continue
  console.log(JSON.stringify(r))
}

console.log('\n=== probe: distinct resolved provider/model pairs ===')
const pairs = new Map()
for (const r of rows) {
  if (r.kind !== 'probe') continue
  const k = `${r.resolved?.provider}/${r.resolved?.model}`
  pairs.set(k, (pairs.get(k) ?? 0) + 1)
}
for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`)

console.log('\n=== probe: last 3 records in full ===')
for (const r of rows.filter((x) => x.kind === 'probe').slice(-3)) console.log(JSON.stringify(r))
