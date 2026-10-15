/**
 * Dump the full payload of edits the replay could not apply, so they can be
 * re-applied by hand.
 *
 * Usage: node scratch/dump-missed-edits.mjs --dir <sessions dir> [pathFilter]
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const argv = process.argv.slice(2)
const dirIndex = argv.indexOf('--dir')
const sessionsDir = argv[dirIndex + 1]
const filter = argv[dirIndex + 2] ?? ''
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
let count = 0

for (const file of files) {
  const records = []
  for (const line of decodeZstd(file).split('\n')) {
    if (line.length === 0) continue
    try { records.push(JSON.parse(line)) } catch { /* tail */ }
  }
  for (const record of records) {
    if (record.type !== 'tool/call') continue
    const data = record.data ?? {}
    const tool = data.name
    const raw = data.arguments
    const args = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})
    const target = String(args.file_path ?? '').replace(/\\/g, '/')
    if (!target.startsWith(WORKSPACE)) continue

    if (tool === 'write') { vfs.set(target, String(args.content ?? '')); continue }
    if (tool !== 'edit') continue

    const current = vfs.get(target)
    const old = args.old_string
    if (current !== undefined && typeof old === 'string' && current.includes(old)) {
      vfs.set(target, args.replace_all ? current.split(old).join(args.new_string) : current.replace(old, args.new_string))
      continue
    }
    const relative = target.slice(WORKSPACE.length + 1)
    if (filter.length > 0 && !relative.includes(filter)) continue
    count++
    console.log(`\n===== MISS ${count}: ${relative}  (callId ${data.callId}) =====`)
    console.log(`file existed in replay: ${current !== undefined}  (len ${current?.length ?? 0})`)
    console.log('--- OLD ---')
    console.log(String(old))
    console.log('--- NEW ---')
    console.log(String(args.new_string))
  }
}
console.log(`\ntotal misses${filter ? ` matching "${filter}"` : ''}: ${count}`)
