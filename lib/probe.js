/**
 * One-shot contract probe for the `agent/request` waterfall.
 *
 * Design.md D2 makes this a deliberate prerequisite: the `agent/request`
 * listener contract cannot be read from any `.d.ts` shipped in this
 * installation, and a wrong signature fails in a way that is hard to diagnose.
 *
 * ── Verified contract (read from source after a live failure) ───────────────
 *
 * `ctx.events.waterfall` (cordis `lib/index.js:317`):
 *
 *     waterfall(...args) {
 *       const cbs = this.dispatch("waterfall", args);
 *       const inner = args.pop();
 *       const next = () => (cbs.shift() ?? inner)(...args);
 *       args.push(next);
 *       return next();
 *     }
 *
 * Consequences a listener MUST respect:
 *
 *  1. Listeners compose like middleware: `(_payload, next)`. Await/settle
 *     `next()` to get what the rest of the chain produced.
 *  2. `next()` returns the INNERMOST value — the seeded config, or whatever an
 *     inner listener produced. With no listener attached that is
 *     `() => Promise.resolve(seedConfig)`, i.e. an object.
 *  3. The chain's return value IS the outermost listener's return value. So a
 *     listener that calls `next()` and then returns `undefined` REPLACES the
 *     resolved config with `undefined` — it does not "pass through".
 *  4. Not calling `next()` at all vetoes the chain (the documented veto
 *     mechanic). That is the only way to suppress.
 *
 * Therefore "record only, do not take over" means: settle `next()` and RETURN
 * THAT VALUE. Returning `undefined` is an override, and it broke
 * `@deepseek-ai/dsh-agent`'s model-selection listener with
 * `Cannot destructure property 'reasoningEffort' of 'resolved' as it is undefined`.
 *
 * The probe registers with `{prepend: true}` so it runs OUTERMOST: `prepend`
 * unshifts the hook (`lib/index.js:336`) and `next()` shifts from the front, so
 * an outermost listener observes the most fully resolved config.
 *
 * @module dsh-model-fallback/probe
 */

/** How many observations to retain for inspection. */
export const PROBE_LIMIT = 200

/** The ring is module-scoped so a reload does not lose what was seen. */
const ring = []

/** Monotonic counter of every probe invocation since process start. */
let seen = 0

/**
 * Describe a resolved config object cheaply.
 *
 * Shape-only: the object may be deep-frozen and is on the hot path, so it is
 * never cloned. Function-valued keys are listed by name so a callback cannot be
 * mistaken for data.
 *
 * @param {unknown} resolved - what `next()` produced.
 * @returns {object} a flat description.
 */
export function describe(resolved) {
  if (resolved === null || typeof resolved !== 'object') {
    return { type: resolved === null ? 'null' : typeof resolved, keys: [], fnKeys: [] }
  }
  return {
    type: 'object',
    keys: Object.keys(resolved),
    provider: resolved.provider,
    model: resolved.model,
    reasoningEffort: resolved.reasoningEffort,
    frozen: Object.isFrozen(resolved),
    fnKeys: Object.keys(resolved).filter((k) => typeof resolved[k] === 'function'),
  }
}

/**
 * Record one `agent/request` invocation.
 *
 * @param {object} event - the waterfall payload (`{turn, step, signal}`).
 * @param {unknown} resolved - the value returned by `next()`.
 * @returns {object} the recorded entry.
 */
export function observe(event, resolved) {
  seen += 1
  const entry = {
    n: seen,
    eventKeys: Object.keys(event ?? {}),
    turn: event?.turn,
    step: event?.step,
    ...describe(resolved),
  }
  ring.push(entry)
  if (ring.length > PROBE_LIMIT) ring.shift()
  return entry
}

/**
 * Read what the probe has observed.
 *
 * @returns {{seen: number, entries: object[]}} a defensive copy of the ring.
 */
export function probeState() {
  return { seen, entries: ring.map((e) => ({ ...e })) }
}

/** Drop all observations (used by tests). */
export function resetProbe() {
  ring.length = 0
  seen = 0
}

/**
 * Attach the probe listener to a Cordis context.
 *
 * The listener is gated by the file kill switch on EVERY call, so the user can
 * neutralize this plugin by editing `<DSH_HOME>/model-fallback/disable` — no
 * restart and no code change required. That guard exists because a bad waterfall
 * listener here can take down every workspace, and the crash we actually hit
 * needed a full restart to recover from.
 *
 * @param {object} ctx - plugin context exposing `on` and `logger`.
 * @param {object} [deps] - injected dependencies (for tests).
 * @param {() => boolean} [deps.isDisabled] - kill-switch predicate.
 * @param {(kind: string, payload: object) => boolean} [deps.appendLog] - log sink.
 */
export function attachProbe(ctx, deps = {}) {
  if (typeof ctx?.on !== 'function') {
    ctx?.logger?.warn?.('[model-fallback] no ctx.on — probe not attached')
    return
  }
  const disabled = deps.isDisabled ?? (() => false)
  const append = deps.appendLog ?? (() => false)

  ctx.on('agent/request', async (event, next) => {
    // Settle the chain FIRST and unconditionally: whatever else happens, this
    // value is what must be returned, or the whole request chain breaks.
    const resolved = await next()

    try {
      if (!disabled()) {
        const entry = observe(event, resolved)
        append('probe', entry)
        ctx.logger?.info?.(
          `[model-fallback] agent/request #${entry.n} turn=${entry.turn} step=${entry.step} ` +
          `resolved=${entry.type} provider=${entry.provider} model=${entry.model} ` +
          `effort=${entry.reasoningEffort} keys=[${entry.keys.join(',')}] frozen=${entry.frozen}`,
        )
      }
    } catch (error) {
      // Observation must never break the request path.
      ctx.logger?.warn?.(`[model-fallback] probe observation failed: ${String(error)}`)
    }

    // MUST return what next() produced: returning undefined REPLACES the
    // resolved config and breaks every inner listener.
    return resolved
  }, { prepend: true })

  ctx.logger?.info?.('[model-fallback] probe attached to agent/request (record-only, outermost)')
}
