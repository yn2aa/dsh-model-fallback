// Extract one entry from app.asar to a local file.
// Usage: node asar-extract.cjs <asar-path-regex> <out-dir>
const fs = require('fs')
const path = require('path')
const { requireAsar } = require('./asar-path.cjs')

const ASAR = requireAsar()
const pattern = process.argv[2]
const outDir = process.argv[3]

const fd = fs.openSync(ASAR, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerPickleSize = head.readUInt32LE(4)
const jsonLen = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, headerBuf, 0, jsonLen, 16)
const header = JSON.parse(headerBuf.toString('utf8'))
const base = 8 + headerPickleSize

const out = []
function walk(node, prefix) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = `${prefix}/${name}`
    if (val.files) walk(val, p)
    else if (val.size !== undefined) out.push({ p, offset: base + Number(val.offset), size: val.size })
  }
}
walk(header, '')

const re = new RegExp(pattern, 'i')
const hits = out.filter((f) => re.test(f.p))
fs.mkdirSync(outDir, { recursive: true })
for (const h of hits) {
  const buf = Buffer.alloc(h.size)
  fs.readSync(fd, buf, 0, h.size, h.offset)
  const dest = path.join(outDir, h.p.replace(/^\//, '').replace(/[\\/]/g, '__'))
  fs.writeFileSync(dest, buf)
  console.log(`${h.size}\t${dest}`)
}
fs.closeSync(fd)
