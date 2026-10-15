/**
 * The settings API must survive a late `webServer` (tasks 4.1 / 4.7 / 7.5).
 *
 * Real incident: `ctx.get('webServer')` read once during `apply()` answered
 * `undefined` in the real web composition — plugins load before the browser half
 * publishes the service — so no route was ever registered and the settings page
 * reported "加载失败: not found" while a web server was busy serving it.
 * `ctx.inject(['webServer'], cb)` is cordis' "run this once the service exists",
 * and is what `dsh-our-free-model/index.js:1267` uses for the same reason.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { attachFailover } from '../lib/failover-host.js'

function harness({ llm, webServer } = {}) {
  const routes = []
  const records = []
  const pending = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'llm') return llm
      return undefined
    },
    on: () => () => {},
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    inject(deps, callback) { pending.push({ deps: [...deps], callback }) },
  }
  attachFailover(ctx, {
    loadChains: () => [],
    saveChains: () => {},
    appendLog: (kind, payload) => records.push({ kind, ...payload }),
    isDisabled: () => false,
  })
  const server = {
    register(route) { routes.push(route); return () => {} },
  }
  return { routes, records, pending, server }
}

/** Fire the pending `inject` for one service, as cordis would once it exists. */
function arrive(harnessed, service, value) {
  const entry = harnessed.pending.find((item) => item.deps.includes(service))
  assert.ok(entry, `the plugin waited for ${service}`)
  entry.callback({
    webServer: service === 'webServer' ? value : undefined,
    get: (name) => (name === service ? value : undefined),
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  })
  return entry
}

test('the route registration waits for webServer instead of giving up', () => {
  const h = harness()
  const entry = h.pending.find((item) => item.deps.includes('webServer'))
  assert.ok(entry, 'ctx.inject is used rather than a one-shot ctx.get')
  assert.equal(h.routes.length, 0, 'nothing is mounted while the service is absent')
})

test('the settings API mounts when webServer arrives later', () => {
  const h = harness()
  arrive(h, 'webServer', h.server)
  assert.equal(h.routes.length, 1)
  assert.equal(h.routes[0].kind, 'prefix')
  assert.equal(h.routes[0].path, '/api/model-fallback')
  assert.equal(typeof h.routes[0].handler, 'function')
  const mounted = h.records.filter((r) => r.kind === 'route')
  assert.deepEqual(mounted, [{ kind: 'route', path: '/api/model-fallback', mounted: true }])
})

test('a missing webServer is recorded rather than passing silently', () => {
  const routes = []
  const records = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => fn(),
  }
  attachFailover(ctx, {
    loadChains: () => [],
    saveChains: () => {},
    appendLog: (kind, payload) => records.push({ kind, ...payload }),
    isDisabled: () => false,
  })
  assert.equal(routes.length, 0)
  const route = records.find((r) => r.kind === 'route')
  assert.equal(route?.mounted, false)
  assert.equal(route?.reason, 'no-webServer')
})

test('the catalog is warmed through ctx.inject for llm, so late adapters still show up', async () => {
  const llm = {
    listProviders: async () => [{ provider: 'buddy' }],
    listModels: async () => [{ id: 'deepseek-v4-flash' }],
    resolveModelInfo: async () => ({ context: { contextWindow: 200000 } }),
  }
  const h = harness({ llm })
  arrive(h, 'llm', llm)
  // refreshCatalog is async; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 20))

  const catalog = h.records.filter((r) => r.kind === 'catalog')
  assert.equal(catalog.length, 1, 'the warm ran exactly once')
  assert.equal(catalog[0].models, 1)
  assert.equal(catalog[0].withWindow, 1)
  assert.equal(catalog[0].source.llm, true)
  assert.equal(catalog[0].source.providers, 1)
  assert.deepEqual(catalog[0].windows, ['buddy/deepseek-v4-flash=200000'])
})

test('an empty catalog is not cached, so the next page load enumerates again', async () => {
  let providers = []
  const records = []
  const llm = {
    listProviders: async () => providers,
    listModels: async () => [{ id: 'm' }],
    resolveModelInfo: async () => ({ context: { contextWindow: 1000 } }),
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (name) => (name === 'llm' ? llm : undefined),
    on: () => () => {},
    effect: (fn) => fn(),
  }
  const host = attachFailover(ctx, {
    loadChains: () => [],
    saveChains: () => {},
    appendLog: (kind, payload) => records.push({ kind, ...payload }),
    isDisabled: () => false,
  })

  assert.deepEqual(await host.refreshCatalog(true), [], 'first pass sees no providers')
  providers = [{ provider: 'p' }]
  const second = await host.refreshCatalog(true)
  assert.equal(second.length, 1, 'the empty snapshot was not cached')

  const source = records.filter((r) => r.kind === 'catalog').at(-1).source
  assert.equal(source.providers, 1, 'the catalog record reports the live provider count')
})
