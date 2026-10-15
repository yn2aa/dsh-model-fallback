// Fire a concurrent burst at the local gateway to try to force a genuine 429
// (TPM exhaustion). Usage: node scratch/burst-429.mjs <model> [count] [promptChars] [maxTokens]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The gateway key. Read from the file the host owns; override with GATEWAY_KEY_FILE.
const keyFile = process.env.GATEWAY_KEY_FILE || join(
  process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME, '.dsh'),
  'openai-gateway', 'api-key'
);
const key = readFileSync(keyFile, 'utf8').trim();
const model = process.argv[2] ?? 'raccoon/sn-deepseek-v4-1-flash';
const count = Number(process.argv[3] ?? 12);
const promptChars = Number(process.argv[4] ?? 16000);
const maxTokens = Number(process.argv[5] ?? 2000);

const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil(promptChars / 45)).slice(0, promptChars);

async function one(i) {
  const started = Date.now();
  try {
    const res = await fetch('http://127.0.0.1:8326/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: `(${i}) Reply with a short summary.\n\n${filler}` }],
        max_tokens: maxTokens,
      }),
    });
    const text = await res.text();
    let code = null;
    let type = null;
    try {
      const parsed = JSON.parse(text);
      code = parsed?.error?.code ?? parsed?.code ?? null;
      type = parsed?.error?.type ?? parsed?.type ?? null;
    } catch {}
    return { i, status: res.status, code, type, ms: Date.now() - started, head: text.slice(0, 160) };
  } catch (error) {
    return { i, status: 'ERR', code: null, type: null, ms: Date.now() - started, head: String(error) };
  }
}

const results = await Promise.all(Array.from({ length: count }, (_, i) => one(i)));
for (const r of results) {
  console.log(`#${String(r.i).padStart(2)} ${String(r.status).padEnd(4)} code=${String(r.code).padEnd(14)} type=${String(r.type).padEnd(14)} ${r.ms}ms  ${r.head.replace(/\s+/g, ' ').slice(0, 110)}`);
}
const tally = {};
for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
console.log('tally:', JSON.stringify(tally));
