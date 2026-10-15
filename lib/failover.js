/**
 * Failover decision core — pure logic, no harness coupling.
 *
 * Two kernel seams drive this:
 *   - `agent/request-error` reports that an attempt failed (payload carries
 *     `{turn, step, provider, failure}`). This is the ONLY place a failure — and
 *     therefore a trigger decision — is observable.
 *   - `agent/request` decides which model the NEXT attempt targets (its listener
 *     may return a replacement `{provider, model, …}`).
 *
 * Between them sits a small state machine keyed by `session:turn:step`. Keeping the
 * `turn:step` part narrow is deliberate (design D3): `agent/request` fires on every
 * attempt AND on every ordinary follow-up, so a session-wide counter would misread
 * the second normal request as "mid-failover" and wrongly skip the user's own model.
 *
 * The SESSION part is equally load-bearing. Every subagent and workflow child starts
 * at `turn 1 / step 1`, so a `turn:step`-only key makes unrelated sessions share one
 * attempt series: a session whose chain is engaged leaks its failover into a session
 * whose own triggers are all disabled. Both seams carry `agent`, so the session id is
 * always available.
 *
 * An attempt series owns the PRIMARY it started on, not the model that most
 * recently failed. That distinction matters: once the request has been moved onto
 * a candidate, the failing model is the candidate, which has no chain of its own.
 * Resolving the chain from the failing model would find nothing and silently stop
 * the walk after the first hop.
 *
 * Everything external (chain lookup, context windows, cooldowns) is injected, so
 * the whole decision surface is testable without a running harness.
 *
 * @module dsh-model-fallback/failover
 */

import {
  normalizeChain, chainEngages, classifyFailure, selectCandidates, splitModelKey, modelKey,
} from './chains.js'

/** How many `turn:step` records to retain before pruning the oldest. */
export const SEQUENCE_LIMIT = 64

/**
 * Create the failover state machine.
 *
 * @param {object} deps - injected dependencies.
 * @param {(provider: string, model: string) => object|null} deps.chainOf - resolve a primary's chain.
 * @param {(key: string) => number|null|undefined} [deps.contextWindowOf] - a model's context window.
 * @param {object} [deps.cooldowns] - a ledger from `createCooldowns`.
 * @param {(provider: string, model: string) => number|undefined} [deps.requestTokensOf] - size of the pending request.
 * @returns {object} the state machine API.
 */
export function createFailover(deps = {}) {
  const chainOf = deps.chainOf
  const contextWindowOf = deps.contextWindowOf
  const cooldowns = deps.cooldowns
  const requestTokensOf = deps.requestTokensOf

  /**
   * `<session>:<turn>:<step>` -> {
   *   key, session, turn, step, primary: string|undefined, chain: object|null,
   *   attempts: number, failures: object[], tried: Set<string>,
   *   current: string|null, pending: {key: string, skipped: object[]}|null,
   * }
   *
   * `current` is the model the in-flight attempt actually targets. It matters
   * because `agent/request-error` reports the FAILURE but not the model, so the
   * plugin has to remember what it last sent for this series.
   *
   * Insertion-ordered, so pruning drops the oldest activity first.
   */
  const sequences = new Map()

  /** Failover facts worth showing the user, newest last. */
  const records = []

  /**
   * Build the series key.
   *
   * The session id is part of the key because subagents and workflow children
   * all begin at `turn 1 / step 1`. Keying on `turn:step` alone lets one
   * session's engaged series be inherited by an unrelated session, which then
   * fails over even with every trigger disabled. When a caller cannot supply a
   * session (older tests, defensive call sites), the empty prefix still keeps
   * those records isolated from every real session.
   *
   * @param {string|undefined} session - the owning session id.
   * @param {number} turn - the turn.
   * @param {number} step - the step.
   * @returns {string} the key.
   */
  function seriesKey(session, turn, step) {
    return `${typeof session === 'string' ? session : ''}:${turn}:${step}`
  }

  /** Resolve (and lazily create) the record for one attempt series. */
  function seriesFor(session, turn, step) {
    const key = seriesKey(session, turn, step)
    let series = sequences.get(key)
    if (series === undefined) {
      series = {
        key,
        session: typeof session === 'string' ? session : null,
        turn,
        step,
        primary: undefined,
        chain: null,
        attempts: 0,
        failures: [],
        /** The failure that engaged the series — i.e. the PRIMARY's own failure. */
        primaryFailure: null,
        tried: new Set(),
        current: null,
        tokens: undefined,
      }
      sequences.set(key, series)
      prune()
    }
    return series
  }

  /**
   * Pick the next candidate for a series without recording anything.
   *
   * Shared by `decide` (which acts on it) and `shouldRetry` (which only needs to
   * know whether a retry would lead anywhere). Keeping the selection in one place
   * guarantees both agree on the answer.
   *
   * @param {object} series - the attempt series.
   * @param {number|undefined} explicitTokens - request size when the caller knows it.
   * @returns {{from: string, nextKey: string|undefined, skipped: object[]}|null}
   */
  function selectNext(series, explicitTokens) {
    const normalized = series.chain
    if (normalized === null) return null

    const primaryParts = splitModelKey(series.primary)
    if (primaryParts === null) return null
    const from = modelKey(primaryParts.provider, primaryParts.model)

    // The caller may measure the request directly (the `agent/request` seam sees
    // the agent); otherwise fall back to what `observeRequest` recorded, then to
    // the injected estimator.
    const requestTokens = explicitTokens ?? series.tokens ?? requestTokensOf?.(primaryParts.provider, primaryParts.model)

    // Two exclusions, kept distinct on purpose:
    //   - The selector's `isCooling` covers candidates genuinely dropped from
    //     selection (a real cooldown, or the primary itself). Its `skipped`
    //     list is therefore an accurate account of why a candidate was NOT
    //     eligible, which is what the user-facing record should show.
    //   - "Already tried in this series" is a separate concern: those models
    //     WERE attempted, so they belong in neither list.
    const { usable, skipped } = selectCandidates(normalized, {
      contextWindowOf,
      requestTokens,
      isCooling: (key) => key === from || cooldowns?.isCooling?.(key) === true,
    })

    // Depth cap: attempts counts failures, so it may exceed the permitted
    // number of candidate tries by one (the primary's own failure).
    const depthLeft = series.attempts <= normalized.maxAttempts

    // The next model to try is the first eligible candidate NOT yet tried.
    // Picking by index into a re-filtered list would shift every remaining
    // candidate down whenever an earlier one was dropped.
    const nextKey = depthLeft ? usable.find((key) => !series.tried.has(key)) : undefined

    return { from, nextKey, skipped }
  }

  /** Keep the map bounded so a long session cannot grow it without limit. */
  function prune() {
    while (sequences.size > SEQUENCE_LIMIT) {
      const oldest = sequences.keys().next().value
      sequences.delete(oldest)
    }
  }

  /**
   * Build the exhausted/failover record for a series.
   *
   * @param {object} series - the attempt series.
   * @param {string} from - the primary key.
   * @param {string|null} to - the chosen candidate, or null when exhausted.
   * @param {Array<{key: string, reason: string}>} skipped - candidates dropped during selection.
   * @param {string} reason - 'failover' or 'exhausted'.
   * @returns {object} the record.
   */
  function makeRecord(series, from, to, skipped, reason) {
    // Exhaustion is the primary's story: every candidate has been tried, so the
    // user must see the PRIMARY's original failure. A mid-chain redirect instead
    // reports the failure that caused that particular hop.
    const source = reason === 'exhausted'
      ? (series.primaryFailure ?? series.failures.at(-1) ?? null)
      : (series.failures.at(-1) ?? null)
    return {
      session: series.session,
      turn: series.turn,
      step: series.step,
      from,
      to,
      trigger: classifyFailure(source),
      reason,
      skipped,
      failure: source,
    }
  }

  /**
   * Record one failure against an attempt series.
   *
   * The single place where a failure mutates series state, shared by the direct
   * `onFailure` API and the `agent/request-error` seam. The FIRST failure decides
   * whether the series is engaged at all: if the failing model has no chain, or
   * its chain does not cover this failure class, nothing is recorded and the
   * series stays inert — a failure nobody would fail over on must not put a model
   * out of action.
   *
   * @param {string|undefined} session - the owning session id.
   * @param {number} turn - the turn.
   * @param {number} step - the step.
   * @param {string|null} failedKey - the failing model, or null when unknown.
   * @param {object} failure - the kernel failure.
   * @returns {{engaged: boolean, attempts: number, trigger: string|null}} what happened.
   */
  function recordFailure(session, turn, step, failedKey, failure) {
    const trigger = classifyFailure(failure)
    const series = seriesFor(session, turn, step)
    series.failures.push(failure)

    if (series.primary === undefined) {
      if (failedKey === null) return { engaged: false, attempts: 0, trigger }
      const parts = splitModelKey(failedKey)
      if (parts === null) return { engaged: false, attempts: 0, trigger }
      const chain = chainOf(parts.provider, parts.model)
      if (chain === null || !chainEngages(chain, failure)) {
        return { engaged: false, attempts: 0, trigger }
      }
      series.primary = failedKey
      series.chain = normalizeChain(chain)
      // The failure that engaged the series IS the primary's failure. It is kept
      // separately because `failures` also collects every candidate's failure,
      // and the user must be told why the PRIMARY broke — not why the last
      // candidate happened to fail too (request-failover, exhaustion clause).
      series.primaryFailure = failure
    }

    series.attempts += 1
    if (failedKey !== null) {
      series.tried.add(failedKey)
      cooldowns?.add?.(failedKey, { reason: trigger ?? '' })
    }

    return { engaged: true, attempts: series.attempts, trigger }
  }

  return {
    /**
     * Handle a failed attempt.
     *
     * The direct API, used by tests and by any caller that already knows which
     * model failed. The `agent/request-error` seam uses `shouldRetry` instead,
     * because its payload names only the provider.
     *
     * @param {object} payload - `{session, turn, step, provider, model, failure}`.
     * @returns {{engaged: boolean, attempts: number, trigger: string|null}} what happened.
     */
    onFailure({ session, turn, step, provider, model, failure } = {}) {
      return recordFailure(session, turn, step, resolveKey(provider, model), failure)
    },

    /**
     * Decide whether the next attempt should be taken over.
     *
     * Called from the `agent/request` seam (registered `prepend`, so it runs
     * outermost and observes the fully resolved config). A series with no
     * recorded trigger failure always returns the resolved config untouched — the
     * plugin never redirects the user's own model.
     *
     * On takeover it returns a NEW object: the resolved config is deep-frozen by
     * the kernel, so it must not be mutated in place.
     *
     * @param {object} params - `{session, turn, step, resolved}`.
     * @returns {{takeover: boolean, config: object, record: object|null}} the decision.
     */
    decide({ session, turn, step, resolved } = {}) {
      const series = sequences.get(seriesKey(session, turn, step))
      if (series === undefined || series.attempts <= 0 || series.primary === undefined) {
        return { takeover: false, config: resolved, record: null }
      }

      const selection = selectNext(series)
      if (selection === null) return { takeover: false, config: resolved, record: null }

      const { from, nextKey, skipped } = selection

      if (nextKey === undefined) {
        const record = makeRecord(series, from, null, skipped, 'exhausted')
        records.push(record)
        return { takeover: false, config: resolved, record }
      }

      const target = splitModelKey(nextKey)
      const record = makeRecord(series, from, nextKey, skipped, 'failover')
      records.push(record)

      return {
        takeover: true,
        // New object — never mutate the frozen resolved config.
        config: { ...resolved, provider: target.provider, model: target.model },
        record,
      }
    },

    /**
     * Remember which model the in-flight attempt for a series actually targets.
     *
     * The kernel's `agent/request-error` payload reports `provider` but NOT
     * `model`, so a failure cannot be attributed to a model on its own. This seam
     * runs on every `agent/request`, which DOES know the model, so the series
     * keeps the last-sent route and `shouldRetry` can attribute the failure.
     *
     * @param {object} params - `{session, turn, step, provider, model, tokens}`.
     * @returns {string|null} the recorded key, or null when unusable.
     */
    observeRequest({ session, turn, step, provider, model, tokens } = {}) {
      const key = resolveKey(provider, model)
      if (key === null) return null
      const series = seriesFor(session, turn, step)
      series.current = key
      if (Number.isFinite(tokens) && tokens > 0) series.tokens = tokens
      return key
    },

    /**
     * Decide whether the kernel should retry after a failure.
     *
     * Called from `agent/request-error`. Returning true makes the kernel
     * re-enter the request loop for the SAME `turn:step`, which runs
     * `agent/request` again — where `decide` redirects the model. Returning
     * false lets the original error surface to the user untouched.
     *
     * A retry is only worth asking for when a candidate is actually available to
     * take over: if the chain is exhausted, cooling, or too small a context
     * window fits, the user gets the primary's original failure rather than a
     * pointless retry that would land on the same model.
     *
     * @param {object} params - `{session, turn, step, provider, failure}`.
     * @returns {{retry: boolean, trigger: string|null, reason: string,
     *   primary?: string|null, primaryFailure?: object|null}} the decision.
     *   `primary`/`primaryFailure` are filled in on exhaustion so the caller can
     *   surface the PRIMARY's failure instead of the last candidate's.
     */
    shouldRetry({ session, turn, step, provider, failure } = {}) {
      const trigger = classifyFailure(failure)
      if (trigger === null) return { retry: false, trigger: null, reason: 'unclassified' }

      const series = sequences.get(seriesKey(session, turn, step))
      // The payload names only the provider, so the failing model is taken from
      // the last `agent/request` recorded for this series. Without that record
      // there is no model to look up a chain for, and the failure is left alone
      // rather than guessed at.
      const failedKey = series?.current ?? null

      const { engaged } = recordFailure(session, turn, step, failedKey, failure)
      if (!engaged) return { retry: false, trigger, reason: 'no-chain' }

      // A retry only leads anywhere if a candidate is actually eligible to take
      // over. Otherwise the user gets the primary's original failure rather than
      // a pointless retry that would land on the same model again.
      const selection = selectNext(seriesFor(session, turn, step))
      if (selection === null || selection.nextKey === undefined) {
        const current = seriesFor(session, turn, step)
        return {
          retry: false,
          trigger,
          reason: 'exhausted',
          primary: current.primary ?? null,
          primaryFailure: current.primaryFailure ?? null,
        }
      }
      return { retry: true, trigger, reason: 'failover' }
    },

    /**
     * The failover facts observed so far.
     *
     * @returns {object[]} newest last, as shown in the plugin UI.
     */
    history() {
      return records.map((r) => ({ ...r }))
    },

    /** How many failover attempts have been recorded (startup self-report). */
    count() {
      return records.length
    },

    /**
     * Forget one attempt series, so the next step starts from the primary.
     *
     * @param {string|undefined} session - the owning session id.
     * @param {number} turn - the turn.
     * @param {number} step - the step.
     */
    reset(session, turn, step) {
      sequences.delete(seriesKey(session, turn, step))
    },

    /** Drop all state (tests, and a session change). Also forgets every session. */
    resetSession(session) {
      const prefix = `${typeof session === 'string' ? session : ''}:`
      for (const key of [...sequences.keys()]) {
        if (key.startsWith(prefix)) sequences.delete(key)
      }
    },

    /** Drop all state (tests, and a session change). */
    resetAll() {
      sequences.clear()
      records.length = 0
    },
  }
}

/** Build `"<provider>/<model>"`, or null when either part is unusable. */
function resolveKey(provider, model) {
  if (typeof provider !== 'string' || provider.length === 0) return null
  if (typeof model !== 'string' || model.length === 0) return null
  return modelKey(provider, model)
}
