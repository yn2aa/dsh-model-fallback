/**
 * Verify that every edit the replay could not apply had ALSO failed in the
 * original session.
 *
 * The replay is only trustworthy if its "misses" are not replay artefacts but
 * real history: the agent issued an `edit` whose `old_string` was absent, the
 * tool returned an error, and the file never changed. Each `tool/call` carries
 * a `callId` and the following `tool/result` carries the matching one, so the
 * two can be paired exactly.
 *
 * Usage: node scratch/verify-replay-misses.mjs --dir <sessions workspace dir>
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const argv = process.argv.slice(2)
const dirIndex = argv.indexOf('--dir')
const sessionsDir = dirIndex >= 0 ? argv[dirIndex + 1] : null
if (sessionsDir === null) {
  console.error('usage: node scratch/verify-replay-misses.mjs --dir <sessions workspace dir>')
  process.exit(2)
}

// The workspace these sessions belong to. Override with WORKSPACE=<path>.
const WORKSPACE = process.env.WORKSPACE || process.cwd()

function decodeZstd(file) {
  const buf = fs.readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let cursor = 0
  for (;;) {
    const at = buf.indexOf(magic, cursor)
    if (at < 0) break
    starts.push(at)
    cursor = at + 4
  }
  if (starts.length === 0) return buf.toString('utf8')
  const parts = []
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index]
    const end = index + 1 < starts.length ? starts[index + 1] : buf.length
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')) } catch { /* tail */ }
  }
  return parts.join('')
}

const files = fs.readdirSync(sessionsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(sessionsDir, entry.name, 'session.v4.jsonl.zstd'))
  .filter((file) => fs.existsSync(file))
files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)

const vfs = new Map()
let applied = 0
let missed = 0
const unexplained = []

for (const file of files) {
  const records = []
  for (const line of decodeZstd(file).split('\n')) {
    if (line.length === 0) continue
    try { records.push(JSON.parse(line)) } catch { /* partial tail */ }
  }

  // Index every result by its callId so a call can be paired with its outcome.
  const resultByCall = new Map()
  for (const record of records) {
    if (record.type !== 'tool/result') continue
    const data = record.data ?? {}
    const callId = data.toolCallId ?? data.callId ?? data.message?.toolCallId
    if (callId !== undefined) resultByCall.set(callId, data)
  }

  for (const record of records) {
    if (record.type !== 'tool/call') continue
    const data = record.data ?? {}
    const tool = data.name
    if (tool !== 'edit' && tool !== 'write') continue
    const raw = data.arguments
    const args = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})
    const target = String(args.file_path ?? '').replace(/\\/g, '/')
    if (!target.startsWith(WORKSPACE)) continue

    if (tool === 'write') {
      vfs.set(target, String(args.content ?? ''))
      continue
    }

    const current = vfs.get(target)
    const old = args.old_string
    const found = current !== undefined && typeof old === 'string' && current.includes(old)
    const outcome = resultByCall.get(data.callId)
    const errored = outcome !== undefined && outcome.error !== undefined

    if (found) {
      applied++
      vfs.set(target, args.replace_all ? current.split(old).join(args.new_string) : current.replace(old, args.new_string))
    } else {
      missed++
      const relative = target.slice(WORKSPACE.length + 1)
      if (!errored) {
        unexplained.push({ file: relative, callId: data.callId, reason: current === undefined ? 'not-yet-written' : 'old_string-absent-but-tool-succeeded' })
      }
    }
  }
}

console.log(`applied: ${applied}   missed: ${missed}`)
console.log(`misses WITHOUT a matching tool error (these would be replay bugs): ${unexplained.length}`)
for (const item of unexplained) console.log(`  ${item.file}  [${item.reason}]  ${item.callId}`)
