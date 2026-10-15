import test from 'node:test'
import assert from 'node:assert/strict'

import { createCooldowns, DEFAULT_COOLDOWN_MS } from '../lib/cooldown.js'

const KEY = 'raccoon/sn-deepseek-v4-1-flash'

/** A ledger with a controllable clock. */
function harness(startAt = 1_000_000) {
  let t = startAt
  const cd = createCooldowns({ defaultMs: 1000, now: () => t })
  return { cd, advance: (ms) => { t += ms }, at: () => t }
}

test('a model is not cooling before it fails', () => {
  const { cd } = harness()
  assert.equal(cd.isCooling(KEY), false)
  assert.equal(cd.size(), 0)
})

test('add puts a model into cooldown with the default duration', () => {
  const { cd } = harness()
  cd.add(KEY)
  assert.equal(cd.isCooling(KEY), true)
  const [entry] = cd.list()
  assert.equal(entry.remainingMs, 1000)
})

test('cooldown ends automatically once the window passes — no manual clear needed', () => {
  const { cd, advance } = harness()
  cd.add(KEY)
  assert.equal(cd.isCooling(KEY), true)
  advance(999)
  assert.equal(cd.isCooling(KEY), true, 'still cooling one tick before expiry')
  advance(1)
  assert.equal(cd.isCooling(KEY), false, 'expired exactly on the boundary')
})

test('an expired entry disappears from the listing rather than lingering', () => {
  const { cd, advance } = harness()
  cd.add(KEY)
  advance(5000)
  assert.deepEqual(cd.list(), [], 'no stale entry is reported')
  assert.equal(cd.size(), 0)
})

test('an explicit duration overrides the default', () => {
  const { cd, advance } = harness()
  cd.add(KEY, { ms: 250 })
  advance(251)
  assert.equal(cd.isCooling(KEY), false)
})

test('a non-positive override falls back to the default duration', () => {
  const { cd, advance } = harness()
  cd.add(KEY, { ms: 0 })
  advance(DEFAULT_COOLDOWN_MS + 1)
  assert.equal(cd.isCooling(KEY), false)
  assert.equal(cd.size(), 0)
})

test('add records the reason for the UI', () => {
  const { cd } = harness()
  cd.add(KEY, { reason: 'rate_limit' })
  assert.equal(cd.list()[0].reason, 'rate_limit')
})

test('manual clear removes the cooldown immediately', () => {
  const { cd } = harness()
  cd.add(KEY)
  assert.equal(cd.clear(KEY), true)
  assert.equal(cd.isCooling(KEY), false)
  assert.equal(cd.clear(KEY), false, 'clearing a non-existent entry reports false')
})

test('cooldowns are keyed by model, so one model does not cool another', () => {
  const { cd } = harness()
  cd.add(KEY)
  assert.equal(cd.isCooling('buddy/deepseek-v4.1-flash'), false)
})

test('re-adding refreshes the window from the new start time', () => {
  const { cd, advance } = harness()
  cd.add(KEY)
  advance(900)                      // 100ms left
  cd.add(KEY)                       // refreshed
  advance(150)
  assert.equal(cd.isCooling(KEY), true, 'the refreshed window is still running')
})

test('RESTART: a cooldown that expired while the app was closed does not gate anything', () => {
  // Reproduces the cross-restart requirement without simulating a process: the
  // ledger is rebuilt as if freshly loaded, and the wall clock has moved past
  // the stored expiry. Nothing may still be gated.
  //
  // This is why restore() exists as a path separate from add(): a naive
  // `add(key, {ms: until - now})` with a negative remainder would fall back to
  // the DEFAULT duration and resurrect the cooldown as if it just started.
  const expiredAt = 1_000_000
  const storedEntries = [{ key: KEY, until: expiredAt, startedAt: expiredAt - 1000, reason: 'rate_limit' }]
  const startedAt = expiredAt + 1            // app restarts one ms after expiry
  const cd = createCooldowns({ now: () => startedAt })

  assert.equal(cd.isCooling(KEY), false)

  for (const e of storedEntries) cd.restore(e.key, e)

  assert.equal(cd.isCooling(KEY), false, 'expired state must not gate after restart')
  assert.equal(cd.size(), 0, 'the expired entry is reaped on first read')
})

test('restore preserves an unexpired window and reports the remainder', () => {
  const startedAt = 1_000_000
  const until = startedAt + 30_000           // 30s still left
  const cd = createCooldowns({ now: () => startedAt })

  cd.restore(KEY, { until, startedAt: startedAt - 5000, reason: 'server_error' })

  assert.equal(cd.isCooling(KEY), true)
  const [entry] = cd.list()
  assert.equal(entry.remainingMs, 30_000, 'the UI can show the remainder')
  assert.equal(entry.reason, 'server_error')
})

test('restore ignores entries without a usable expiry', () => {
  const { cd } = harness()
  assert.equal(cd.restore(KEY, {}), null)
  assert.equal(cd.restore(KEY, { until: 'nonsense' }), null)
  assert.equal(cd.size(), 0)
})

test('RESTART: a cooldown still running at restart keeps gating for the remainder', () => {
  const startedAt = 1_000_000
  const until = startedAt + 30_000           // 30s still left
  const cd = createCooldowns({ now: () => startedAt })
  cd.add(KEY, { ms: until - startedAt })
  assert.equal(cd.isCooling(KEY), true)
  assert.equal(cd.list()[0].remainingMs, 30_000, 'the UI can show the remainder')
})

test('clearAll empties the ledger', () => {
  const { cd } = harness()
  cd.add(KEY)
  cd.add('buddy/deepseek-v4.1-flash')
  assert.equal(cd.size(), 2)
  cd.clearAll()
  assert.equal(cd.size(), 0)
})
