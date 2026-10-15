/**
 * Exhaustion reporting (tasks 5.4 / 7.6).
 *
 * `request-failover` requires that when every candidate has been tried the user
 * sees the PRIMARY's original failure — "not just the last candidate's error".
 * The kernel would otherwise throw the final attempt's failure, so these tests
 * pin the plugin-side contract that keeps the primary's failure identifiable.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createFailover } from '../lib/failover.js'
import { triggersFrom } from '../lib/chains.js'

const PRIMARY = 'raccoon/sn-deepseek-v4-1-flash'
const CAND_A = 'workbuddy/deepseek-v4.1-flash'
const CAND_B = 'buddy/deepseek-v4.1-flash'

const PRIMARY_PARTS = { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' }
const CAND_A_PARTS = { provider: 'workbuddy', model: 'deepseek-v4.1-flash' }
const CAND_B_PARTS = { provider: 'buddy', model: 'deepseek-v4.1-flash' }

/** The primary's failure: the one that started the whole episode. */
const PRIMARY_FAILURE = Object.freeze({ code: 'RATE_LIMIT', message: 'primary: rate limit reached for TPM' })
/** A candidate's failure: a different class, on a different model. */
const CAND_A_FAILURE = Object.freeze({ code: 'SERVER', message: 'candidate A: upstream 502' })
const CAND_B_FAILURE = Object.freeze({ code: 'SERVER', message: 'candidate B: upstream 503' })

function makeFailover({ maxAttempts = 3, candidates = [CAND_A, CAND_B] } = {}) {
  const chain = {
    primary: PRIMARY,
    candidates,
    triggers: triggersFrom(['rate_limit', 'server_error', 'timeout_network']),
    maxAttempts,
  }
  return createFailover({ chainOf: () => chain })
}

const resolved = () => ({ provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' })

function fail(fo, { turn, step }, parts, failure) {
  return fo.onFailure({ turn, step, provider: parts.provider, model: parts.model, failure })
}

test("an exhausted series reports the PRIMARY's failure, not the last candidate's", () => {
  const fo = makeFailover({ maxAttempts: 1, candidates: [CAND_A] })

  fail(fo, { turn: 1, step: 1 }, PRIMARY_PARTS, PRIMARY_FAILURE)
  const hop = fo.decide({ turn: 1, step: 1, resolved: resolved() })
  assert.equal(hop.takeover, true, 'the first candidate should be tried')

  fail(fo, { turn: 1, step: 1 }, CAND_A_PARTS, CAND_A_FAILURE)
  const end = fo.decide({ turn: 1, step: 1, resolved: resolved() })

  assert.equal(end.takeover, false)
  assert.equal(end.record.reason, 'exhausted')
  assert.equal(end.record.failure, PRIMARY_FAILURE, "the record must carry the primary's failure object")
  assert.equal(end.record.trigger, 'rate_limit', "the trigger must be the primary's class, not the candidate's")
})

test('a mid-chain redirect reports the failure that caused that hop', () => {
  const fo = makeFailover()
  fail(fo, { turn: 2, step: 1 }, PRIMARY_PARTS, PRIMARY_FAILURE)

  const first = fo.decide({ turn: 2, step: 1, resolved: resolved() })
  assert.equal(first.takeover, true)
  assert.equal(first.record.failure, PRIMARY_FAILURE)
  assert.equal(first.record.to, CAND_A)

  fail(fo, { turn: 2, step: 1 }, CAND_A_PARTS, CAND_A_FAILURE)
  const second = fo.decide({ turn: 2, step: 1, resolved: resolved() })
  assert.equal(second.takeover, true)
  assert.equal(second.record.failure, CAND_A_FAILURE, 'a hop reports the failure that caused it')
  assert.equal(second.record.trigger, 'server_error')
  assert.equal(second.record.to, CAND_B)
})

test('shouldRetry hands back the primary identity and failure once exhausted', () => {
  const fo = makeFailover()

  fo.observeRequest({ turn: 5, step: 1, ...PRIMARY_PARTS })
  const first = fo.shouldRetry({ turn: 5, step: 1, provider: 'raccoon', failure: PRIMARY_FAILURE })
  assert.equal(first.retry, true)
  assert.equal(first.reason, 'failover')

  fo.observeRequest({ turn: 5, step: 1, ...CAND_A_PARTS })
  const second = fo.shouldRetry({ turn: 5, step: 1, provider: 'workbuddy', failure: CAND_A_FAILURE })
  assert.equal(second.retry, true, 'candidate B is still available')

  fo.observeRequest({ turn: 5, step: 1, ...CAND_B_PARTS })
  const end = fo.shouldRetry({ turn: 5, step: 1, provider: 'buddy', failure: CAND_B_FAILURE })

  assert.equal(end.retry, false)
  assert.equal(end.reason, 'exhausted')
  assert.equal(end.primary, PRIMARY)
  assert.equal(end.primaryFailure, PRIMARY_FAILURE, 'the caller needs the primary failure to report it')
})

test('a series that never engaged reports no primary failure', () => {
  // No chain covers this model, so nothing is engaged and nothing is attributed.
  const fo = createFailover({ chainOf: () => null })
  fo.observeRequest({ turn: 7, step: 1, ...PRIMARY_PARTS })
  const result = fo.shouldRetry({ turn: 7, step: 1, provider: 'raccoon', failure: PRIMARY_FAILURE })
  assert.equal(result.retry, false)
  assert.equal(result.reason, 'no-chain')
  assert.equal(result.primaryFailure, undefined)
})

test('an unclassified failure is never attributed to a primary', () => {
  const fo = makeFailover()
  fo.observeRequest({ turn: 8, step: 1, ...PRIMARY_PARTS })
  const result = fo.shouldRetry({
    turn: 8, step: 1, provider: 'raccoon',
    failure: { code: 'AUTH', message: 'not one of the three trigger classes' },
  })
  assert.equal(result.retry, false)
  assert.equal(result.reason, 'unclassified')
  assert.equal(result.primaryFailure, undefined)
})
