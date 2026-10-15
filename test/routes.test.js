/**
 * Tests for the settings-page HTTP API (tasks 4.3/4.4/4.7/6.4).
 *
 * Design D6 is the rule under test: the editor holds no copy of the chains.
 * Every read goes back to the store, and every write is read back from the
 * store — so the UI can never show a configuration the runtime is not enforcing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createApi, API_BASE } from '../lib/routes.js'

/** A fake store whose writes are visible to subsequent reads. */
function fakeStore(initial = []) {
  let chains = initial
  const writes = []
  return {
    writes,
    get chains() { return chains },
    loadChains: () => chains,
    saveChains: (next) => { writes.push(JSON.parse(JSON.stringify(next))); chains = next },
  }
}

function makeApi(over = {}) {
  const store = over.store ?? fakeStore()
  const cooldowns = over.cooldowns ?? []
  const cleared = []
  const api = createApi({
    loadChains: store.loadChains,
    saveChains: store.saveChains,
    listModels: over.listModels ?? (() => [{ provider: 'raccoon', model: 'm', key: 'raccoon/m', contextWindow: 1000 }]),
    listCooldowns: () => cooldowns,
    clearCooldown: (key) => { cleared.push(key); return true },
    clearAllCooldowns: () => { cleared.push('*') },
    history: () => [{ from: 'a/b', to: 'c/d' }],
    status: () => ({ chains: store.loadChains().length, disabled: false }),
    ...over.deps,
  })
  return { api, store, cleared }
}

const parse = (response) => JSON.parse(response.body)

test('the API is mounted at the documented base path', () => {
  assert.equal(API_BASE, '/api/model-fallback')
})

test('chains are read back from the store, never from a client copy', async () => {
  const store = fakeStore([{ primary: 'raccoon/a', candidates: ['buddy/b'] }])
  const { api } = makeApi({ store })
  const response = await api('GET', `${API_BASE}/chains`)
  assert.equal(response.status, 200)
  assert.deepEqual(parse(response).chains, [{ primary: 'raccoon/a', candidates: ['buddy/b'] }])
})

test('a write is answered with what was actually persisted (task 4.3/4.4)', async () => {
  const store = fakeStore()
  const { api } = makeApi({ store })
  const response = await api('PUT', `${API_BASE}/chains`, {
    chains: [{ primary: 'raccoon/a', candidates: ['buddy/b'] }],
  })
  assert.equal(response.status, 200)
  assert.equal(store.writes.length, 1)
  assert.deepEqual(parse(response).chains, store.chains)
})

test('reordering a chain writes the order exactly once (task 4.4)', async () => {
  const store = fakeStore([{ primary: 'raccoon/a', candidates: ['A', 'B', 'C'] }])
  const { api } = makeApi({ store })
  await api('PUT', `${API_BASE}/chains`, {
    chains: [{ primary: 'raccoon/a', candidates: ['C', 'A', 'B'] }],
  })
  assert.equal(store.writes.length, 1, 'a drag must produce exactly one order write')
  assert.deepEqual(store.writes[0][0].candidates, ['C', 'A', 'B'])
})

test('the editor sees a host-side edit on its next read (task 4.7)', async () => {
  const store = fakeStore([{ primary: 'raccoon/a', candidates: ['A', 'B', 'C'] }])
  const { api } = makeApi({ store })
  // Something other than the UI rewrites the chain on disk.
  store.saveChains([{ primary: 'raccoon/a', candidates: ['C', 'B', 'A'] }])
  const response = await api('GET', `${API_BASE}/chains`)
  assert.deepEqual(parse(response).chains[0].candidates, ['C', 'B', 'A'])
})

test('a malformed chains payload is refused rather than persisted', async () => {
  const store = fakeStore([{ primary: 'keep' }])
  const { api } = makeApi({ store })
  for (const body of [{}, { chains: 'nope' }, { chains: 42 }, null]) {
    const response = await api('PUT', `${API_BASE}/chains`, body)
    assert.equal(response.status, 400)
  }
  assert.equal(store.writes.length, 0)
  assert.deepEqual(store.chains, [{ primary: 'keep' }])
})

test('the model list is served from the host enumeration (task 4.1/7.5)', async () => {
  let calls = 0
  const { api } = makeApi({ listModels: () => { calls += 1; return [{ provider: 'p', model: 'm' }] } })
  const response = await api('GET', `${API_BASE}/models`)
  assert.equal(calls, 1)
  assert.deepEqual(parse(response).models, [{ provider: 'p', model: 'm' }])
})

test('an async model enumeration is awaited', async () => {
  const { api } = makeApi({ listModels: async () => [{ provider: 'p', model: 'async' }] })
  const response = await api('GET', `${API_BASE}/models`)
  assert.deepEqual(parse(response).models, [{ provider: 'p', model: 'async' }])
})

test('a failing model enumeration is reported as an error, not as an empty list', async () => {
  const { api } = makeApi({ listModels: () => { throw new Error('registry down') } })
  const response = await api('GET', `${API_BASE}/models`)
  assert.equal(response.status, 500)
  assert.ok(parse(response).error.includes('registry down'))
})

test('cooldowns are listed with what the UI needs to show (task 6.4)', async () => {
  const cooldowns = [{ key: 'raccoon/a', until: 123, startedAt: 100, reason: 'rate_limit', remainingMs: 23 }]
  const { api } = makeApi({ cooldowns })
  const response = await api('GET', `${API_BASE}/cooldowns`)
  assert.deepEqual(parse(response).cooldowns, cooldowns)
})

test('an empty cooldown list is served as an empty array (task 6.4 empty state)', async () => {
  const { api } = makeApi({ cooldowns: [] })
  const response = await api('GET', `${API_BASE}/cooldowns`)
  assert.deepEqual(parse(response).cooldowns, [])
})

test('one cooldown can be cleared by key, including a key containing a slash', async () => {
  const { api, cleared } = makeApi()
  const key = encodeURIComponent('workbuddy/deepseek-v4.1-flash')
  const response = await api('DELETE', `${API_BASE}/cooldowns/${key}`)
  assert.equal(response.status, 200)
  assert.deepEqual(cleared, ['workbuddy/deepseek-v4.1-flash'])
})

test('clearing every cooldown is a distinct route from clearing one', async () => {
  const { api, cleared } = makeApi()
  const response = await api('DELETE', `${API_BASE}/cooldowns`)
  assert.equal(response.status, 200)
  assert.deepEqual(cleared, ['*'])
})

test('failover history is exposed for the UI to display', async () => {
  const { api } = makeApi()
  const response = await api('GET', `${API_BASE}/history`)
  assert.deepEqual(parse(response).history, [{ from: 'a/b', to: 'c/d' }])
})

test('the root route reports plugin status for the header', async () => {
  const { api } = makeApi()
  const response = await api('GET', `${API_BASE}/`)
  const payload = parse(response)
  assert.equal(payload.ok, true)
  assert.equal(payload.status.disabled, false)
})

test('an unknown route is a 404, not a silent success', async () => {
  const { api } = makeApi()
  const response = await api('GET', `${API_BASE}/nope`)
  assert.equal(response.status, 404)
  assert.ok(parse(response).error.includes('no route'))
})

test('a query string does not confuse route matching', async () => {
  const { api } = makeApi()
  const response = await api('GET', `${API_BASE}/chains?cachebust=1`)
  assert.equal(response.status, 200)
})

test('every response forbids caching so the editor never shows a stale chain', async () => {
  const { api } = makeApi()
  const response = await api('GET', `${API_BASE}/chains`)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.ok(response.headers['content-type'].startsWith('application/json'))
})
