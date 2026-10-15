// List unique package names under a prefix inside app.asar's header JSON.
// Usage: node scratch/asar-pkgs.cjs [pathPrefix]
//   node scratch/asar-pkgs.cjs "dsh/node_modules/@deepseek-ai/"
const fs = require('node:fs');
const { requireAsar } = require('./asar-path.cjs');

const ASAR = requireAsar();
const prefix = process.argv[2] ?? '';

const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerPickleSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const headerBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, headerBuf, 0, jsonLen, 16);
const header = JSON.parse(headerBuf.toString('utf8'));
fs.closeSync(fd);

const out = [];
function walk(node, path) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = `${path}/${name}`;
    if (val.files) walk(val, p);
    else if (val.size !== undefined) out.push(p);
  }
}
walk(header, '');

const depths = new Map();
const want = prefix.startsWith('/') ? prefix : `/${prefix}`;
for (const p of out) {
  if (want && !p.startsWith(want)) continue;
  const rest = p.slice(want.length);
  const seg = rest.split('/')[0];
  if (!seg) continue;
  if (rest.includes('/')) {
    depths.set(seg, (depths.get(seg) ?? 0) + 1);
  }
}
const names = [...depths.keys()].sort();
console.log(`prefix=${prefix || '(all)'} packages=${names.length}`);
for (const n of names) console.log(`${String(depths.get(n)).padStart(6)}  ${n}`);
