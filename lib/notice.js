/**
 * Failover notices — pure logic, no harness coupling.
 *
 * Task 5.6 requires that a redirected answer be visibly marked IN the session,
 * not only in the plugin UI. The kernel already has this machinery for its own
 * model switches: `installModelSelection` appends a durable user-role notice
 * through the `agent/pre-step` waterfall's `decision.messages`, and the loop
 * commits those messages at `dsh-agent-loop/lib/index.js:1061` — BEFORE the
 * request is derived — which is the only point where adding a message is safe.
 * Appending after `buildRequest` has derived `boundaryMessages` violates the
 * `llm/stream` log-reconstruction invariant.
 *
 * So this module builds the same shape the kernel builds, with two differences:
 *   - `source.kind` is `'model-fallback'` (not `'model-selection'`), so the
 *     notice is attributable to this plugin rather than to a user model switch;
 *   - the text names the ORIGINAL FAILURE, which the kernel's notice cannot know.
 *
 * The message is built by hand rather than with `createUserMessage` from
 * `@deepseek-ai/dsh-llm`, because that package is not resolvable from this
 * plugin's install location. The runtime shape is what matters:
 * `assertMessageEventShape` requires a string `id`, `role`, a non-empty string
 * `source.kind`, and a `content` array; `source` itself is TypeScript-only and
 * has no runtime schema, so an extra `form`/`summary` is accepted (the kernel's
 * own notices and the docs' `{kind:'plugin'}` example both do this).
 *
 * @module dsh-model-fallback/notice
 */

import { randomUUID } from 'node:crypto'

/** Bound a summary the way the kernel does (`boundContextSummary`). */
export const SUMMARY_LIMIT = 120

/** How many sessions may hold a pending notice before the oldest is dropped. */
export const PENDING_LIMIT = 64

/**
 * Truncate a summary to the kernel's bound, appending an ellipsis.
 *
 * @param {unknown} summary - the raw summary.
 * @returns {string} the bounded summary.
 */
export function boundSummary(summary) {
  const text = String(summary ?? '')
  return text.length <= SUMMARY_LIMIT ? text : `${text.slice(0, SUMMARY_LIMIT - 1)}…`
}

/**
 * Human-readable label for a trigger kind, falling back to the raw kind.
 *
 * @param {string|null|undefined} trigger - a trigger kind.
 * @returns {string} a label suitable for the notice text.
 */
export function triggerLabel(trigger) {
  switch (trigger) {
    case 'rate_limit': return '限流'
    case 'server_error': return '服务端错误'
    case 'timeout_network': return '超时或网络错误'
    default: return '请求失败'
  }
}

/**
 * Build the durable user-role notice for one failover.
 *
 * @param {object} record - a failover record (`{from, to, trigger, failure}`).
 * @returns {object|null} the message, or null when the record cannot describe one.
 */
export function noticeMessage(record) {
  if (record === null || typeof record !== 'object') return null
  const from = typeof record.from === 'string' && record.from.length > 0 ? record.from : null
  const to = typeof record.to === 'string' && record.to.length > 0 ? record.to : null
  if (from === null || to === null) return null

  const label = triggerLabel(record.trigger)
  const reason = typeof record.failure?.message === 'string' && record.failure.message.length > 0
    ? record.failure.message
    : null

  const text = `[模型改派] 主模型 ${from} 因${label}失败，本次回答改由候选模型 ${to} 生成。`
    + (reason === null ? '' : `原始失败原因：${reason}`)

  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'model-fallback',
      form: 'notice',
      summary: boundSummary(`${from} → ${to}（${label}）`),
    },
  }
}

/**
 * Track which sessions owe the user a failover notice.
 *
 * A notice must be emitted exactly once per failover, and only on the NEXT
 * `agent/pre-step` — the failover itself happens mid-step, after the messages for
 * that step have already been committed. Marking therefore queues the notice and
 * `take` drains it.
 *
 * @param {object} [options] - injectable clock/limit for tests.
 * @returns {object} the queue API.
 */
export function createNotices(options = {}) {
  const limit = options.limit ?? PENDING_LIMIT
  /** session id -> record (newest wins; a session rarely owes more than one). */
  const pending = new Map()

  /** Drop the oldest entry once the queue is full. */
  function prune() {
    while (pending.size > limit) {
      const oldest = pending.keys().next().value
      pending.delete(oldest)
    }
  }

  return {
    /**
     * Queue a notice for a session.
     *
     * @param {string} sessionId - the session to notify.
     * @param {object} record - the failover record.
     * @returns {boolean} whether a notice was queued.
     */
    mark(sessionId, record) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      if (noticeMessage(record) === null) return false
      pending.delete(sessionId)
      pending.set(sessionId, record)
      prune()
      return true
    },

    /**
     * Drain the notice owed to a session, if any.
     *
     * @param {string} sessionId - the session.
     * @returns {object|null} the message to append, or null.
     */
    take(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null
      const record = pending.get(sessionId)
      if (record === undefined) return null
      pending.delete(sessionId)
      return noticeMessage(record)
    },

    /** Whether a session currently owes a notice. */
    has(sessionId) {
      return pending.has(sessionId)
    },

    /** How many sessions owe a notice (self-report). */
    size() {
      return pending.size
    },

    /** Forget everything (tests, session change). */
    clear() {
      pending.clear()
    },
  }
}
