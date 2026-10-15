// Hold a model's upstream limiter hot by firing a sustained concurrent burst,
// so a real kernel request to that model hits a genuine 429 while the burst runs.
// Usage: node scratch/hold-429.mjs <model> <seconds> [concurrency] [promptChars] [maxTokens]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The gateway key. Read from the file the host owns; override with GATEWAY_KEY_FILE.
const keyFile = process.env.GATEWAY_KEY_FILE || join(
  process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME, '.dsh'),
  'openai-gateway', 'api-key'
);
const key = readFileSync(keyFile, 'utf8').trim();
const model = process.argv[2] ?? 'raccoon/sn-deepseek-v4-1-flash';
const seconds = Number(process.argv[3] ?? 60);
const concurrency = Number(process.argv[4] ?? 10);
const promptChars = Number(process.argv[5] ?? 12000);
const maxTokens = Number(process.argv[6] ?? 1500);

const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil(promptChars / 45)).slice(0, promptChars);
const deadline = Date.now() + seconds * 1000;
const tally = {};
let sent = 0;
let first429At = null;

async function one() {
  sent += 1;
  try {
    const res = await fetch('http://127.0.0.1:8326/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: `Reply with one short word.\n\n${filler}` }],
        max_tokens: maxTokens,
      }),
    });
    const text = await res.text();
    let code = null;
    try {
      const parsed = JSON.parse(text);
      code = parsed?.error?.code ?? null;
    } catch {}
    const bucket = code === null ? String(res.status) : `${res.status}/${code}`;
    tally[bucket] = (tally[bucket] ?? 0) + 1;
    if (code === 'RATE_LIMIT' && first429At === null) {
      first429At = Date.now();
      console.log(`first RATE_LIMIT at +${first429At - (deadline - seconds * 1000)}ms`);
    }
  } catch (error) {
    const bucket = `ERR/${String(error?.name ?? 'unknown')}`;
    tally[bucket] = (tally[bucket] ?? 0) + 1;
  }
}

async function worker() {
  while (Date.now() < deadline) await one();
}

console.log(`holding ${model} hot for ${seconds}s at concurrency ${concurrency} (${promptChars} chars/req)`);
await Promise.all(Array.from({ length: concurrency }, () => worker()));
console.log(`sent=${sent} tally=${JSON.stringify(tally)}`);
