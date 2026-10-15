import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Store tests run against a throwaway DSH home.
 *
 * The module resolves its home from `$DSH_HOME` at call time, so pointing that
 * at a temp dir keeps the real `~/.dsh` out of the tests entirely.
 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mfb-store-'))
process.env.DSH_HOME = HOME

const store = await import('../lib/store.js')

/** Fresh data dir per test, so tests cannot see each other's files. */
let counter = 0
function freshHome() {
  counter += 1
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mfb-store-${counter}-`))
  process.env.DSH_HOME = dir
  return dir
}

test.after(() => {
  try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { /* best effort */ }
})

test('resolveDshHome honours DSH_HOME', () => {
  const dir = freshHome()
  assert.equal(store.resolveDshHome(), dir)
})

test('dataDir creates the directory on demand', () => {
  const dir = freshHome()
  const data = store.dataDir()
  assert.equal(data, path.join(dir, 'model-fallback'))
  assert.equal(fs.existsSync(data), true)
})

test('kill switch is OFF by default (no file means enabled)', () => {
  freshHome()
  assert.equal(store.isDisabled(), false)
})

test('kill switch recognises the documented off values', () => {
  freshHome()
  for (const value of ['off', 'OFF', ' off \n', '0', 'false']) {
    fs.writeFileSync(store.disablePath(), value)
    assert.equal(store.isDisabled(), true, `"${JSON.stringify(value)}" must disable`)
  }
})

test('kill switch stays ON for any other content', () => {
  freshHome()
  for (const value of ['on', 'enabled', '', 'yes']) {
    fs.writeFileSync(store.disablePath(), value)
    assert.equal(store.isDisabled(), false, `${JSON.stringify(value)} must not disable`)
  }
})

test('an unreadable switch file fails closed (disabled), not open', () => {
  const dir = freshHome()
  // A DIRECTORY where the file is expected makes readFileSync throw EISDIR,
  // which is not ENOENT — the plugin must treat that as "disable".
  fs.mkdirSync(path.join(dir, 'model-fallback'), { recursive: true })
  fs.mkdirSync(store.disablePath())
  assert.equal(store.isDisabled(), true, 'anything other than a clean absence disables')
})

test('appendLog writes one parseable NDJSON line per call', () => {
  freshHome()
  assert.equal(store.appendLog('probe', { n: 1, model: 'x/y' }), true)
  assert.equal(store.appendLog('failover', { from: 'a/b', to: 'c/d' }), true)

  const raw = fs.readFileSync(store.logPath(), 'utf8').trim().split('\n')
  assert.equal(raw.length, 2)
  const first = JSON.parse(raw[0])
  assert.equal(first.kind, 'probe')
  assert.equal(first.model, 'x/y')
  assert.equal(typeof first.t, 'number', 'records are timestamped')
})

test('readLog returns newest-last and tolerates a torn trailing line', () => {
  freshHome()
  store.appendLog('probe', { n: 1 })
  store.appendLog('probe', { n: 2 })
  fs.appendFileSync(store.logPath(), '{"t":1,"kind":"probe","n":3')   // truncated write

  const records = store.readLog()
  assert.equal(records.length, 2, 'the torn line is skipped, not thrown on')
  assert.equal(records[0].n, 1)
  assert.equal(records[1].n, 2)
})

test('readLog honours the limit and keeps the newest records', () => {
  freshHome()
  for (let i = 1; i <= 10; i++) store.appendLog('probe', { n: i })
  const records = store.readLog(3)
  assert.deepEqual(records.map((r) => r.n), [8, 9, 10])
})

test('readLog returns empty when no log exists', () => {
  freshHome()
  assert.deepEqual(store.readLog(), [])
})

test('clearLog empties the log', () => {
  freshHome()
  store.appendLog('probe', { n: 1 })
  assert.equal(store.clearLog(), true)
  assert.deepEqual(store.readLog(), [])
})

test('loadChains returns empty when nothing is stored', () => {
  freshHome()
  assert.deepEqual(store.loadChains(), [])
})

test('saveChains then loadChains round-trips candidate order', () => {
  freshHome()
  const chains = [
    { primary: 'raccoon/sn-deepseek-v4-1-flash', candidates: ['b/c', 'd/e', 'f/g'], maxAttempts: 3 },
    { primary: 'x/y', candidates: ['z/w'], maxAttempts: 1 },
  ]
  assert.equal(store.saveChains(chains), true)

  const back = store.loadChains()
  assert.equal(back.length, 2)
  assert.deepEqual(back[0].candidates, ['b/c', 'd/e', 'f/g'],
    'order is the failover order, so it must survive persistence verbatim')
  assert.equal(back[1].maxAttempts, 1)
})

test('loadChains degrades on corrupt content instead of throwing', () => {
  freshHome()
  fs.writeFileSync(store.chainsPath(), '{ not json')
  assert.deepEqual(store.loadChains(), [])
  fs.writeFileSync(store.chainsPath(), '{"not":"an array"}')
  assert.deepEqual(store.loadChains(), [])
})

test('no temp file is left behind after a successful save', () => {
  freshHome()
  store.saveChains([{ primary: 'a/b', candidates: ['c/d'] }])
  assert.equal(fs.existsSync(`${store.chainsPath()}.tmp`), false)
})
