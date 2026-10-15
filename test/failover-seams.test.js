/**
 * Tests for the failover seam APIs added for tasks 5.6/5.7.
 *
 * These cover the parts of `failover.js` that only matter once it is wired to
 * the real kernel seams: `observeRequest` (which remembers the model actually
 * sent, because `agent/request-error` does not name one) and `shouldRetry`
 * (which decides whether the kernel retries at all).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createFailover } from '../lib/failover.js'
import { createCooldowns } from '../lib/cooldown.js'
import { triggersFrom } from '../lib/chains.js'

const PRIMARY = 'raccoon/sn-deepseek-v4-1-flash'
const CAND_A = 'workbuddy/deepseek-v4.1-flash'
const CAND_B = 'buddy/deepseek-v4.1-flash'

function chain(over = {}) {
  return {
    primary: PRIMARY,
    candidates: [CAND_A, CAND_B],
    triggers: triggersFrom(['rate_limit', 'server_error', 'timeout_network']),
    maxAttempts: 3,
    ...over,
  }
}

function make(over = {}, deps = {}) {
  const chainValue = chain(over)
  const map = new Map([[PRIMARY, chainValue]])
  return createFailover({ chainOf: (p, m) => map.get(`${p}/${m}`) ?? null, ...deps })
}

const failure = (code) => ({ code, message: `${code} failed` })

test('observeRequest records the sent model so a model-less failure can be attributed', () => {
  const fo = make()
  const key = fo.observeRequest({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' })
  assert.equal(key, PRIMARY)
  // The kernel payload names only the provider; the model comes from this record.
  const result = fo.shouldRetry({ turn: 1, step: 1, provider: 'raccoon', failure: failure('RATE_LIMIT') })
  assert.equal(result.retry, true)
  assert.equal(result.reason, 'failover')
  assert.equal(result.trigger, 'rate_limit')
})

test('observeRequest ignores an unusable route instead of recording a bogus key', () => {
  const fo = make()
  assert.equal(fo.observeRequest({ turn: 1, step: 1, provider: '', model: 'x' }), null)
  assert.equal(fo.observeRequest({ turn: 1, step: 1, provider: 'p', model: undefined }), null)
  assert.equal(fo.observeRequest({}), null)
})

test('shouldRetry declines when the failure class is not one the chain enabled', () => {
  const fo = make({ triggers: triggersFrom(['server_error']) })
  fo.observeRequest({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' })
  const result = fo.shouldRetry({ turn: 1, step: 1, provider: 'raccoon', failure: failure('RATE_LIMIT') })
  assert.equal(result.retry, false)
  assert.equal(result.reason, 'no-chain')
})

test('shouldRetry declines for an unclassifiable failure', () => {
  const fo = make()
  fo.observeRequest({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' })
  const result = fo.shouldRetry({ turn: 1, step: 1, provider: 'raccoon', failure: { code: 'SOMETHING_ELSE' } })
  assert.equal(result.retry, false)
  assert.equal(result.reason, 'unclassified')
})

test('shouldRetry declines when no request was ever observed for the series', () => {
  const fo = make()
  // No observeRequest: there is no model to look a chain up for. Guessing would
  // risk redirecting a request the user never configured.
  const result = fo.shouldRetry({ turn: 9, step: 1, provider: 'raccoon', failure: failure('RATE_LIMIT') })
  assert.equal(result.retry, false)
  assert.equal(result.reason, 'no-chain')
})

test('shouldRetry declines once every candidate has been tried (exhaustion)', () => {
  const fo = make()
  fo.observeRequest({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' })
  assert.equal(fo.shouldRetry({ turn: 1, step: 1, provider: 'raccoon', failure: failure('RATE_LIMIT') }).retry, true)

  // First hop: the redirect lands on CAND_A, which then also fails.
  const first = fo.decide({ turn: 1, step: 1, resolved: { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' } })
  assert.equal(first.record.to, CAND_A)
  fo.observeRequest({ turn: 1, step: 1, provider: 'workbuddy', model: 'deepseek-v4.1-flash' })
  assert.equal(fo.shouldRetry({ turn: 1, step: 1, provider: 'workbuddy', failure: failure('RATE_LIMIT') }).retry, true)

  // Second hop lands on CAND_B; when that fails too the chain is spent.
  const second = fo.decide({ turn: 1, step: 1, resolved: { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' } })
  assert.equal(second.record.to, CAND_B)
  fo.observeRequest({ turn: 1, step: 1, provider: 'buddy', model: 'deepseek-v4.1-flash' })
  const last = fo.shouldRetry({ turn: 1, step: 1, provider: 'buddy', failure: failure('RATE_LIMIT') })
  assert.equal(last.retry, false)
  assert.equal(last.reason, 'exhausted')
})

test('shouldRetry declines when every remaining candidate is cooling', () => {
  const cooldowns = createCooldowns({ defaultMs: 60_000 })
  const fo = make({}, { cooldowns })
  cooldowns.add(CAND_A, { reason: 'rate_limit' })
  cooldowns.add(CAND_B, { reason: 'rate_limit' })
  fo.observeRequest({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' })
  const result = fo.shouldRetry({ turn: 1, step: 1, provider: 'raccoon', failure: failure('RATE_LIMIT') })
  assert.equal(result.retry, false)
  assert.equal(result.reason, 'exhausted')
})

test('shouldRetry declines when no candidate window can hold the request', () => {
  const fo = make({}, { contextWindowOf: () => 1000, requestTokensOf: () => 99_999 })
  fo.observeRequest({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' })
  const result = fo.shouldRetry({ turn: 1, step: 1, provider: 'raccoon', failure: failure('RATE_LIMIT') })
  assert.equal(result.retry, false)
  assert.equal(result.reason, 'exhausted')
})

test('a failure recorded by shouldRetry also cools the model that failed', () => {
  const cooldowns = createCooldowns({ defaultMs: 60_000 })
  const fo = make({}, { cooldowns })
  fo.observeRequest({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' })
  fo.shouldRetry({ turn: 1, step: 1, provider: 'raccoon', failure: failure('RATE_LIMIT') })
  assert.equal(cooldowns.isCooling(PRIMARY), true)
})

test('observeRequest keeps the token estimate for the context-window filter', () => {
  const seen = []
  const fo = make({}, { contextWindowOf: (key) => (key === CAND_A ? 8000 : 200_000), requestTokensOf: () => undefined })
  fo.observeRequest({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', tokens: 50_000 })
  fo.onFailure({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })
  const decision = fo.decide({ turn: 1, step: 1, resolved: { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' } })
  seen.push(decision.record)
  assert.equal(decision.record.to, CAND_B)
  assert.ok(decision.record.skipped.some((s) => s.key === CAND_A && s.reason === 'context_window'))
})

test('a malformed request-error payload degrades instead of throwing', () => {
  const fo = make()
  assert.doesNotThrow(() => fo.shouldRetry())
  assert.doesNotThrow(() => fo.shouldRetry({}))
  assert.doesNotThrow(() => fo.shouldRetry({ turn: 1, step: 1, provider: 'p' }))
  assert.equal(fo.shouldRetry().retry, false)
})

test('a chain never rewrites the user configuration through the retry path', () => {
  const fo = make()
  const before = JSON.stringify(chain())
  fo.observeRequest({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' })
  fo.shouldRetry({ turn: 1, step: 1, provider: 'raccoon', failure: failure('RATE_LIMIT') })
  fo.decide({ turn: 1, step: 1, resolved: { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' } })
  assert.equal(JSON.stringify(chain()), before)
})
