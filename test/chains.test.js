import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TRIGGER_KINDS, DEFAULT_MAX_ATTEMPTS,
  modelKey, splitModelKey, classifyFailure,
  emptyTriggers, triggersFrom, normalizeChain, validateChain,
  chainEngages, selectCandidates, candidateForAttempt,
} from '../lib/chains.js'

/** A representative multi-provider roster. */
const ROSTER = [
  'raccoon/sn-deepseek-v4-1-flash',
  'workbuddy/deepseek-v4.1-flash',
  'buddy/deepseek-v4.1-flash',
  'trae/deepseek-v4.1-flash',
]

const chain = (over = {}) => ({
  primary: 'raccoon/sn-deepseek-v4-1-flash',
  candidates: ['workbuddy/deepseek-v4.1-flash', 'buddy/deepseek-v4.1-flash'],
  triggers: triggersFrom(['rate_limit', 'server_error', 'timeout_network']),
  maxAttempts: 3,
  ...over,
})

test('modelKey and splitModelKey round-trip, splitting on the first slash only', () => {
  assert.equal(modelKey('raccoon', 'sn-deepseek-v4-1-flash'), 'raccoon/sn-deepseek-v4-1-flash')
  assert.deepEqual(splitModelKey('raccoon/sn-deepseek-v4-1-flash'),
    { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' })
  // A model id containing a slash keeps everything after the FIRST slash.
  assert.deepEqual(splitModelKey('openai/org/model'), { provider: 'openai', model: 'org/model' })
  assert.equal(splitModelKey(''), null)
  assert.equal(splitModelKey('noslash'), null)
  assert.equal(splitModelKey('/leading'), null)
  assert.equal(splitModelKey('trailing/'), null)
})

test('classifyFailure maps harness codes to trigger classes', () => {
  assert.equal(classifyFailure({ code: 'RATE_LIMIT' }), 'rate_limit')
  assert.equal(classifyFailure({ code: 'SERVER' }), 'server_error')
  assert.equal(classifyFailure({ code: 'TIMEOUT' }), 'timeout_network')
  assert.equal(classifyFailure({ code: 'TRANSPORT' }), 'timeout_network')
  // Quota exhaustion is the same shape as a rate limit: every account is
  // throttled and a different account/model saves the request, so it rides the
  // 限流 switch (m07860).
  assert.equal(classifyFailure({ code: 'QUOTA_EXCEEDED' }), 'rate_limit')
  assert.equal(classifyFailure({ code: 'ACCOUNT_QUOTA' }), 'rate_limit')
})

test('classifyFailure does not invent triggers for unclassified failures', () => {
  // An unmapped code with no status must NOT match any trigger.
  assert.equal(classifyFailure({ code: 'EMPTY_RESPONSE' }), null)
  assert.equal(classifyFailure({ code: 'MALFORMED_RESPONSE' }), null)
  assert.equal(classifyFailure({ code: 'WAT' }), null)
  assert.equal(classifyFailure(undefined), null)
  assert.equal(classifyFailure(null), null)
  assert.equal(classifyFailure('nope'), null)
})

test('classifyFailure treats an unmapped 5xx as a server error', () => {
  assert.equal(classifyFailure({ code: 'SOMETHING_NEW', status: 502 }), 'server_error')
  // 4xx other than rate limit is not a trigger.
  assert.equal(classifyFailure({ code: 'SOMETHING_NEW', status: 404 }), null)
})

test('triggersFrom enables only known kinds and always returns a complete set', () => {
  const t = triggersFrom(['rate_limit', 'bogus'])
  assert.deepEqual(t, { rate_limit: true, server_error: false, timeout_network: false })
  assert.deepEqual(Object.keys(triggersFrom()), TRIGGER_KINDS)
})

test('normalizeChain preserves candidate order and applies defaults', () => {
  const n = normalizeChain({ primary: 'a/b', candidates: ['c/d', 'e/f', 'g/h'] })
  assert.deepEqual(n.candidates, ['c/d', 'e/f', 'g/h'], 'order is preserved verbatim')
  assert.equal(n.maxAttempts, DEFAULT_MAX_ATTEMPTS)
  assert.deepEqual(n.triggers, emptyTriggers())
})

test('normalizeChain never throws on malformed input', () => {
  assert.equal(normalizeChain().primary, '')
  assert.deepEqual(normalizeChain({ candidates: 'not-an-array' }).candidates, [])
  assert.deepEqual(normalizeChain({ candidates: ['ok', 42, '', null] }).candidates, ['ok'])
  assert.equal(normalizeChain({ maxAttempts: 0 }).maxAttempts, DEFAULT_MAX_ATTEMPTS)
  assert.equal(normalizeChain({ maxAttempts: -5 }).maxAttempts, DEFAULT_MAX_ATTEMPTS)
  assert.equal(normalizeChain({ maxAttempts: 2 }).maxAttempts, 2)
})

test('validateChain accepts a well-formed chain against the roster', () => {
  const v = validateChain(chain(), ROSTER)
  assert.equal(v.ok, true, v.errors.join('; '))
  assert.deepEqual(v.unknown, [])
})

test('validateChain rejects self-fallback', () => {
  const v = validateChain(chain({ candidates: ['raccoon/sn-deepseek-v4-1-flash'] }), ROSTER)
  assert.equal(v.ok, false)
  assert.ok(v.errors.includes('不能回退到自身'))
})

test('validateChain rejects a duplicate candidate', () => {
  const v = validateChain(chain({ candidates: ['workbuddy/deepseek-v4.1-flash', 'workbuddy/deepseek-v4.1-flash'] }), ROSTER)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.startsWith('候选重复')))
})

test('validateChain rejects candidates outside the roster and names them', () => {
  const v = validateChain(chain({ candidates: ['ghost/model', 'workbuddy/deepseek-v4.1-flash'] }), ROSTER)
  assert.equal(v.ok, false)
  assert.deepEqual(v.unknown, ['ghost/model'])
  assert.ok(v.errors.some((e) => e.includes('ghost/model')))
})

test('validateChain reports an empty chain', () => {
  const v = validateChain({ primary: 'a/b', candidates: [] }, ROSTER)
  assert.equal(v.ok, false)
  assert.ok(v.errors.includes('候选列表为空'))
})

test('chainEngages requires an enabled trigger for the actual failure class', () => {
  const onlyRateLimit = chain({ triggers: triggersFrom(['rate_limit']) })
  assert.equal(chainEngages(onlyRateLimit, { code: 'RATE_LIMIT' }), true)
  assert.equal(chainEngages(onlyRateLimit, { code: 'SERVER' }), false,
    'a server error must not engage a rate-limit-only chain')
  // Quota exhaustion rides the 限流 switch (m07860).
  assert.equal(chainEngages(onlyRateLimit, { code: 'QUOTA_EXCEEDED' }), true,
    'quota exhaustion engages a rate-limit-only chain')
  assert.equal(chainEngages(chain({ triggers: emptyTriggers() }), { code: 'QUOTA_EXCEEDED' }), false,
    'and it is still gated by the switch')
})

test('chainEngages is false for a chain with no candidates', () => {
  assert.equal(chainEngages(chain({ candidates: [] }), { code: 'RATE_LIMIT' }), false)
})

test('chainEngages is false when nothing is enabled', () => {
  assert.equal(chainEngages(chain({ triggers: emptyTriggers() }), { code: 'RATE_LIMIT' }), false)
})

test('selectCandidates skips a candidate whose window cannot hold the request', () => {
  const windows = {
    'workbuddy/deepseek-v4.1-flash': 8_000,
    'buddy/deepseek-v4.1-flash': 200_000,
  }
  const { usable, skipped } = selectCandidates(chain(), {
    contextWindowOf: (k) => windows[k],
    requestTokens: 50_000,
  })
  assert.deepEqual(usable, ['buddy/deepseek-v4.1-flash'])
  assert.deepEqual(skipped, [{ key: 'workbuddy/deepseek-v4.1-flash', reason: 'context_window' }])
})

test('selectCandidates does NOT skip a candidate with an unknown window', () => {
  const { usable, skipped } = selectCandidates(chain(), {
    contextWindowOf: () => undefined,
    requestTokens: 999_999,
  })
  assert.deepEqual(usable, ['workbuddy/deepseek-v4.1-flash', 'buddy/deepseek-v4.1-flash'])
  assert.deepEqual(skipped, [], 'an unknown window must never cost a candidate a turn')
})

test('selectCandidates does not skip when the request size is unknown', () => {
  const { usable } = selectCandidates(chain(), {
    contextWindowOf: () => 10,
    requestTokens: undefined,
  })
  assert.equal(usable.length, 2)
})

test('selectCandidates skips cooling candidates', () => {
  const { usable, skipped } = selectCandidates(chain(), {
    isCooling: (k) => k === 'workbuddy/deepseek-v4.1-flash',
  })
  assert.deepEqual(usable, ['buddy/deepseek-v4.1-flash'])
  assert.deepEqual(skipped, [{ key: 'workbuddy/deepseek-v4.1-flash', reason: 'cooling' }])
})

test('candidateForAttempt: attempt 0 is always the primary, never redirected', () => {
  const target = candidateForAttempt(chain(), 0)
  assert.deepEqual(target, { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' })
})

test('candidateForAttempt walks candidates in order for attempts 1..n', () => {
  assert.deepEqual(candidateForAttempt(chain(), 1),
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash' })
  assert.deepEqual(candidateForAttempt(chain(), 2),
    { provider: 'buddy', model: 'deepseek-v4.1-flash' })
})

test('candidateForAttempt respects maxAttempts as the depth cap', () => {
  assert.equal(candidateForAttempt(chain({ maxAttempts: 1 }), 2), null, 'depth 1 allows one candidate')
  assert.deepEqual(candidateForAttempt(chain({ maxAttempts: 1 }), 1), { provider: 'workbuddy', model: 'deepseek-v4.1-flash' })
})

test('candidateForAttempt returns null once candidates are exhausted', () => {
  assert.equal(candidateForAttempt(chain(), 3), null)
  assert.equal(candidateForAttempt(chain({ candidates: [] }), 1), null)
  assert.equal(candidateForAttempt(chain(), 99), null)
})

test('candidateForAttempt honours context-window filtering when choosing', () => {
  const windows = {
    'workbuddy/deepseek-v4.1-flash': 8_000,
    'buddy/deepseek-v4.1-flash': 200_000,
  }
  const target = candidateForAttempt(chain(), 1, {
    contextWindowOf: (k) => windows[k],
    requestTokens: 50_000,
  })
  assert.deepEqual(target, { provider: 'buddy', model: 'deepseek-v4.1-flash' },
    'attempt 1 must land on the first candidate that actually fits')
})
