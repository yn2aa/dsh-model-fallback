/**
 * Print the providers and window-resolved models the plugin's own catalog saw.
 *
 * Source of truth: the `catalog` records the host half appends to
 * `<DSH_HOME>/model-fallback/log.ndjson`. A model only appears in `windows`
 * when `llm.resolveModelInfo(provider, model)` SUCCEEDED — which requires the
 * provider to be registered with the kernel (`registration()` throws NO_ADAPTER
 * otherwise). So this file is a reliable list of routes the kernel can actually
 * dispatch, unlike the 8326 gateway's `/v1/models` (which lists channels the
 * session may never have credentials for).
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const logPath = path.join(home, 'model-fallback', 'log.ndjson')

const lines = fs.readFileSync(logPath, 'utf8').split('\n')
let latest = null
for (const line of lines) {
  if (!line.trim()) continue
  let row
  try { row = JSON.parse(line) } catch { continue }
  if (row.kind === 'catalog' && Array.isArray(row.windows)) latest = row
}

if (latest === null) {
  console.log('no catalog record with a windows array found')
  process.exit(0)
}

const byProvider = new Map()
for (const entry of latest.windows) {
  const at = entry.indexOf('=')
  const key = at === -1 ? entry : entry.slice(0, at)
  const window = at === -1 ? '' : entry.slice(at + 1)
  const slash = key.indexOf('/')
  const provider = slash === -1 ? key : key.slice(0, slash)
  const model = slash === -1 ? '' : key.slice(slash + 1)
  if (!byProvider.has(provider)) byProvider.set(provider, [])
  byProvider.get(provider).push({ model, window })
}

console.log(`catalog record t=${latest.t} models=${latest.models} withWindow=${latest.withWindow}`)
console.log(`source=${JSON.stringify(latest.source)}`)
console.log(`registered providers seen: ${byProvider.size}`)
for (const [provider, models] of byProvider) {
  console.log(`\n## ${provider} (${models.length})`)
  for (const m of models) console.log(`   ${provider}/${m.model}  window=${m.window}`)
}
