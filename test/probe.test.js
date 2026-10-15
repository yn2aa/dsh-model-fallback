import test from 'node:test'
import assert from 'node:assert/strict'

import {
  observe, describe, probeState, resetProbe, attachProbe, PROBE_LIMIT,
} from '../lib/probe.js'

/** A payload as the agent loop dispatches it. */
const event = (turn, step) => ({ turn, step, signal: { aborted: false } })

/** A resolved request config as the agent loop seeds it. */
const resolved = () => Object.freeze({
  provider: 'raccoon',
  model: 'sn-deepseek-v4-1-flash',
  reasoningEffort: 'high',
})

/**
 * Faithful reimplementation of cordis' waterfall dispatch, read from
 * `@deepseek-ai/cordis/lib/index.js:317`:
 *   const inner = args.pop()
 *   const next = () => (cbs.shift() ?? inner)(...args)
 *   args.push(next)
 *   return next()
 *
 * With `args = [payload]` before the push, every listener is invoked as
 * `(payload, next)` — the `next` argument is what a listener composes with.
 * Proof is run against the real composition rules rather than assumptions.
 */
function waterfall(cbs, inner, payload) {
  const queue = [...cbs]
  const next = () => (queue.shift() ?? inner)(payload, next)
  return next()
}

test('describe reports the fields the agent loop consumes', () => {
  const d = describe(resolved())
  assert.equal(d.type, 'object')
  assert.equal(d.provider, 'raccoon')
  assert.equal(d.model, 'sn-deepseek-v4-1-flash')
  assert.equal(d.reasoningEffort, 'high')
  assert.equal(d.frozen, true)
})

test('describe handles non-objects without throwing', () => {
  assert.equal(describe(undefined).type, 'undefined')
  assert.equal(describe(null).type, 'null')
  assert.equal(describe('x').type, 'string')
})

test('observe records payload and resolved shape', () => {
  resetProbe()
  const entry = observe(event(1, 2), resolved())
  assert.equal(entry.turn, 1)
  assert.equal(entry.step, 2)
  assert.deepEqual(entry.eventKeys, ['turn', 'step', 'signal'])
  assert.equal(entry.provider, 'raccoon')
})

test('probe state is a defensive copy, not the live ring', () => {
  resetProbe()
  observe(event(1, 1), resolved())
  const snapshot = probeState()
  snapshot.entries.push({ n: 999 })
  assert.equal(probeState().entries.length, 1, 'mutating a snapshot must not grow the ring')
})

test('ring is bounded and keeps the newest observations', () => {
  resetProbe()
  for (let i = 1; i <= PROBE_LIMIT + 25; i++) observe(event(i, 1), resolved())
  const { seen, entries } = probeState()
  assert.equal(seen, PROBE_LIMIT + 25, 'the counter keeps counting past the cap')
  assert.equal(entries.length, PROBE_LIMIT)
  assert.equal(entries.at(-1).turn, PROBE_LIMIT + 25)
})

test('probe listener passes the resolved config through unchanged', async () => {
  resetProbe()
  let listener
  const ctx = {
    on: (name, fn) => { assert.equal(name, 'agent/request'); listener = fn },
    logger: { info: () => {}, warn: () => {} },
  }
  attachProbe(ctx)

  const seed = resolved()
  const out = await waterfall([listener], () => Promise.resolve(seed), event(1,1))

  assert.equal(out, seed, 'the chain must still yield the resolved config')
  assert.equal(probeState().seen, 1)
})

test('regression: returning undefined destroyed the resolved config', async () => {
  // This is the exact defect that broke every workspace. Reconstruct it so the
  // failure mode stays pinned by a test rather than by memory.
  const badListener = async (_event, next) => {
    await next()
    return undefined // ← the bug
  }
  const out = await waterfall([badListener], () => Promise.resolve(resolved()), event(1,1))
  assert.equal(out, undefined, 'the old listener really did replace the config')

  // ...and the fixed listener does not.
  let goodListener
  attachProbe({
    on: (_n, fn) => { goodListener = fn },
    logger: { info: () => {}, warn: () => {} },
  })
  const fixed = await waterfall([goodListener], () => Promise.resolve(resolved()), event(1,1))
  assert.notEqual(fixed, undefined, 'the fixed listener preserves it')
  assert.equal(fixed.model, 'sn-deepseek-v4-1-flash')
})

test('an inner listener sees the probe pass the value through', async () => {
  // Mirrors the real ordering: dsh-agent's model-selection listener is inner,
  // so it destructures whatever the probe hands down. If the probe returned
  // undefined, this destructure throws exactly like the reported crash.
  resetProbe()
  let probe
  attachProbe({ on: (_n, fn) => { probe = fn }, logger: { info: () => {}, warn: () => {} } })

  const agentLike = async (_payload, next) => {
    const result = await next()
    const { reasoningEffort: _inherited, ...rest } = result // its real line
    return { ...rest, reasoningEffort: 'medium' }
  }

  const out = await waterfall([probe, agentLike], () => Promise.resolve(resolved()), event(1,1))
  assert.equal(out.reasoningEffort, 'medium', 'inner listener still overrides')
  assert.equal(out.provider, 'raccoon')
})

test('an undefined result makes an OUTER listener throw the reported error', async () => {
  // The reported crash, reproduced verbatim.
  //
  // Listener order is the crux, and it is counter-intuitive:
  //   - `register` (plain `on`) PUSHES to the back      → runs innermost/last.
  //   - `next()` SHIFTS from the front                  → visits in array order.
  //   - the value returned by an inner listener is what the next outer one
  //     receives as its `next()` result.
  //
  // The original bug registered the probe with plain `on`, so it ran INNERMOST
  // and its `return undefined` became the `resolved` of the model-selection
  // listener that runs outermost — which then destructured undefined.
  const badInnerProbe = async (_payload, next) => { await next(); return undefined }
  // Verbatim from @deepseek-ai/dsh-agent/lib/index.js:185, whose local binding
  // is named `resolved` — which is why the live crash read `of 'resolved'`.
  const agentLike = async (_payload, next) => {
    const resolved = await next()
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return withoutInheritedEffort
  }

  await assert.rejects(
    () => waterfall([agentLike, badInnerProbe], () => Promise.resolve(resolved()), event(1, 1)),
    /Cannot destructure property 'reasoningEffort' of 'resolved' as it is undefined/,
  )
})

test('LIVE CONTRACT: the seeded config matches what the kernel really supplies', async () => {
  // Measured from a real session, not inferred. An actual observation was:
  //   {"kind":"probe","n":1,"eventKeys":["turn","step","signal","agent"],
  //    "turn":15,"step":1,"type":"object",
  //    "keys":["provider","model","reasoningEffort"],
  //    "provider":"trae","model":"deepseek-v4.1-flash","reasoningEffort":"high",
  //    "frozen":false,"fnKeys":[]}
  //
  // Two facts here contradict what static reading alone suggested, so they are
  // pinned: the event ALSO carries `agent`, and the config is NOT deep-frozen.
  const event = { turn: 15, step: 1, signal: {}, agent: {} }
  const seed = { provider: 'trae', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }

  const d = describe(seed)
  assert.deepEqual(d.keys, ['provider', 'model', 'reasoningEffort'],
    'the config carries exactly provider/model/reasoningEffort')
  assert.equal(d.frozen, false, 'the config is NOT frozen, unlike the earlier assumption')

  resetProbe()
  const entry = observe(event, seed)
  assert.deepEqual(entry.eventKeys, ['turn', 'step', 'signal', 'agent'],
    'the payload includes `agent`, which the design did not anticipate')
  assert.equal(entry.turn, 15)
  assert.equal(entry.provider, 'trae')
})

test('a deep-freeze is still tolerated even though the live config is not frozen', async () => {
  // The design assumed a frozen config and used a spread to avoid mutation.
  // Spread is safe either way; this pins that an in-place write is NOT relied on.
  let listener
  attachProbe({
    on: (_n, fn) => { listener = fn },
    logger: { info: () => {}, warn: () => {} },
  })
  const frozenSeed = Object.freeze({ provider: 'a/b', model: 'c' })
  const out = await waterfall([listener], () => Promise.resolve(frozenSeed), event(1, 1))
  assert.equal(out, frozenSeed, 'a frozen config passes through untouched')
})

test('prepend puts the probe outermost, so it observes the final config', async () => {
  // The fix: `{prepend: true}` unshifts, so the probe is visited first and sees
  // exactly what the chain resolved to.
  resetProbe()
  let options
  let probe
  attachProbe({
    on: (_n, fn, opts) => { probe = fn; options = opts },
    logger: { info: () => {}, warn: () => {} },
  })
  assert.deepEqual(options, { prepend: true }, 'the probe must register prepend')

  const agentLike = async (_payload, next) => {
    const result = await next()
    const { reasoningEffort: _inherited, ...rest } = result
    return { ...rest, reasoningEffort: 'medium' }
  }

  const out = await waterfall([probe, agentLike], () => Promise.resolve(resolved()), event(1, 1))
  assert.equal(out.reasoningEffort, 'medium')

  // The probe is outermost, so it observed the value AFTER the inner listener
  // rewrote it — proof that "outermost sees the most resolved config" holds.
  const observed = probeState().entries.at(-1)
  assert.equal(observed.reasoningEffort, 'medium', 'probe saw the final resolved effort')
  assert.equal(observed.provider, 'raccoon')
})

test('not calling next() vetoes the chain', () => {
  const veto = () => undefined
  const inner = () => 'should-not-run'
  assert.equal(waterfall([veto], inner, event(1,1)), undefined)
})

test('attachProbe degrades without ctx.on instead of throwing', () => {
  const logs = []
  assert.doesNotThrow(() => attachProbe({ logger: { warn: (m) => logs.push(m) } }))
  assert.ok(logs.some((m) => m.includes('not attached')))
})

