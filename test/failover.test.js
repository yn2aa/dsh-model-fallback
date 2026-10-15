import test from 'node:test'
import assert from 'node:assert/strict'

import { createFailover, SEQUENCE_LIMIT } from '../lib/failover.js'
import { createCooldowns } from '../lib/cooldown.js'
import { triggersFrom } from '../lib/chains.js'

const PRIMARY = 'raccoon/sn-deepseek-v4-1-flash'
const CAND_A = 'workbuddy/deepseek-v4.1-flash'
const CAND_B = 'buddy/deepseek-v4.1-flash'

/** A resolver over a fixed set of chains. */
function chains(...list) {
  const map = new Map(list.map((c) => [c.primary, c]))
  return (provider, model) => map.get(`${provider}/${model}`) ?? null
}

const chain = (over = {}) => ({
  primary: PRIMARY,
  candidates: [CAND_A, CAND_B],
  triggers: triggersFrom(['rate_limit', 'server_error', 'timeout_network']),
  maxAttempts: 3,
  ...over,
})

/** The resolved config the kernel hands down, deep-frozen like the real one. */
const resolved = () => Object.freeze({
  provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', reasoningEffort: 'high',
})

const failure = (code) => ({ code, message: `${code} failed` })

test('attempt 0 is never taken over, even with a chain configured', () => {
  const fo = createFailover({ chainOf: chains(chain()) })
  const seed = resolved()
  const { takeover, config } = fo.decide({ turn: 1, step: 1, resolved: seed })
  assert.equal(takeover, false)
  assert.equal(config, seed, 'the very same object is returned untouched')
})

test('a trigger failure arms the chain and the next attempt is redirected', () => {
  const fo = createFailover({ chainOf: chains(chain()) })
  const failed = fo.onFailure({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })
  assert.equal(failed.engaged, true)

  const d = fo.decide({ turn: 1, step: 1, resolved: resolved() })
  assert.equal(d.takeover, true)
  assert.equal(d.config.provider, 'workbuddy')
  assert.equal(d.config.model, 'deepseek-v4.1-flash')
})

test('takeover returns a NEW object and does not mutate the frozen config', () => {
  const fo = createFailover({ chainOf: chains(chain()) })
  const seed = resolved()
  fo.onFailure({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })

  const d = fo.decide({ turn: 1, step: 1, resolved: seed })

  assert.notEqual(d.config, seed, 'a new object, since the seed is deep-frozen')
  assert.equal(seed.provider, 'raccoon', 'the frozen seed is untouched')
  assert.equal(seed.model, 'sn-deepseek-v4-1-flash')
  assert.equal(d.config.reasoningEffort, 'high', 'unrelated fields are carried over')
})

test('an untriggered failure never arms the chain', () => {
  const fo = createFailover({ chainOf: chains(chain({ triggers: triggersFrom(['rate_limit']) })) })
  const r = fo.onFailure({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('SERVER') })
  assert.equal(r.engaged, false, 'server error is not enabled on this chain')
  assert.equal(fo.decide({ turn: 1, step: 1, resolved: resolved() }).takeover, false)
})

test('a failure with no chain at all never arms anything', () => {
  const fo = createFailover({ chainOf: () => null })
  const r = fo.onFailure({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })
  assert.equal(r.engaged, false)
})

test('attempts walk the candidates in order, then report exhaustion', () => {
  const fo = createFailover({ chainOf: chains(chain()) })

  fo.onFailure({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })
  assert.equal(fo.decide({ turn: 1, step: 1, resolved: resolved() }).config.provider, 'workbuddy')

  // Second failure is now on the candidate that just failed.
  fo.onFailure({ turn: 1, step: 1, provider: 'workbuddy', model: 'deepseek-v4.1-flash', failure: failure('RATE_LIMIT') })
  assert.equal(fo.decide({ turn: 1, step: 1, resolved: resolved() }).config.provider, 'buddy')

  // Third failure exhausts the usable candidates.
  fo.onFailure({ turn: 1, step: 1, provider: 'buddy', model: 'deepseek-v4.1-flash', failure: failure('RATE_LIMIT') })
  const d = fo.decide({ turn: 1, step: 1, resolved: resolved() })
  assert.equal(d.takeover, false)
  assert.equal(d.record.reason, 'exhausted')
})

test('maxAttempts caps how many candidates are tried', () => {
  const fo = createFailover({ chainOf: chains(chain({ maxAttempts: 1 })) })
  fo.onFailure({ turn: 2, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })
  assert.equal(fo.decide({ turn: 2, step: 1, resolved: resolved() }).config.provider, 'workbuddy')

  fo.onFailure({ turn: 2, step: 1, provider: 'workbuddy', model: 'deepseek-v4.1-flash', failure: failure('RATE_LIMIT') })
  assert.equal(fo.decide({ turn: 2, step: 1, resolved: resolved() }).takeover, false, 'depth 1 stops after one candidate')
})

test('a failure already cooled is skipped rather than retried', () => {
  // Wire one REAL ledger into the failover, and pre-cool candidate A. The
  // selector must then skip A and land on B.
  const cooldowns = createCooldowns({ now: () => 1_000_000 })
  const fo = createFailover({ chainOf: chains(chain()), cooldowns })
  cooldowns.add(CAND_A, { reason: 'rate_limit' })

  fo.onFailure({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })
  const d = fo.decide({ turn: 1, step: 1, resolved: resolved() })

  assert.equal(d.config.provider, 'buddy', 'the cooling candidate is skipped')
  assert.ok(d.record.skipped.some((s) => s.key === CAND_A && s.reason === 'cooling'),
    'and the skip is reported to the user')
})

test('the model that failed is never retried within the same attempt series', () => {
  const cooldowns = createCooldowns({ now: () => 1_000_000 })
  const fo = createFailover({ chainOf: chains(chain()), cooldowns })
  fo.onFailure({ turn: 2, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })
  assert.equal(fo.decide({ turn: 2, step: 1, resolved: resolved() }).config.provider, 'workbuddy')

  // Candidate A now fails too. The next decision must reach B, NOT go back to A.
  fo.onFailure({ turn: 2, step: 1, provider: 'workbuddy', model: 'deepseek-v4.1-flash', failure: failure('RATE_LIMIT') })
  const d = fo.decide({ turn: 2, step: 1, resolved: resolved() })
  assert.equal(d.config.provider, 'buddy', 'A was already tried; the walk moves forward')
})

test('context window filtering skips a candidate that cannot hold the request', () => {
  const windows = { [CAND_A]: 8_000, [CAND_B]: 200_000 }
  const fo = createFailover({
    chainOf: chains(chain()),
    contextWindowOf: (k) => windows[k],
    requestTokensOf: () => 50_000,
  })
  fo.onFailure({ turn: 3, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })
  const d = fo.decide({ turn: 3, step: 1, resolved: resolved() })
  assert.equal(d.config.provider, 'buddy', 'attempt 1 lands on the candidate that fits')
  assert.ok(d.record.skipped.some((s) => s.key === CAND_A && s.reason === 'context_window'))
})

test('when no candidate fits, nothing is sent and the reason is reported', () => {
  const fo = createFailover({
    chainOf: chains(chain()),
    contextWindowOf: () => 1_000,
    requestTokensOf: () => 99_999,
  })
  fo.onFailure({ turn: 4, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })
  const d = fo.decide({ turn: 4, step: 1, resolved: resolved() })
  assert.equal(d.takeover, false, 'no request is dispatched to a candidate that cannot hold it')
  assert.equal(d.record.reason, 'exhausted')
  assert.equal(d.record.skipped.length, 2)
})

test('an unknown context window never costs a candidate its turn', () => {
  const fo = createFailover({
    chainOf: chains(chain()),
    contextWindowOf: () => undefined,
    requestTokensOf: () => 999_999,
  })
  fo.onFailure({ turn: 5, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })
  const d = fo.decide({ turn: 5, step: 1, resolved: resolved() })
  assert.equal(d.takeover, true)
  assert.equal(d.config.provider, 'workbuddy')
})

test('a new step does NOT inherit the previous step failover', () => {
  // Design D3: state is keyed by turn:step. A later step must not be treated as
  // mid-failover, or an ordinary follow-up request would skip the user's model.
  const fo = createFailover({ chainOf: chains(chain()) })
  fo.onFailure({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })
  assert.equal(fo.decide({ turn: 1, step: 1, resolved: resolved() }).takeover, true)

  const next = fo.decide({ turn: 1, step: 2, resolved: resolved() })
  assert.equal(next.takeover, false, 'step 2 starts fresh and keeps the primary')
})

test('reset clears an attempt series so the next request uses the primary again', () => {
  const fo = createFailover({ chainOf: chains(chain()) })
  fo.onFailure({ turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })
  fo.reset(undefined, 1, 1)
  assert.equal(fo.decide({ turn: 1, step: 1, resolved: resolved() }).takeover, false)
})

test('the failure reason is retained for the user, not just the last candidate error', () => {
  const fo = createFailover({ chainOf: chains(chain()) })
  const original = { code: 'RATE_LIMIT', message: 'raccoon upstream TPM exhausted' }
  fo.onFailure({ turn: 6, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: original })
  const d = fo.decide({ turn: 6, step: 1, resolved: resolved() })
  assert.deepEqual(d.record.failure, original, 'the ORIGINAL failure is preserved')
  assert.equal(d.record.from, PRIMARY)
  assert.equal(d.record.to, CAND_A)
})

test('history records each failover fact exactly once', () => {
  const fo = createFailover({ chainOf: chains(chain()) })
  fo.onFailure({ turn: 7, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })
  fo.decide({ turn: 7, step: 1, resolved: resolved() })
  const history = fo.history()
  assert.equal(history.length, 1)
  assert.equal(history[0].from, PRIMARY)
  assert.equal(history[0].to, CAND_A)
})

test('a chain never rewrites the user configuration', () => {
  const configured = chain()
  const snapshot = JSON.stringify(configured)
  const fo = createFailover({ chainOf: chains(configured) })
  for (let i = 0; i < 4; i++) {
    fo.onFailure({ turn: 8, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })
    fo.decide({ turn: 8, step: 1, resolved: resolved() })
  }
  assert.equal(JSON.stringify(configured), snapshot, 'chain contents and order are unchanged')
})

test('sequence state stays bounded over a long session', () => {
  const fo = createFailover({ chainOf: chains(chain()) })
  for (let i = 0; i < SEQUENCE_LIMIT + 20; i++) {
    fo.onFailure({ turn: i, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', failure: failure('RATE_LIMIT') })
  }
  // The oldest series was pruned, so it no longer takes over.
  assert.equal(fo.decide({ turn: 0, step: 1, resolved: resolved() }).takeover, false)
  // A recent one still does.
  assert.equal(fo.decide({ turn: SEQUENCE_LIMIT + 19, step: 1, resolved: resolved() }).takeover, true)
})

test('a malformed failure payload degrades instead of throwing', () => {
  const fo = createFailover({ chainOf: chains(chain()) })
  assert.doesNotThrow(() => fo.onFailure())
  assert.doesNotThrow(() => fo.onFailure({ turn: 1, step: 1 }))
  assert.equal(fo.decide({}).takeover, false)
  assert.equal(fo.decide().takeover, false)
})

test('two sessions at the same turn:step never share an attempt series', () => {
  const fo = createFailover({ chainOf: chains(chain()) })

  // Session A engages its series at turn 1 / step 1.
  fo.observeRequest({ session: 'A', turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' })
  const a = fo.shouldRetry({ session: 'A', turn: 1, step: 1, provider: 'raccoon', failure: failure('RATE_LIMIT') })
  assert.equal(a.retry, true)

  // Session B hits the SAME turn:step — every subagent and workflow child does.
  // It has never failed, so it must not inherit A's engaged series.
  const b = fo.decide({ session: 'B', turn: 1, step: 1, resolved: resolved() })
  assert.equal(b.takeover, false, 'B starts fresh even though A is mid-failover')
})

test('a session whose triggers are all disabled never fails over, whatever another session did', () => {
  // The chain is global (it lives on disk), so mirror the real timeline: session
  // A engages while rate limits are covered, then the user edits the chain to
  // disable every trigger, and session B fails at the same turn:step.
  let current = chain()
  const fo = createFailover({ chainOf: () => current })

  fo.observeRequest({ session: 'A', turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' })
  assert.equal(fo.shouldRetry({ session: 'A', turn: 1, step: 1, provider: 'raccoon', failure: failure('RATE_LIMIT') }).retry, true)

  current = chain({ triggers: { rate_limit: false, server_error: false, timeout_network: false } })

  // Session B fails identically at the same coordinates; its chain covers
  // nothing, so the failure must surface untouched and no candidate be tried.
  fo.observeRequest({ session: 'B', turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' })
  const b = fo.shouldRetry({ session: 'B', turn: 1, step: 1, provider: 'raccoon', failure: failure('RATE_LIMIT') })
  assert.equal(b.retry, false)
  assert.equal(b.reason, 'no-chain')
  assert.equal(fo.decide({ session: 'B', turn: 1, step: 1, resolved: resolved() }).takeover, false)
})

test('resetSession forgets only that session, leaving others mid-failover', () => {
  const fo = createFailover({ chainOf: chains(chain()) })
  for (const session of ['A', 'B']) {
    fo.observeRequest({ session, turn: 1, step: 1, provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' })
    fo.shouldRetry({ session, turn: 1, step: 1, provider: 'raccoon', failure: failure('RATE_LIMIT') })
  }

  fo.resetSession('A')
  assert.equal(fo.decide({ session: 'A', turn: 1, step: 1, resolved: resolved() }).takeover, false)
  assert.equal(fo.decide({ session: 'B', turn: 1, step: 1, resolved: resolved() }).takeover, true)
})
