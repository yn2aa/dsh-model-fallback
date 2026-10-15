/**
 * Pre-flight the host wiring WITHOUT a running harness.
 *
 * `apply()` is called with a stub ctx, then the three registered listeners are
 * driven through one complete failover cycle. This catches load-time throws and
 * wiring mistakes (wrong seam, wrong return shape, wrong grouping key) that unit
 * tests of the pure modules cannot see — a throw here would break every
 * workspace, which is exactly the failure this plugin already caused once.
 *
 *   node scratch/preflight.mjs [path/to/lib/index.js]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const arg = process.argv[2]
// On Windows a bare absolute path is not a valid ESM specifier — only file: URLs are.
const entry = arg === undefined
  ? new URL('../lib/index.js', import.meta.url).href
  : (arg.startsWith('file:') ? arg : pathToFileURL(path.resolve(arg)).href)

let failures = 0
function check(label, ok, detail) {
  if (ok) { console.log(`  ok   ${label}`) } else { failures += 1; console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

// Isolated data dir so the pre-flight never touches the live configuration.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mfb-preflight-'))
process.env.DSH_HOME = home
const dataDir = path.join(home, 'model-fallback')
fs.mkdirSync(dataDir, { recursive: true })

const chainsPath = path.join(dataDir, 'chains.json')
const CHAINS = [
  {
    primary: 'buddy/deepseek-v4-pro',
    candidates: ['buddy/deepseek-v4-flash'],
    triggers: { rate_limit: true, server_error: false, timeout_network: false },
    maxAttempts: 3,
  },
  {
    // Every trigger enabled: used to drive the whole chain to exhaustion.
    // The candidate must be a model no earlier section failed, because cooldowns
    // are recorded per model for the whole session (D5) — reusing one would make
    // it correctly skip, and the exhaustion check would pass for the wrong reason.
    primary: 'lobsterai/deepseek-flash',
    candidates: ['buddy/glm-5.3'],
    triggers: { rate_limit: true, server_error: true, timeout_network: true },
    maxAttempts: 3,
  },
]
fs.writeFileSync(chainsPath, JSON.stringify(CHAINS, null, 2))
const chainsBefore = fs.readFileSync(chainsPath, 'utf8')

// --- stub ctx -----------------------------------------------------------------
const listeners = new Map()
const routes = []
let effects = 0
const logLines = []

function record(event, fn, opts) {
  const list = listeners.get(event) ?? []
  // cordis: register() pushes to the tail, `{prepend:true}` unshifts to the head.
  // The head is the OUTERMOST listener, so it runs first and owns the outcome.
  if (opts?.prepend === true) { list.unshift({ fn, prepend: true }) } else { list.push({ fn, prepend: false }) }
  listeners.set(event, list)
  return () => {}
}

/**
 * Reproduce cordis's waterfall exactly (`@deepseek-ai/cordis/lib/index.js:317`):
 *   const cbs = dispatch(); const inner = args.pop()
 *   const next = () => (cbs.shift() ?? inner)(...args)
 *   args.push(next); return next()
 * A listener's return value is what the caller sees; `next()` runs the following
 * listener. Getting this wrong hides real ordering bugs.
 */
function dispatch(event, payload, inner) {
  const cbs = (listeners.get(event) ?? []).map((l) => l.fn)
  const next = () => (cbs.shift() ?? inner)(payload, next)
  return next()
}

const llm = {
  listProviders: async () => [{ provider: 'buddy', name: 'Buddy' }],
  listModels: async () => [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }, { id: 'glm-5.3' }],
  resolveModelInfo: async (_p, model) => ({ context: { contextWindow: model.includes('flash') ? 200000 : 1000000 } }),
}

const ctx = {
  logger: {
    info: (m) => logLines.push(String(m)),
    warn: (m) => logLines.push(`WARN ${m}`),
    error: (m) => logLines.push(`ERROR ${m}`),
  },
  get(name) {
    if (name === 'webServer') return { register: (route) => { routes.push(route); return () => {} } }
    if (name === 'llm') return llm
    return undefined
  },
  on: record,
  effect(fn) { effects += 1; const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  // Mirrors cordis: `inject(deps, cb)` runs `cb` once those services exist. The
  // stub already has them, so it calls back immediately — but through the same
  // path the real composition uses, which is where the route used to get lost.
  inject(deps, callback) {
    callback({ get: (name) => ctx.get(name), effect: (fn, label) => ctx.effect(fn, label) })
  },
}

// --- load & apply -------------------------------------------------------------
console.log(`entry: ${entry}`)
const mod = await import(entry)
const { apply } = mod
await apply(ctx, {})

console.log('\n[1] load-time registration')
check('apply() did not throw', true)
for (const event of ['agent/request', 'agent/request-error', 'agent/pre-step']) {
  const list = listeners.get(event) ?? []
  check(`listens on ${event}`, list.length > 0, `listeners=${list.length}`)
  check(`${event} listener is prepend:true`, list.every((l) => l.prepend))
}
check('registers the settings API', routes.some((r) => r.path === '/api/model-fallback'), JSON.stringify(routes.map((r) => r.path)))
check('uses ctx.effect for disposal', effects > 0, `effects=${effects}`)
check('logs a self-report', logLines.some((l) => l.includes('model-fallback')), logLines.join(' | '))

function call(event, payload, next) {
  return dispatch(event, payload, next)
}

// --- [2] a request with a chain configured: attempt 0 must NOT be taken over ---
console.log('\n[2] attempt 0 is sent to the primary untouched')
const SESSION = { session: { id: 'session-preflight' } }
/** The kernel fuses `agent` into every payload (probe measured `[turn,step,signal,agent]`). */
const at = (turn, step) => ({ turn, step, signal: {}, agent: SESSION })
const primary = { provider: 'buddy', model: 'deepseek-v4-pro', reasoningEffort: 'high' }
const seed = Object.freeze({ ...primary })
const first = await call('agent/request', at(41, 1), async () => seed)
check('attempt 0 keeps the primary provider', first?.provider === 'buddy', JSON.stringify(first))
check('attempt 0 keeps the primary model', first?.model === 'deepseek-v4-pro', JSON.stringify(first))

// --- [3] a rate limit on the primary must ask the loop to retry ---------------
console.log('\n[3] a rate limit asks the kernel to retry (so a redirect can happen)')
const action = await call(
  'agent/request-error',
  { turn: 41, step: 1, provider: 'buddy', failure: { code: 'RATE_LIMIT', message: 'rate limit reached for TPM' }, signal: {}, agent: SESSION },
  async () => undefined,
)
check('request-error returns {kind:"retry"}', action?.kind === 'retry', JSON.stringify(action))

// --- [4] the retry re-enters agent/request and is redirected to the candidate --
console.log('\n[4] the retry is redirected to the chain candidate')
const second = await call('agent/request', at(41, 1), async () => seed)
check('candidate provider/model applied', second?.provider === 'buddy' && second?.model === 'deepseek-v4-flash', JSON.stringify(second))
check('the frozen seed was not mutated', seed.model === 'deepseek-v4-pro')
check('reasoningEffort is preserved across the redirect', second?.reasoningEffort === 'high', JSON.stringify(second))

// --- [5] the failure class that was NOT enabled must not retry -----------------
console.log('\n[5] a disabled trigger kind never redirects')
const other = await call(
  'agent/request-error',
  { turn: 42, step: 1, provider: 'buddy', failure: { code: 'SERVER', message: 'boom' }, signal: {}, agent: SESSION },
  async () => undefined,
)
check('unmatched trigger returns no retry', other?.kind !== 'retry', JSON.stringify(other))

// --- [6] the notice is queued and drained on the next pre-step -----------------
console.log('\n[6] the redirect is visible in the session')
const decision = await call(
  'agent/pre-step',
  { messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }], turn: 41, step: 2, signal: {}, agent: { session: { id: 'session-preflight' } } },
  async () => ({ kind: 'enter', messages: [] }),
)
const messages = decision?.messages ?? []
const notice = messages.find((m) => m?.source?.kind === 'model-fallback')
check('a model-fallback notice was added', notice !== undefined, JSON.stringify(messages).slice(0, 400))
check('the notice is a valid user message', notice?.role === 'user' && Array.isArray(notice?.content) && typeof notice?.id === 'string')
check('the notice names the original failure', typeof notice?.content?.[0]?.text === 'string' && notice.content[0].text.includes('rate limit reached for TPM'), notice?.content?.[0]?.text)
check('the notice names from and to', notice?.content?.[0]?.text?.includes('buddy/deepseek-v4-pro') && notice.content[0].text.includes('buddy/deepseek-v4-flash'), notice?.content?.[0]?.text)
check('startsRequestSeries survives the spread', decision?.kind === 'enter')

// the notice must be consumed exactly once
const again = await call('agent/pre-step', { messages: [], turn: 41, step: 3, signal: {}, agent: { session: { id: 'session-preflight' } } }, async () => ({ kind: 'enter', messages: [] }))
check('the notice is not repeated on the next step', (again?.messages ?? []).every((m) => m?.source?.kind !== 'model-fallback'))

// --- [7] task 5.7: failover never rewrites the user configuration --------------
console.log('\n[7] the user configuration is untouched (task 5.7)')
check('chains.json byte-identical after a full cycle', fs.readFileSync(chainsPath, 'utf8') === chainsBefore)

// --- [8] a fresh request series starts from the primary again ------------------
console.log('\n[8] the next request series still starts from the primary')
const fresh = await call('agent/request', { turn: 43, step: 1, signal: {} }, async () => seed)
check('new turn/step uses the primary again', fresh?.model === 'deepseek-v4-pro', JSON.stringify(fresh))

// --- [9] the settings API answers ---------------------------------------------
console.log('\n[9] the settings API answers over the stub webServer')
const route = routes.find((r) => r.path === '/api/model-fallback')
check('the route is a prefix route', route?.kind === 'prefix', JSON.stringify(route?.kind))
async function fetchApi(method, url) {
  const chunks = []
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { chunks.push(body ?? '') },
  }
  await route.handler({ method, url, on() {}, headers: {}, async *[Symbol.asyncIterator]() {} }, res)
  return { status: res.status, text: chunks.join(''), headers: res.headers }
}
const listed = await fetchApi('GET', '/api/model-fallback/models')
check('GET /models returns 200', listed.status === 200, `${listed.status} ${listed.text.slice(0, 200)}`)
let parsed
try { parsed = JSON.parse(listed.text) } catch { parsed = null }
check('GET /models returns JSON with a catalog', Array.isArray(parsed?.models ?? parsed?.catalog), listed.text.slice(0, 300))
check('GET /models sets a JSON content type', String(listed.headers?.['content-type'] ?? '').includes('application/json'), JSON.stringify(listed.headers))

const missing = await fetchApi('GET', '/api/model-fallback/nope')
check('an unknown route is 404', missing.status === 404, `${missing.status} ${missing.text.slice(0, 120)}`)

// --- [11] exhaustion reports the PRIMARY failure, not the last candidate's -----
console.log('\n[11] an exhausted chain reports the PRIMARY failure')
const exhaustSeed = Object.freeze({ provider: 'lobsterai', model: 'deepseek-flash' })
const e0 = await call('agent/request', at(50, 1), async () => exhaustSeed)
check('the second chain starts at its own primary', e0?.model === 'deepseek-flash', JSON.stringify(e0))
const eRetry = await call(
  'agent/request-error',
  { turn: 50, step: 1, provider: 'lobsterai', failure: { code: 'RATE_LIMIT', message: 'PRIMARY-RATE-LIMIT' }, signal: {}, agent: SESSION },
  async () => undefined,
)
check('the primary failure asks for a retry', eRetry?.kind === 'retry', JSON.stringify(eRetry))
const e1 = await call('agent/request', at(50, 1), async () => exhaustSeed)
check('the candidate is tried next', e1?.model === 'glm-5.3', JSON.stringify(e1))
check(
  'a model cooled by an EARLIER section is skipped as a candidate',
  e1?.model !== 'deepseek-v4-pro',
  JSON.stringify(e1),
)
let thrown = null
try {
  await call(
    'agent/request-error',
    { turn: 50, step: 1, provider: 'buddy', failure: { code: 'SERVER', message: 'CANDIDATE-502' }, signal: {}, agent: SESSION },
    async () => undefined,
  )
} catch (error) {
  thrown = error
}
check('exhaustion raises an error instead of asking for another retry', thrown !== null)
check(
  'the raised error carries the PRIMARY failure',
  String(thrown?.message ?? '').includes('PRIMARY-RATE-LIMIT'),
  String(thrown?.message ?? ''),
)
check(
  'the raised error is not just the candidate failure',
  !String(thrown?.message ?? '').startsWith('CANDIDATE-502'),
  String(thrown?.message ?? ''),
)
check(
  'the primary failure code survives',
  thrown?.code === 'RATE_LIMIT' || thrown?.failure?.code === 'RATE_LIMIT',
  JSON.stringify(thrown?.code ?? thrown?.failure?.code ?? null),
)

// The redirect that led into the exhausted chain must also be visible.
const exhaustNotice = await call('agent/pre-step', { messages: [], ...at(50, 2) }, async () => ({ kind: 'enter', messages: [] }))
const exhaustMessage = (exhaustNotice?.messages ?? []).find((m) => m?.source?.kind === 'model-fallback')
check('the redirect that preceded exhaustion is visible too', exhaustMessage !== undefined)
check(
  'that notice names the primary failure',
  String(exhaustMessage?.content?.[0]?.text ?? '').includes('PRIMARY-RATE-LIMIT'),
  String(exhaustMessage?.content?.[0]?.text ?? ''),
)

// --- [12] task 7.4: no chains ≡ the behaviour before installation --------------
console.log('\n[12] without chains the plugin stays out of the way (task 7.4)')
// A session that never failed over: the notice queue is per session, so reusing
// the earlier one would drain a genuinely pending notice and prove nothing.
const BARE = { session: { id: 'session-bare' } }
const bareAt = (turn, step) => ({ turn, step, signal: {}, agent: BARE })
fs.rmSync(chainsPath, { force: true })
const bare = await call('agent/request', bareAt(60, 1), async () => seed)
check('a request with no chains is returned untouched', bare === seed, JSON.stringify(bare))
const bareError = await call(
  'agent/request-error',
  { turn: 60, step: 1, provider: 'buddy', failure: { code: 'RATE_LIMIT', message: 'x' }, signal: {}, agent: BARE },
  async () => 'DOWNSTREAM',
)
check('no chains means the downstream decision is passed through', bareError === 'DOWNSTREAM', JSON.stringify(bareError))
const bareStep = await call('agent/pre-step', { messages: [], ...bareAt(60, 2) }, async () => ({ kind: 'enter', messages: [] }))
check('no chains means no notice is added', (bareStep?.messages ?? []).every((m) => m?.source?.kind !== 'model-fallback'))

// --- [13] the kill switch disarms everything ----------------------------------
console.log('\n[13] the kill switch disarms the runtime')
fs.writeFileSync(path.join(dataDir, 'disable'), 'off')
const afterKill = await call('agent/request-error', { turn: 44, step: 1, provider: 'buddy', failure: { code: 'RATE_LIMIT', message: 'x' }, signal: {}, agent: SESSION }, async () => undefined)
check('a disabled plugin asks for no retry', afterKill?.kind !== 'retry', JSON.stringify(afterKill))

fs.rmSync(home, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'PRE-FLIGHT PASSED' : `PRE-FLIGHT FAILED (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
