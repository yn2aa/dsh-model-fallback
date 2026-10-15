/**
 * Cooldown bookkeeping — pure logic behind an injectable clock.
 *
 * A model that failed on a trigger class is briefly set aside so one chain does
 * not keep ramming a provider that is already throwing 429s. Cooldown is keyed
 * by MODEL, not by chain: being rate limited is a property of the model.
 *
 * Two boundaries that the specs pin and that are easy to get wrong:
 *   - Cooldown only ever removes a model from FAILOVER selection. A model used
 *     directly as the primary is never blocked (the caller simply never asks
 *     this module about the primary attempt).
 *   - Cooldown must not mislead across a restart: an entry that expired while
 *     the app was closed must not still gate anything.
 *
 * Time is passed in rather than read, so every branch is testable.
 *
 * @module dsh-model-fallback/cooldown
 */

/** Default cooldown length, in milliseconds. */
export const DEFAULT_COOLDOWN_MS = 60_000

/**
 * Create a cooldown ledger.
 *
 * @param {object} [options] - construction options.
 * @param {number} [options.defaultMs] - default cooldown length.
 * @param {() => number} [options.now] - injectable clock (defaults to Date.now).
 * @returns {object} the ledger API.
 */
export function createCooldowns(options = {}) {
  const defaultMs = Number.isFinite(options.defaultMs) && options.defaultMs > 0
    ? options.defaultMs
    : DEFAULT_COOLDOWN_MS
  const now = typeof options.now === 'function' ? options.now : Date.now

  /** key -> {until, startedAt, reason} */
  const entries = new Map()

  /**
   * Drop entries whose window has passed.
   *
   * Called before every read so a stale entry can never gate a selection — this
   * is what makes a restart safe: nothing has to remember to "clear" expired
   * state, it simply is not visible once its time is up.
   *
   * @returns {number} how many entries were reaped.
   */
  function reap() {
    const t = now()
    let removed = 0
    for (const [key, entry] of entries) {
      if (entry.until <= t) {
        entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  return {
    /**
     * Put a model into cooldown.
     *
     * @param {string} key - `"<provider>/<model>"`.
     * @param {object} [opts] - options.
     * @param {number} [opts.ms] - override length.
     * @param {string} [opts.reason] - why it cooled (reported in the UI).
     * @returns {object} the stored entry.
     */
    add(key, opts = {}) {
      const ms = Number.isFinite(opts.ms) && opts.ms > 0 ? opts.ms : defaultMs
      const startedAt = now()
      const entry = { until: startedAt + ms, startedAt, reason: opts.reason ?? '' }
      entries.set(key, entry)
      return { key, ...entry }
    },

    /**
     * Restore an entry from persisted state.
     *
     * Distinct from {@link add} on purpose: restoring must preserve the ORIGINAL
     * `until` verbatim, including one that has already passed. Routing a restore
     * through `add` would convert an expired entry into a fresh default-length
     * cooldown — resurrecting a cooldown that had already ended while the app was
     * closed, which is exactly what the spec forbids.
     *
     * A window that is already over is accepted and simply never observed by any
     * read (see {@link reap}).
     *
     * @param {string} key - `"<provider>/<model>"`.
     * @param {object} entry - the persisted entry.
     * @param {number} entry.until - absolute expiry timestamp.
     * @param {number} [entry.startedAt] - when it began.
     * @param {string} [entry.reason] - why it cooled.
     * @returns {object} the stored entry.
     */
    restore(key, entry) {
      const until = Number(entry?.until)
      if (!Number.isFinite(until)) return null
      const startedAt = Number.isFinite(Number(entry?.startedAt)) ? Number(entry.startedAt) : until - defaultMs
      const stored = { until, startedAt, reason: entry?.reason ?? '' }
      entries.set(key, stored)
      return { key, ...stored }
    },

    /** @returns {boolean} whether the model is currently cooling. */
    isCooling(key) {
      reap()
      return entries.has(key)
    },

    /**
     * List everything currently cooling.
     *
     * @returns {Array<{key: string, until: number, startedAt: number, reason: string, remainingMs: number}>} entries.
     */
    list() {
      reap()
      const t = now()
      return [...entries.entries()].map(([key, e]) => ({
        key,
        until: e.until,
        startedAt: e.startedAt,
        reason: e.reason,
        remainingMs: e.until - t,
      }))
    },

    /**
     * Clear one model's cooldown manually.
     *
     * @param {string} key - the model key.
     * @returns {boolean} whether an entry was removed.
     */
    clear(key) {
      return entries.delete(key)
    },

    /** Clear everything. */
    clearAll() {
      entries.clear()
    },

    /** How many models are cooling right now. */
    size() {
      reap()
      return entries.size
    },
  }
}
