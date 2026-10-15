// Extract the failover notice text (source.kind === 'model-fallback') from a
// DSH session log. Usage: node scratch/notice-text.mjs <session.v4.jsonl.zstd>
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
if (!file) {
  console.error('usage: node notice-text.mjs <session.v4.jsonl.zstd>');
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
    } catch {}
  }
  return Buffer.concat(parts).toString('utf8');
}

const text = decodeAll(fs.readFileSync(file));
for (const line of text.split('\n')) {
  if (!line.trim()) continue;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node.kind === 'model-fallback') found.push(node);
    for (const v of Object.values(node)) walk(v);
  };
  walk(obj);
  for (const source of found) {
    console.log('type:', obj?.type ?? '?');
    console.log('source:', JSON.stringify(source));
    const content = JSON.stringify(obj);
    const idx = content.indexOf('模型改派');
    if (idx !== -1) console.log('text:', content.slice(idx, idx + 400));
    console.log('---');
  }
}
