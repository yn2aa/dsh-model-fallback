/**
 * Verification of the cross-session attempt-series leak fix.
 *
 * Before the fix the series key was `${turn}:${step}`, so a session whose chain
 * was engaged leaked its failover into any other session that happened to be at
 * the same coordinates — and every subagent / workflow child starts at turn 1 /
 * step 1. The key is now `${session}:${turn}:${step}`.
 */

import { createFailover } from '../lib/failover.js'
import { createCooldowns } from '../lib/cooldown.js'

const PRIMARY = 'zcode/GLM-5.3'
const CAND = 'buddy/deepseek-v4-flash'

const ALL_OFF = {
  primary: PRIMARY,
  candidates: [CAND],
  triggers: { rate_limit: false, server_error: false, timeout_network: false },
  maxAttempts: 3,
}
const RATE_ON = {
  primary: PRIMARY,
  candidates: [CAND],
  triggers: { rate_limit: true, server_error: true, timeout_network: true },
  maxAttempts: 3,
}

const rateLimit429 = {
  code: 'RATE_LIMIT',
  status: 429,
  message: 'zcode: 上游并发限流（3009 model concurrency limit exceeded）',
}

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`)
}

console.log('=== Case 1: session A engages (rate_limit ON), session B has ALL triggers OFF ===')
{
  let chain = RATE_ON
  const fo = createFailover({
    chainOf: () => chain,
    contextWindowOf: () => 1_000_000,
    cooldowns: createCooldowns({}),
    requestTokensOf: () => undefined,
  })

  fo.observeRequest({ session: 'A', turn: 1, step: 1, provider: 'zcode', model: 'GLM-5.3' })
  check('session A shouldRetry.retry', fo.shouldRetry({ session: 'A', turn: 1, step: 1, provider: 'zcode', failure: rateLimit429 }).retry, true)
  check('session A decide.takeover', fo.decide({ session: 'A', turn: 1, step: 1, resolved: { provider: 'zcode', model: 'GLM-5.3' } }).takeover, true)

  // The user now edits the shared chain to disable every trigger.
  chain = ALL_OFF

  // Session B hits the SAME turn:step. Before the fix it inherited A's series.
  fo.observeRequest({ session: 'B', turn: 1, step: 1, provider: 'zcode', model: 'GLM-5.3' })
  const b = fo.shouldRetry({ session: 'B', turn: 1, step: 1, provider: 'zcode', failure: rateLimit429 })
  check('session B shouldRetry.retry', b.retry, false)
  check('session B reason', b.reason, 'no-chain')
  check('session B decide.takeover', fo.decide({ session: 'B', turn: 1, step: 1, resolved: { provider: 'zcode', model: 'GLM-5.3' } }).takeover, false)
}

console.log('')
console.log('=== Case 2: session A is still mid-failover after B is untouched ===')
{
  const fo = createFailover({
    chainOf: () => RATE_ON,
    contextWindowOf: () => 1_000_000,
    cooldowns: createCooldowns({}),
    requestTokensOf: () => undefined,
  })
  fo.observeRequest({ session: 'A', turn: 1, step: 1, provider: 'zcode', model: 'GLM-5.3' })
  fo.shouldRetry({ session: 'A', turn: 1, step: 1, provider: 'zcode', failure: rateLimit429 })
  check('A still takes over', fo.decide({ session: 'A', turn: 1, step: 1, resolved: { provider: 'zcode', model: 'GLM-5.3' } }).takeover, true)
  check('B unaffected', fo.decide({ session: 'B', turn: 1, step: 1, resolved: { provider: 'zcode', model: 'GLM-5.3' } }).takeover, false)
}

console.log('')
console.log('=== Case 3: same-session retries still share the series (no regression) ===')
{
  const fo = createFailover({
    chainOf: () => RATE_ON,
    contextWindowOf: () => 1_000_000,
    cooldowns: createCooldowns({}),
    requestTokensOf: () => undefined,
  })
  fo.observeRequest({ session: 'A', turn: 4, step: 2, provider: 'zcode', model: 'GLM-5.3' })
  fo.shouldRetry({ session: 'A', turn: 4, step: 2, provider: 'zcode', failure: rateLimit429 })
  check('first takeover', fo.decide({ session: 'A', turn: 4, step: 2, resolved: { provider: 'zcode', model: 'GLM-5.3' } }).takeover, true)
  // The retry lands on the candidate; its own failure must walk on / exhaust.
  fo.observeRequest({ session: 'A', turn: 4, step: 2, provider: 'buddy', model: 'deepseek-v4-flash' })
  const second = fo.shouldRetry({ session: 'A', turn: 4, step: 2, provider: 'buddy', failure: rateLimit429 })
  check('candidate failure is attributed to the candidate (exhausted)', second.reason, 'exhausted')
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
