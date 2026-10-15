// Gentle single-wave probe: fire N concurrent requests ONCE and report the
// status/code distribution. Designed to find a genuine 429 without hammering a
// channel into a ban.
// Usage: node scratch/wave-429.mjs <model> [concurrency] [promptChars] [maxTokens]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The gateway key. Read from the file the host owns; override with GATEWAY_KEY_FILE.
const keyFile = process.env.GATEWAY_KEY_FILE || join(
  process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME, '.dsh'),
  'openai-gateway', 'api-key'
);
const key = readFileSync(keyFile, 'utf8').trim();
const model = process.argv[2] ?? 'trae/deepseek-v4.1-flash';
const concurrency = Number(process.argv[3] ?? 8);
const promptChars = Number(process.argv[4] ?? 24000);
const maxTokens = Number(process.argv[5] ?? 3000);

const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil(promptChars / 45)).slice(0, promptChars);

async function one(i) {
  try {
    const res = await fetch('http://127.0.0.1:8326/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: `(${i}) Reply with one short word.\n\n${filler}` }],
        max_tokens: maxTokens,
      }),
    });
    const text = await res.text();
    let code = null;
    try {
      code = JSON.parse(text)?.error?.code ?? null;
    } catch {}
    return { i, status: res.status, code, head: text.slice(0, 140).replace(/\s+/g, ' ') };
  } catch (error) {
    return { i, status: 'ERR', code: String(error?.name ?? error), head: '' };
  }
}

const results = await Promise.all(Array.from({ length: concurrency }, (_, i) => one(i)));
for (const r of results) console.log(`#${r.i} ${String(r.status).padEnd(4)} code=${String(r.code).padEnd(14)} ${r.head}`);
const tally = {};
for (const r of results) {
  const k = r.code ? `${r.status}/${r.code}` : String(r.status);
  tally[k] = (tally[k] ?? 0) + 1;
}
console.log('tally:', JSON.stringify(tally));
