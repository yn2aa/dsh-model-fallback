// Content grep across app.asar text entries.
// Usage: node asar-grep.cjs <regex> [pathFilterRegex]
const fs = require('fs')
const { requireAsar } = require('./asar-path.cjs')
const ASAR = requireAsar()
const pattern = new RegExp(process.argv[2], 'i')
const pathFilter = process.argv[3] ? new RegExp(process.argv[3], 'i') : null

const fd = fs.openSync(ASAR, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerPickleSize = head.readUInt32LE(4)
const jsonLen = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, headerBuf, 0, jsonLen, 16)
const header = JSON.parse(headerBuf.toString('utf8'))
const base = 8 + headerPickleSize

const files = []
function walk(node, prefix) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = `${prefix}/${name}`
    if (val.files) walk(val, p)
    else if (val.size !== undefined && Number.isFinite(Number(val.offset))) files.push({ p, offset: base + Number(val.offset), size: val.size })
  }
}
walk(header, '')

let hits = 0
for (const f of files) {
  if (pathFilter && !pathFilter.test(f.p)) continue
  if (!/\.(js|mjs|cjs|json|yml|yaml|ts)$/.test(f.p)) continue
  if (f.size > 400000) continue
  const buf = Buffer.alloc(f.size)
  fs.readSync(fd, buf, 0, f.size, f.offset)
  const text = buf.toString('utf8')
  if (!pattern.test(text)) continue
  hits++
  console.log(`\n===== ${f.p} (${f.size} bytes) =====`)
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      console.log(`${i + 1}: ${lines[i].trim().slice(0, 300)}`)
    }
  }
  if (hits >= 12) { console.log('\n... (stopping at 12 files)'); break }
}
console.log(`\nmatching files: ${hits}`)
