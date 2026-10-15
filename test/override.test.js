import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mfb-ovr-'))
process.env.DSH_HOME = HOME

const store = await import('../lib/store.js')
const override = await import('../lib/override-test.js')

test.after(() => {
  try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { /* best effort */ }
})

/** Cordis-faithful waterfall, as read from cordis lib/index.js:317. */
function waterfall(cbs, inner, payload) {
  const queue = [...cbs]
  const next = () => (queue.shift() ?? inner)(payload, next)
  return next()
}

test('readOverride returns null when the file is absent', () => {
  store.dataDir()
  assert.equal(override.readOverride(), null)
})

test('readOverride parses the provider|model form', () => {
  store.dataDir()
  fs.writeFileSync(override.overridePath(), 'buddy|deepseek-v4-pro')
  assert.deepEqual(override.readOverride(), { provider: 'buddy', model: 'deepseek-v4-pro' })
})

test('readOverride rejects malformed content so a stray file cannot redirect traffic', () => {
  store.dataDir()
  for (const bad of ['', '   ', 'nosep', '|model', 'provider|', ' | ']) {
    fs.writeFileSync(override.overridePath(), bad)
    assert.equal(override.readOverride(), null, `${JSON.stringify(bad)} must not arm the override`)
  }
})

test('readOverride tolerates surrounding whitespace and keeps slashes in the model', () => {
  store.dataDir()
  fs.writeFileSync(override.overridePath(), '  openai|org/model  \n')
  assert.deepEqual(override.readOverride(), { provider: 'openai', model: 'org/model' })
})

test('the override listener returns a DIFFERENT config when armed', async () => {
  store.dataDir()
  fs.writeFileSync(override.overridePath(), 'buddy|deepseek-v4-pro')

  let listener
  const logs = []
  override.attachOverrideTest(
    { on: (_n, fn) => { listener = fn }, logger: { info: (m) => logs.push(m), warn: () => {} } },
    { appendLog: (k, p) => { logs.push(`${k}:${p.was}->${p.now}`); return true } },
  )
  assert.equal(typeof listener, 'function', 'the override must register prepend')

  const seed = { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', reasoningEffort: 'high' }
  const out = await waterfall([listener], () => Promise.resolve(seed), { turn: 1, step: 1 })

  assert.equal(out.provider, 'buddy')
  assert.equal(out.model, 'deepseek-v4-pro')
  assert.equal(out.reasoningEffort, 'high', 'unrelated fields carry over')
  assert.notEqual(out, seed, 'a new object; the seed is not mutated')
  assert.equal(seed.provider, 'raccoon', 'the original is untouched')
})

test('the override listener passes through untouched when not armed', async () => {
  store.dataDir()
  try { fs.rmSync(override.overridePath()) } catch { /* absent */ }

  let listener
  override.attachOverrideTest({
    on: (_n, fn) => { listener = fn },
    logger: { info: () => {}, warn: () => {} },
  }, { appendLog: () => true })

  const seed = { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' }
  const out = await waterfall([listener], () => Promise.resolve(seed), { turn: 1, step: 1 })
  assert.equal(out, seed, 'unarmed, it must be behaviourally invisible')
})
