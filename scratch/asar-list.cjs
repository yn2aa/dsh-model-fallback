// Minimal ASAR reader: parse the header, list entries matching a pattern,
// optionally dump one entry's bytes to stdout.
//
// Usage: node asar-list.cjs <regex>            -> list matching paths
//        node asar-list.cjs <regex> --dump     -> print each match's text
const fs = require('fs')
const { requireAsar } = require('./asar-path.cjs')

const ASAR = requireAsar()
const pattern = process.argv[2]
const dump = process.argv.includes('--dump')

// Electron/asar layout (verified byte-for-byte against app.asar):
//   @0  u32 = 4                     (size of the first pickle's payload)
//   @4  u32 = headerPickleSize      (total size of the header pickle)
//   @8  u32 = jsonLen + 4
//   @12 u32 = jsonLen               (length of the JSON string)
//   @16 ... JSON string of jsonLen bytes
// File data begins at 8 + headerPickleSize (== 16 + jsonLen).
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
console.log(`total files: ${out.length}  matching: ${hits.length}`)

if (!dump) {
  for (const h of hits.slice(0, 200)) console.log(`${String(h.size).padStart(9)}  ${h.p}`)
} else {
  for (const h of hits) {
    const buf = Buffer.alloc(h.size)
    fs.readSync(fd, buf, 0, h.size, h.offset)
    console.log(`\n===== ${h.p} (${h.size} bytes) =====`)
    console.log(buf.toString('utf8'))
  }
}
fs.closeSync(fd)
