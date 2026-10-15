// Reads a DSH session log and prints the model `source` recorded on assistant
// messages — independent proof of which model actually served a request.
//
// The .zstd file is a CONCATENATION of many independent zstd frames (one per
// append), and zstdDecompressSync only returns the first frame. So we split on
// the zstd magic number and decode each frame separately.
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
if (!file) {
  console.error('usage: node read-session-sources.mjs <session.v4.jsonl.zstd>');
  process.exit(2);
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decodeAll(buf) {
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    offsets.push(i);
    i += 4;
  }
  if (offsets.length === 0) return buf.toString('utf8');

  const parts = [];
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)));
    } catch {
      // A false-positive magic inside compressed data: skip it.
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

const text = decodeAll(fs.readFileSync(file));
const lines = text.split('\n').filter((l) => l.trim());
console.log('log lines:', lines.length);

const sources = [];
for (const line of lines) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (
      node.kind === 'model' &&
      typeof node.provider === 'string' &&
      typeof node.model === 'string'
    ) {
      sources.push({ provider: node.provider, model: node.model });
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(obj);
}

console.log('model source entries:', sources.length);
const counts = new Map();
for (const s of sources) {
  const k = s.provider + '/' + s.model;
  counts.set(k, (counts.get(k) || 0) + 1);
}
console.log('--- counts ---');
for (const [k, v] of counts) console.log(v, k);
console.log('--- last 12 ---');
for (const s of sources.slice(-12)) console.log(s.provider + '/' + s.model);
