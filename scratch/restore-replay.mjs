/**
 * Replay a DSH session log to reconstruct the files a tool sequence produced.
 *
 * A session log is an append-only JSONL of `tool/call` records. For file work
 * the calls carry the full payload: `write` holds the whole file, `edit` holds
 * an exact old/new pair, `ops_replace` holds a regex pair. Replaying them in
 * order therefore rebuilds the final on-disk state — which is how a directory
 * deleted outside the session can be recovered.
 *
 * Usage: node scratch/restore-replay.mjs <outDir> <session.v4.jsonl.zstd...>
 *        node scratch/restore-replay.mjs <outDir> --dir <sessions workspace dir>
 *
 * Replay every session for a workspace, oldest first. A single session only
 * shows the edits it made itself: a file created in an earlier session and
 * edited later replays with its original body and silently loses those edits.
 * The chronological pass gives every edit the base it actually saw.
 *
 * Correctness is established by comparison, not by hope: replay the files that
 * still exist on disk (lib/*.js) and require a byte-for-byte match before
 * trusting the files that do not.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const argv = process.argv.slice(2)
if (argv.length < 2) {
  console.error('usage: node scratch/restore-replay.mjs <outDir> <session.v4.jsonl.zstd...>')
  console.error('       node scratch/restore-replay.mjs <outDir> --dir <sessions workspace dir>')
  process.exit(2)
}

const outArg = argv[0]
let sessionFiles
if (argv[1] === '--dir') {
  const dir = argv[2]
  sessionFiles = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, 'session.v4.jsonl.zstd'))
    .filter((file) => fs.existsSync(file))
} else {
  sessionFiles = argv.slice(1)
}
sessionFiles.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
if (sessionFiles.length === 0) {
  console.error('no session files found')
  process.exit(2)
}

// The workspace these sessions belong to. Override with WORKSPACE=<path>.
const WORKSPACE = process.env.WORKSPACE || process.cwd()

/** A zstd stream may hold many frames; decode each and concatenate. */
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
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch {
      /* a truncated tail frame is not fatal */
    }
  }
  return parts.join('')
}

const norm = (value) => String(value).replace(/\\/g, '/')

function asArgs(data) {
  const raw = data?.arguments ?? data?.args ?? data?.input ?? data?.params
  if (raw === undefined) return {}
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return raw
}

/** Literal replacement, honouring `replace_all`. Returns null when not found. */
function applyEdit(current, oldString, newString, replaceAll) {
  if (typeof oldString !== 'string' || oldString.length === 0) return null
  if (!current.includes(oldString)) return null
  return replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString)
}

/** `ops_replace`: regex (or literal) replacement, skipped when it is a dry run. */
function applyReplace(current, args) {
  if (args.dry_run === true) return null
  const flags = `${args.case_insensitive ? 'i' : ''}${args.dot_all ? 's' : ''}`
  const source = args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : args.pattern
  const re = new RegExp(source, `g${flags}`)
  if (!re.test(current)) return null
  re.lastIndex = 0
  return current.replace(re, args.replacement ?? '')
}

const vfs = new Map()
const trace = new Map()
const misses = []
const stats = { write: 0, edit: 0, editApplied: 0, editMissed: 0, replace: 0, replaceApplied: 0, replaceMissed: 0, replaceDry: 0, skippedPath: 0 }

function recordMiss(file, tool, reason, oldString) {
  misses.push({
    file: file.slice(WORKSPACE.length + 1),
    tool,
    reason,
    old: typeof oldString === 'string' ? oldString.slice(0, 90).replace(/\n/g, '\\n') : '',
  })
}

function note(file, kind, detail) {
  const list = trace.get(file) ?? []
  list.push(`${kind}${detail ? ` (${detail})` : ''}`)
  trace.set(file, list)
}

// Decode every session first, then order them by their own first timestamp.
// mtime is the last write, so a long-running early session would sort last and
// its edits would be replayed against a base that did not exist yet.
const sessions = sessionFiles.map((file) => {
  const records = []
  for (const line of decodeZstd(file).split('\n')) {
    if (line.length === 0) continue
    try { records.push(JSON.parse(line)) } catch { /* partial tail */ }
  }
  const firstTime = records.find((record) => Number.isFinite(record?.time))?.time ?? 0
  return { file, records, firstTime }
})
sessions.sort((a, b) => a.firstTime - b.firstTime)

let totalRecords = 0
for (const session of sessions) {
  totalRecords += session.records.length

  for (const record of session.records) {
    if (record.type !== 'tool/call') continue

    const data = record.data ?? {}
    const tool = data.name ?? data.tool ?? data.toolName
    const args = asArgs(data)

    if (tool === 'write') {
      const file = norm(args.file_path)
      if (!file.startsWith(WORKSPACE)) { stats.skippedPath++; continue }
      vfs.set(file, String(args.content ?? ''))
      note(file, 'write')
      stats.write++
    } else if (tool === 'edit') {
      const file = norm(args.file_path)
      if (!file.startsWith(WORKSPACE)) { stats.skippedPath++; continue }
      const current = vfs.get(file)
      if (current === undefined) { stats.editMissed++; note(file, 'edit-missed', 'file not yet written'); recordMiss(file, 'edit', 'file not yet written', args.old_string); continue }
      const next = applyEdit(current, args.old_string, args.new_string, args.replace_all === true)
      if (next === null) { stats.editMissed++; note(file, 'edit-missed', 'old_string absent'); recordMiss(file, 'edit', 'old_string absent', args.old_string); continue }
      vfs.set(file, next)
      note(file, 'edit')
      stats.edit++
      stats.editApplied++
    } else if (tool === 'ops_replace') {
      const target = norm(args.path)
      const candidates = []
      if (vfs.has(target)) candidates.push(target)
      // A directory target with a glob means every already-known file under it.
      for (const known of vfs.keys()) {
        if (known !== target && known.startsWith(`${target}/`)) candidates.push(known)
      }
      if (candidates.length === 0) { stats.replaceMissed++; continue }
      for (const file of candidates) {
        if (Array.isArray(args.glob) && args.glob.length > 0) {
          const base = file.split('/').pop()
          const ok = args.glob.some((pattern) => {
            const negated = pattern.startsWith('!')
            const body = negated ? pattern.slice(1) : pattern
            const re = new RegExp(`^${body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
            return negated ? !re.test(base) : re.test(base)
          })
          if (!ok) continue
        }
        const next = applyReplace(vfs.get(file), args)
        if (next === null) {
          if (args.dry_run === true) stats.replaceDry++
          else stats.replaceMissed++
          continue
        }
        vfs.set(file, next)
        note(file, 'replace')
        stats.replaceApplied++
      }
      stats.replace++
    }
  }
}

fs.mkdirSync(outArg, { recursive: true })
let written = 0
for (const [file, content] of vfs) {
  const relative = file.slice(WORKSPACE.length + 1)
  const target = path.join(outArg, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
  written++
}

console.log(`replayed ${sessions.length} session(s), ${totalRecords} records; wrote ${written} files`)
console.log(JSON.stringify(stats))
console.log(`\nmissed edits (${misses.length}):`)
for (const miss of misses) {
  console.log(`  ${miss.file}  [${miss.reason}]  old="${miss.old}"`)
}
console.log('\nfiles under dsh-model-fallback/:')
for (const file of [...vfs.keys()].sort()) {
  const relative = file.slice(WORKSPACE.length + 1)
  if (!relative.startsWith('dsh-model-fallback/')) continue
  const content = vfs.get(file)
  console.log(`  ${String(content.length).padStart(8)}  ${relative}  [${(trace.get(file) ?? []).length} ops]`)
}
