/**
 * Tests for the model catalog (task 4.1 / 7.5).
 *
 * The catalog is the editor's source of truth, and it must come from the running
 * host rather than from a table baked into the plugin — so a channel added or
 * disabled at runtime changes the list with no code change. These tests drive a
 * fake `ctx.llm` to pin the tolerant reading of each entry shape and the
 * never-invent-a-number rule for context windows.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectCatalog, contextWindowOf, providerIdOf, modelIdOf, modelNameOf, providerLabelOf,
  PROVIDER_LIMIT, MODEL_LIMIT,
} from '../lib/catalog.js'

/** A fake host llm with the shapes seen in the wild. */
function fakeLlm({ providers, models = {}, windows = {}, throws = {} } = {}) {
  return {
    listProviders() {
      if (throws.providers) throw new Error('providers exploded')
      return providers
    },
    async listModels(provider) {
      if (throws[provider]) throw new Error(`${provider} exploded`)
      return models[provider] ?? []
    },
    async resolveModelInfo(provider, model) {
      const window = windows[`${provider}/${model}`]
      if (window === undefined) throw new Error('no info')
      return { context: { contextWindow: window } }
    },
  }
}

test('the catalog follows the host: a newly listed channel appears with no code change', async () => {
  const llm = fakeLlm({
    providers: [{ provider: 'raccoon' }],
    models: { raccoon: [{ id: 'sn-deepseek-v4-1-flash' }] },
  })
  const before = await collectCatalog(llm)
  assert.deepEqual(before.map((m) => m.key), ['raccoon/sn-deepseek-v4-1-flash'])

  // The channel registry changes; the plugin does not.
  const grown = fakeLlm({
    providers: [{ provider: 'raccoon' }, { provider: 'newchannel' }],
    models: {
      raccoon: [{ id: 'sn-deepseek-v4-1-flash' }],
      newchannel: [{ id: 'brand-new-model' }],
    },
  })
  const after = await collectCatalog(grown)
  assert.ok(after.some((m) => m.key === 'newchannel/brand-new-model'))
})

test('the catalog carries each model context window when the host knows it', async () => {
  const llm = fakeLlm({
    providers: ['raccoon'],
    models: { raccoon: [{ id: 'a' }, { id: 'b' }] },
    windows: { 'raccoon/a': 128_000 },
  })
  const catalog = await collectCatalog(llm)
  assert.equal(catalog.find((m) => m.model === 'a').contextWindow, 128_000)
  // Unknown stays undefined — the UI must say "未知" rather than print a guess.
  assert.equal(catalog.find((m) => m.model === 'b').contextWindow, undefined)
})

test('every entry shape seen in the wild is read tolerantly', async () => {
  const llm = fakeLlm({
    providers: [{ route: 'r1' }, { id: 'r2' }, 'r3', { name: 'r4' }, {}, null],
    models: {
      r1: [{ model: 'm1' }, { name: 'm2' }, 'm3', {}, null],
      r2: [],
      r3: [],
      r4: [],
    },
  })
  const catalog = await collectCatalog(llm)
  assert.deepEqual(catalog.map((m) => m.key).sort(), ['r1/m1', 'r1/m2', 'r1/m3'])
})

test('a provider whose listing throws is skipped without losing the others', async () => {
  const llm = fakeLlm({
    providers: ['good', 'bad'],
    models: { good: [{ id: 'fine' }] },
    throws: { bad: true },
  })
  const catalog = await collectCatalog(llm)
  assert.deepEqual(catalog.map((m) => m.key), ['good/fine'])
})

test('a host that cannot enumerate at all yields an empty catalog, not a throw', async () => {
  assert.deepEqual(await collectCatalog(null), [])
  assert.deepEqual(await collectCatalog({}), [])
  assert.deepEqual(await collectCatalog(fakeLlm({ throws: { providers: true } })), [])
})

test('a throwing resolveModelInfo costs only that model its window', async () => {
  const llm = fakeLlm({
    providers: ['p'],
    models: { p: [{ id: 'x' }, { id: 'y' }] },
    windows: { 'p/y': 64_000 },
  })
  const catalog = await collectCatalog(llm)
  assert.equal(catalog.length, 2)
  assert.equal(catalog.find((m) => m.model === 'x').contextWindow, undefined)
  assert.equal(catalog.find((m) => m.model === 'y').contextWindow, 64_000)
})

test('enumeration is capped so a pathological registry cannot stall the page', async () => {
  const many = Array.from({ length: PROVIDER_LIMIT + 25 }, (_, i) => `p${i}`)
  const llm = fakeLlm({ providers: many, models: {} })
  const catalog = await collectCatalog(llm)
  assert.equal(catalog.length, 0) // no models, but the call returns promptly

  const lotsOfModels = Array.from({ length: MODEL_LIMIT + 10 }, (_, i) => ({ id: `m${i}` }))
  const capped = await collectCatalog(fakeLlm({ providers: ['p'], models: { p: lotsOfModels } }))
  assert.equal(capped.length, MODEL_LIMIT)
})

test('a context window is only accepted when it is a positive integer', () => {
  assert.equal(contextWindowOf({ context: { contextWindow: 128_000 } }), 128_000)
  assert.equal(contextWindowOf({ context: { contextWindow: 0 } }), undefined)
  assert.equal(contextWindowOf({ context: { contextWindow: -5 } }), undefined)
  assert.equal(contextWindowOf({ context: { contextWindow: 1.5 } }), undefined)
  assert.equal(contextWindowOf({ context: { contextWindow: '128000' } }), undefined)
  assert.equal(contextWindowOf({ contextWindow: 128_000 }), undefined) // not the real path
  assert.equal(contextWindowOf({}), undefined)
  assert.equal(contextWindowOf(null), undefined)
})

test('entry readers ignore empty strings rather than producing a blank key', () => {
  assert.equal(providerIdOf({ provider: '' }), undefined)
  assert.equal(providerIdOf({ provider: '   ' }), '   ')
  assert.equal(providerIdOf(''), undefined)
  assert.equal(modelIdOf({ id: '' }), undefined)
  assert.equal(modelIdOf(''), undefined)
})

test('a model carries the display name and channel label the picker shows', async () => {
  const llm = fakeLlm({
    providers: [{ provider: 'workbuddy', name: 'WorkBuddy (国际版)' }, { provider: 'raccoon' }],
    models: {
      workbuddy: [{ id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro · x0.51' }],
      raccoon: ['sn-deepseek-v4-1-flash'],
    },
  })
  const catalog = await collectCatalog(llm)
  const pro = catalog.find((m) => m.key === 'workbuddy/deepseek-v4-pro')
  assert.equal(pro.providerLabel, 'WorkBuddy (国际版)')
  assert.equal(pro.name, 'Deepseek-V4-Pro · x0.51', 'the label carries the billing multiplier')
  assert.equal(pro.model, 'deepseek-v4-pro', 'the id stays the id')

  // A provider with no display name still yields a usable heading, and a model
  // listed as a bare string has no display name at all (never invented).
  const bare = catalog.find((m) => m.key === 'raccoon/sn-deepseek-v4-1-flash')
  assert.equal(bare.providerLabel, 'raccoon')
  assert.equal(bare.name, undefined)
})

test('display-name and label readers tolerate every entry shape', () => {
  assert.equal(modelNameOf({ name: 'GLM-5.3-Flash · x0.06' }), 'GLM-5.3-Flash · x0.06')
  assert.equal(modelNameOf({ label: 'Label wins' }), 'Label wins')
  assert.equal(modelNameOf({}), undefined)
  assert.equal(modelNameOf('just-a-string'), undefined)
  assert.equal(modelNameOf(null), undefined)

  assert.equal(providerLabelOf({ name: 'LobsterAI (有道)' }, 'lobsterai'), 'LobsterAI (有道)')
  assert.equal(providerLabelOf({}, 'lobsterai'), 'lobsterai')
  assert.equal(providerLabelOf(null, 'lobsterai'), 'lobsterai')
  assert.equal(providerLabelOf({ name: '' }, 'lobsterai'), 'lobsterai')
})
