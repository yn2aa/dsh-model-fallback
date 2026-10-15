/**
 * Fallback chain data model — pure logic, no I/O.
 *
 * A chain maps one primary model to an ORDERED list of candidates, the error
 * classes that may trigger it, and how deep a single failure may go. Order is
 * the whole point: the list order IS the failover order.
 *
 * This module is deliberately free of `node:fs`, `@deepseek-ai/*` imports and
 * any harness coupling, so every rule here is unit-testable without a running
 * harness. Persistence lives elsewhere (see `store.js`).
 *
 * @module dsh-model-fallback/chains
 */

/** The three independently switchable trigger classes, in stable order. */
export const TRIGGER_KINDS = Object.freeze(['rate_limit', 'server_error', 'timeout_network'])

/**
 * Human-readable meaning of each trigger. Kept beside the kinds so a UI can
 * explain each switch instead of making the user guess from its name.
 */
export const TRIGGER_LABELS = Object.freeze({
  rate_limit: '限流（TPM/RPM 用尽）',
  server_error: '服务端错误（5xx）',
  timeout_network: '超时与网络错误',
})

/**
 * Harness provider-neutral failure codes (`dsh-llm-retry` retryPolicy keys) to
 * trigger classes.
 *
 * Mapped explicitly rather than by substring: a future code must be classified
 * on purpose, and an unknown code must fall through to "no trigger" instead of
 * accidentally matching a fuzzy pattern.
 */
const CODE_TO_TRIGGER = Object.freeze({
  RATE_LIMIT: 'rate_limit',
  SERVER: 'server_error',
  TIMEOUT: 'timeout_network',
  TRANSPORT: 'timeout_network',
  // Quota exhaustion is the same shape as a rate limit — the provider's accounts
  // are all throttled, and switching to another account/model saves the request —
  // so it rides the 限流 switch (m07860).
  QUOTA_EXCEEDED: 'rate_limit',
  ACCOUNT_QUOTA: 'rate_limit',
})

/** Default attempt depth: a failure may try this many candidates. */
export const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Derive a stable key for a (provider, model) pair.
 *
 * @param {string} provider - provider/route id.
 * @param {string} model - model id within the provider.
 * @returns {string} `"<provider>/<model>"`.
 */
export function modelKey(provider, model) {
  return `${provider}/${model}`
}

/**
 * Split a `"<provider>/<model>"` key back into its parts.
 *
 * Models may themselves contain slashes, so only the FIRST slash separates.
 *
 * @param {string} key - the composite key.
 * @returns {{provider: string, model: string}|null} parts, or null if unparsable.
 */
export function splitModelKey(key) {
  if (typeof key !== 'string') return null
  const at = key.indexOf('/')
  if (at <= 0 || at === key.length - 1) return null
  return { provider: key.slice(0, at), model: key.slice(at + 1) }
}

/**
 * Classify a failure into a trigger class.
 *
 * @param {{code?: string, status?: number}|undefined} failure - the failure record.
 * @returns {string|null} one of TRIGGER_KINDS, or null when it is not a trigger.
 */
export function classifyFailure(failure) {
  if (failure === null || typeof failure !== 'object') return null
  const byCode = CODE_TO_TRIGGER[failure.code]
  if (byCode !== undefined) return byCode
  // HTTP status is a fallback signal only: an unmapped code still counts as a
  // server error when the provider reported a 5xx.
  if (Number.isInteger(failure.status) && failure.status >= 500) return 'server_error'
  return null
}

/** An empty trigger set (everything off). */
export function emptyTriggers() {
  return { rate_limit: false, server_error: false, timeout_network: false }
}

/**
 * Build a trigger set from the class names that should be ON.
 *
 * @param {string[]} kinds - trigger kinds to enable.
 * @returns {object} a complete trigger set.
 */
export function triggersFrom(kinds = []) {
  const set = emptyTriggers()
  for (const kind of kinds) {
    if (TRIGGER_KINDS.includes(kind)) set[kind] = true
  }
  return set
}

/**
 * Normalize an untrusted chain record into the canonical shape.
 *
 * Tolerates the field order and missing optional fields a hand-edited file may
 * have; never throws, so a malformed entry degrades instead of taking down the
 * plugin.
 *
 * @param {object} raw - the stored record.
 * @returns {{id: string, name: string, enabled: boolean, primary: string, candidates: string[], triggers: object, maxAttempts: number}} the chain.
 */
export function normalizeChain(raw = {}) {
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.filter((c) => typeof c === 'string' && c.length > 0)
    : []
  const depth = Number(raw.maxAttempts)
  return {
    // A chain's stable identity, independent of its primary model. Two chains may
    // share one primary (two configurations to switch between), so the primary
    // cannot be the identity any more. Older files have no id: they keep `''`
    // here, and every reader falls back to the primary — which was unique back
    // when that was the only way to name a chain, so nothing breaks.
    id: typeof raw.id === 'string' ? raw.id : '',
    // A display name is optional: an unnamed chain is addressed by its primary
    // model, which is what every earlier version of this file relied on. Kept as
    // a string so the editor can bind it to a text input without null checks.
    name: typeof raw.name === 'string' ? raw.name : '',
    // Chains are enabled unless explicitly switched off, so a file written before
    // this field existed keeps working exactly as it did.
    enabled: raw.enabled !== false,
    primary: typeof raw.primary === 'string' ? raw.primary : '',
    candidates,
    triggers: raw.triggers !== null && typeof raw.triggers === 'object'
      ? { ...emptyTriggers(), ...raw.triggers }
      : emptyTriggers(),
    maxAttempts: Number.isInteger(depth) && depth > 0 ? depth : DEFAULT_MAX_ATTEMPTS,
  }
}

/**
 * Validate a chain against the models currently available.
 *
 * Rules (from the `fallback-chains` spec): no self-fallback, no duplicate
 * candidates, every candidate must exist in the current roster.
 *
 * @param {object} chain - a chain, as produced by {@link normalizeChain}.
 * @param {Iterable<string>} knownModels - model keys currently available.
 * @returns {{ok: boolean, errors: string[], unknown: string[]}} the verdict.
 */
export function validateChain(chain, knownModels = []) {
  const normalized = normalizeChain(chain)
  const errors = []
  const unknown = []
  const known = new Set(knownModels)

  if (normalized.primary.length === 0) {
    errors.push('缺少主模型')
  }
  if (normalized.candidates.length === 0) {
    errors.push('候选列表为空')
  }
  if (normalized.primary.length > 0 && normalized.candidates.includes(normalized.primary)) {
    errors.push('不能回退到自身')
  }

  const seen = new Set()
  for (const candidate of normalized.candidates) {
    if (seen.has(candidate)) {
      errors.push(`候选重复：${candidate}`)
    }
    seen.add(candidate)
    if (!known.has(candidate)) {
      unknown.push(candidate)
    }
  }
  if (unknown.length > 0) {
    errors.push(`候选不在当前模型清单中：${unknown.join(', ')}`)
  }

  return { ok: errors.length === 0, errors, unknown }
}

/**
 * Whether a chain should engage for a given failure.
 *
 * A chain with no enabled trigger never engages, which is what keeps an
 * unconfigured plugin behaviourally invisible. A chain the user switched off is
 * treated the same way, so disabling one is equivalent to not having it — the
 * runtime consults this function rather than checking `enabled` separately.
 *
 * @param {object} chain - the chain.
 * @param {object|undefined} failure - the failure record.
 * @returns {boolean} true when a candidate should be tried.
 */
export function chainEngages(chain, failure) {
  const normalized = normalizeChain(chain)
  if (normalized.enabled === false) return false
  if (normalized.candidates.length === 0) return false
  const trigger = classifyFailure(failure)
  if (trigger === null) return false
  return normalized.triggers[trigger] === true
}

/**
 * Order candidates for a failover attempt, dropping those that cannot serve.
 *
 * Context-window filtering happens HERE — before any request is sent — so a
 * candidate that cannot hold the request is skipped rather than tried and
 * failed. A candidate whose window is unknown is NOT skipped: an unknown window
 * must not cost a working candidate a turn.
 *
 * Cooldown skipping is also applied here. Cooldowns only ever remove a
 * candidate from *failover selection*; a cooled model used directly as the
 * primary is never blocked (that is enforced by the caller never consulting
 * this list for the primary attempt).
 *
 * @param {object} chain - the chain.
 * @param {object} [context] - selection context.
 * @param {(key: string) => number|null|undefined} [context.contextWindowOf] - resolves a candidate's window.
 * @param {number} [context.requestTokens] - size of the request being sent.
 * @param {(key: string) => boolean} [context.isCooling] - cooldown predicate.
 * @returns {{usable: string[], skipped: Array<{key: string, reason: string}>}} the selection.
 */
export function selectCandidates(chain, context = {}) {
  const { contextWindowOf, requestTokens, isCooling } = context
  const normalized = normalizeChain(chain)
  const usable = []
  const skipped = []

  for (const candidate of normalized.candidates) {
    if (typeof isCooling === 'function' && isCooling(candidate)) {
      skipped.push({ key: candidate, reason: 'cooling' })
      continue
    }
    const window = typeof contextWindowOf === 'function' ? contextWindowOf(candidate) : undefined
    // Only skip when we have BOTH a known window and a known request size.
    if (
      Number.isFinite(window) && window > 0 &&
      Number.isFinite(requestTokens) && requestTokens > 0 &&
      window < requestTokens
    ) {
      skipped.push({ key: candidate, reason: 'context_window' })
      continue
    }
    usable.push(candidate)
  }

  return { usable, skipped }
}

/**
 * Pick the candidate for a given attempt number.
 *
 * Attempt 0 is the PRIMARY attempt and is always the user's own model — the
 * plugin never redirects it. Attempts 1..n come from the usable candidate list,
 * capped by the chain's maxAttempts.
 *
 * @param {object} chain - the chain.
 * @param {number} attempt - 0-based attempt index.
 * @param {object} [context] - selection context, see {@link selectCandidates}.
 * @returns {{key: string, provider: string, model: string}|null} the target, or null when exhausted.
 */
export function candidateForAttempt(chain, attempt, context = {}) {
  const normalized = normalizeChain(chain)
  if (attempt <= 0) return splitModelKey(normalized.primary)
  const index = attempt - 1
  if (index >= normalized.maxAttempts) return null
  const { usable } = selectCandidates(normalized, context)
  const key = usable[index]
  return key === undefined ? null : splitModelKey(key)
}
