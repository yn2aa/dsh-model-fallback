// Dump every event of a DSH session log: type + the fields that matter for
// failover evidence (model sources, user messages, notice payloads).
// Usage: node scratch/dump-session.mjs <session.v4.jsonl.zstd> [grepRegex]
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const grep = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
if (!file) {
  console.error('usage: node dump-session.mjs <session.v4.jsonl.zstd> [grepRegex]');
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
      // false-positive magic inside compressed data
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

const text = decodeAll(fs.readFileSync(file));
const lines = text.split('\n').filter((l) => l.trim());
console.log('lines:', lines.length);

for (const line of lines) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  const flat = JSON.stringify(obj);
  if (grep && !grep.test(flat)) continue;
  const type = obj?.type ?? obj?.event ?? '?';
  const bits = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, `${path}[${idx}]`));
      return;
    }
    if (node.kind === 'model' && typeof node.provider === 'string') {
      bits.push(`source=${node.provider}/${node.model}`);
    }
    if (typeof node.kind === 'string' && node.kind !== 'model') {
      bits.push(`${path}.kind=${node.kind}`);
    }
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(obj, '');
  console.log(`[${type}] ${[...new Set(bits)].slice(0, 8).join('  ')}`);
}
