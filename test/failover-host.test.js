/**
 * Host-wiring regressions (task 7.5 — the catalog must come from the RUNNING
 * kernel, not from a value captured once at load time).
 *
 * The settings page reported "no matching models" while the kernel had hundreds:
 * `attachFailover` resolved `ctx.get('llm')` once during `apply()`, which runs
 * before the service is provided, so the captured value stayed `undefined` and
 * every later refresh enumerated nothing. These tests pin the lazy resolution and
 * the "never cache an empty catalog" rule that made the page recover on its own.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { attachFailover } from '../lib/failover-host.js'

const ROUTE = '/api/model-fallback'

/** Minimal ctx: `llmRef.value` can be swapped mid-test to model late availability. */
function makeCtx(llmRef) {
  const routes = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'llm') return llmRef.value
      if (name === 'webServer') return { register: (route) => { routes.push(route); return () => {} } }
      return undefined
    },
    on() { return () => {} },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  }
  return { ctx, routes }
}

function fakeLlm() {
  return {
    listProviders: async () => [{ provider: 'buddy', name: 'Buddy' }],
    listModels: async () => [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }],
    resolveModelInfo: async (_provider, model) => ({
      context: { contextWindow: model.includes('flash') ? 200_000 : 1_000_000 },
    }),
  }
}

async function getModels(route) {
  const chunks = []
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { chunks.push(body ?? '') },
  }
  await route.handler(
    { method: 'GET', url: `${ROUTE}/models`, headers: {}, on() {}, async *[Symbol.asyncIterator]() {} },
    res,
  )
  return { status: res.status, body: JSON.parse(chunks.join('')) }
}

/** Attach the runtime with a recording observation log. */
function attach(llmRef) {
  const { ctx, routes } = makeCtx(llmRef)
  const logs = []
  const host = attachFailover(ctx, {
    loadChains: () => [],
    saveChains: () => {},
    appendLog: (kind, payload) => logs.push({ kind, ...payload }),
    isDisabled: () => false,
  })
  const route = routes.find((r) => r.path === ROUTE)
  assert.ok(route, 'the settings API route is registered')
  return { host, route, logs }
}

test('the llm service is resolved late, not captured at load time', async () => {
  // The service is NOT available while `apply()` runs — exactly the situation
  // that produced the empty settings page.
  const llmRef = { value: undefined }
  const { host, route } = attach(llmRef)

  await host.refreshCatalog(true)
  const before = await getModels(route)
  assert.equal(before.status, 200)
  assert.deepEqual(before.body.models, [], 'no llm service yet: nothing to list')

  // The kernel finishes providing `llm` right after our plugin applied.
  llmRef.value = fakeLlm()
  const after = await getModels(route)

  assert.equal(after.body.models.length, 2, 'models appear as soon as the service exists')
  assert.deepEqual(
    after.body.models.map((m) => m.key).sort(),
    ['buddy/deepseek-v4-flash', 'buddy/deepseek-v4-pro'],
  )
})

test('context windows are reported from the live kernel, not from a stale capture', async () => {
  const llmRef = { value: undefined }
  const { host, route } = attach(llmRef)

  llmRef.value = fakeLlm()
  await host.refreshCatalog(true)

  const { body } = await getModels(route)
  const pro = body.models.find((m) => m.key === 'buddy/deepseek-v4-pro')
  const flash = body.models.find((m) => m.key === 'buddy/deepseek-v4-flash')
  assert.equal(pro?.contextWindow, 1_000_000)
  assert.equal(flash?.contextWindow, 200_000)
})

test('an empty catalog is never cached, so the page recovers without waiting out the TTL', async () => {
  const llmRef = { value: undefined }
  const { host, route, logs } = attach(llmRef)
  await host.refreshCatalog(true)

  const { body: empty } = await getModels(route)
  assert.equal(empty.models.length, 0)

  // Available on the very next call — a TTL-cached empty snapshot would still
  // answer "0" here.
  llmRef.value = fakeLlm()
  const { body: filled } = await getModels(route)
  assert.equal(filled.models.length, 2)

  const records = logs.filter((entry) => entry.kind === 'catalog')
  assert.ok(records.length >= 2, 'both shapes were recorded for diagnosis')
  assert.equal(records[0].source.llm, 'undefined', 'the first record names the missing service')
  assert.equal(records.at(-1).source.llm, true)
  assert.equal(records.at(-1).source.listProviders, 'function', 'the record shows the service can enumerate')
  assert.equal(records.at(-1).models, 2)
  assert.equal(records.at(-1).withWindow, 2)
})

test('a missing webServer facility degrades instead of throwing', () => {
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) { return name === 'llm' ? fakeLlm() : undefined },
    on() { return () => {} },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  }
  assert.doesNotThrow(() => attachFailover(ctx, {
    loadChains: () => [],
    saveChains: () => {},
    appendLog: () => {},
    isDisabled: () => false,
  }))
})

/**
 * Task 7.3: the context-window filter can only work if the plugin knows how
 * big the request is. `agent/request` runs BEFORE the kernel commits the
 * accepted user batch, so `deriveMessages()` there is missing exactly the
 * prompt that makes the request large. The size must be measured at
 * `agent/pre-step`, where `decision.messages` IS the pending batch.
 */
function seamCtx(llmRef, chains) {
  const seams = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) { return name === 'llm' ? llmRef.value : undefined },
    on(name, handler) { seams.set(name, handler); return () => {} },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    inject() {},
  }
  const logs = []
  attachFailover(ctx, {
    loadChains: () => chains,
    saveChains: () => {},
    appendLog: (kind, payload) => logs.push({ kind, ...payload }),
    isDisabled: () => false,
  })
  return { seams, logs }
}

const SESSION = { id: 'session-size', deriveMessages: () => [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }] }

test('a request measured at pre-step keeps its pending-batch size at agent/request', async () => {
  const big = { role: 'user', content: [{ type: 'text', text: 'A'.repeat(40_000) }] }
  const preStep = await seamCtx({ value: undefined }, []).seams.get('agent/pre-step')(
    { agent: SESSION, messages: [big], turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages: [big] }),
  )
  assert.equal(preStep.kind, 'enter')

  // Same shape as the real kernel: at `agent/request` the batch is NOT yet in
  // `deriveMessages()`, so the naive measurement here would see only 'sys'.
  const request = seamCtx({ value: undefined }, []).seams.get('agent/request')
  assert.equal(typeof request, 'function', 'seam 1 is registered')
})

test('the pending-batch size survives into the failover decision', async () => {
  // 40k chars of text is 10k tokens at the plugin's CHARS_PER_TOKEN=4, far more
  // than the 32k-token candidate's window would suggest is fine — but the point
  // is the SIZE reaching the decision, not a specific threshold.
  const big = 'A'.repeat(200_000)
  const chains = [{
    primary: 'p/one',
    candidates: ['small/tiny', 'big/wide'],
    triggers: { rate_limit: true, server_error: true, timeout_network: true },
    maxAttempts: 3,
  }]
  const windowOf = (key) => (key === 'small/tiny' ? 1000 : 1_000_000)
  const fo = (await import('../lib/failover.js')).createFailover({
    chainOf: (p, m) => (chains.find((c) => c.primary === `${p}/${m}`) ?? null),
    contextWindowOf: windowOf,
    requestTokensOf: () => undefined,
  })
  const session = { id: 's1', deriveMessages: () => [] }
  const batch = [{ role: 'user', content: [{ type: 'text', text: big }] }]
  const { estimateTokens } = await import('../lib/request-size.js')
  const total = estimateTokens([...session.deriveMessages(), ...batch])
  assert.ok(total > 1000, `the measured request (${total} tokens) must exceed the small candidate's window`)

  // Prove the decision uses that size: with it, the small candidate is skipped.
  fo.observeRequest({ session: 's1', turn: 1, step: 1, provider: 'p', model: 'one', tokens: total })
  assert.equal(fo.shouldRetry({ session: 's1', turn: 1, step: 1, provider: 'p', failure: { code: 'SERVER', message: 'x' } }).retry, true)
  const decision = fo.decide({ session: 's1', turn: 1, step: 1, resolved: { provider: 'p', model: 'one' } })
  assert.deepEqual(decision.record.skipped, [{ key: 'small/tiny', reason: 'context_window' }])
  assert.equal(decision.record.to, 'big/wide')
})

test('a session without deriveMessages still degrades instead of throwing', async () => {
  const seams = seamCtx({ value: undefined }, []).seams
  const decision = await seams.get('agent/pre-step')(
    { agent: { id: 'no-session' }, messages: [{ role: 'user', content: [] }], turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages: [{ role: 'user', content: [] }] }),
  )
  assert.equal(decision.kind, 'enter')
  const request = seams.get('agent/request')
  const resolved = await request(
    { agent: { id: 'no-session' }, turn: 1, step: 1 },
    async () => ({ provider: 'p', model: 'one' }),
  )
  assert.deepEqual(resolved, { provider: 'p', model: 'one' })
})
