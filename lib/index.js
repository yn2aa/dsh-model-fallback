/**
 * dsh-model-fallback — plugin entry (host half).
 *
 * Gives DSH model fallback chains: when a model call fails on an error class the
 * user enabled for that model's chain, the next model in the chain serves the
 * request instead of the turn dying.
 *
 * Why this plugin needs to exist at all (all verified against this install):
 *   - `@deepseek-ai/dsh-llm-retry` only ever re-runs the SAME provider; the
 *     provider is passed through unchanged and its Config rejects `retryPolicy`.
 *   - The local OpenAI-compatible gateway (127.0.0.1:8326) routes one request to
 *     exactly one `(provider, model)` and has no alias table, model groups, or
 *     hop back into `llm.stream()`.
 *   - The one error the user actually hit (`litellm.* … No fallback model group`)
 *     is minted server-side by the raccoon upstream and relayed verbatim; the
 *     string does not exist anywhere in this installation.
 *
 * The seam is the kernel's `agent/request` WATERFALL: a listener may return a
 * replacement `{provider, model, …}` config, and the agent loop's `while (true)`
 * re-enters it on every attempt. The exact composition rules — including the
 * `return resolved` requirement that a live failure taught us — are documented in
 * `probe.js` and in the change's `implementation-notes.md`.
 *
 * Safety: this plugin can be neutralized at runtime by creating
 * `<DSH_HOME>/model-fallback/disable` containing `off`. The waterfall listener
 * checks it on every call, so no restart is needed to stop interception.
 *
 * @module dsh-model-fallback
 */

import { attachProbe } from './probe.js'
import { attachOverrideTest } from './override-test.js'
import { attachFailover } from './failover-host.js'
import {
  dataDir, isDisabled, disablePath, logPath, appendLog, loadChains, saveChains, resolveDshHome,
} from './store.js'
import { normalizeChain } from './chains.js'

/** Loader entry id; must match `cordis.patch.yml` and the package name. */
export const name = 'model-fallback'

/** Nothing is a hard dependency: a composition without settings degrades. */
export const inject = []

/**
 * Plugin apply. Registered facilities are torn down through the plugin fiber.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {object} config - the entry config (empty today).
 */
export function apply(ctx, config = {}) {
  void config

  const disabled = isDisabled()
  const chains = loadChains().map(normalizeChain)

  ctx.logger?.info?.(
    `[model-fallback] loaded — data dir ${dataDir()}, ${chains.length} chain(s)` +
    `${disabled ? ', DISABLED by kill switch' : ''}`,
  )

  // Self-report (task 5.8): state activation clearly enough that "installed but
  // not working" is distinguishable from "installed and idle" at a glance.
  if (chains.length === 0) {
    ctx.logger?.info?.('[model-fallback] no chains configured — not intervening in any request')
  } else {
    ctx.logger?.info?.(`[model-fallback] chains: ${chains.map((c) => c.primary).join(', ')}`)
  }
  ctx.logger?.info?.(`[model-fallback] kill switch: ${disablePath()} (write "off" to disable)`)
  ctx.logger?.info?.(`[model-fallback] observation log: ${logPath()}`)

  // Task 2.1: attach the record-only probe so the real `agent/request` contract
  // is observable from a file rather than guessed at.
  attachProbe(ctx, { isDisabled, appendLog })

  // Task 2.2: the explicit override test. Inert unless the user arms it by
  // writing `provider|model` into `<DSH_HOME>/model-fallback/override-test`,
  // so it cannot confound normal operation.
  attachOverrideTest(ctx, { appendLog })

  // Tasks 5.6/5.7 + 6.4: the runtime itself — failure observation, retry onto a
  // candidate, the in-session notice, the settings-page API. Attached last so
  // its `{prepend:true}` listeners end up OUTERMOST on both waterfalls: on
  // `agent/request` the kernel's own model selection is inner and therefore
  // cannot overwrite a redirect, and on `agent/request-error` this listener gets
  // first refusal on whether the attempt is retried at all.
  const failoverHost = attachFailover(ctx, {
    loadChains, saveChains, appendLog, isDisabled,
  })

  ctx.logger?.info?.(
    `[model-fallback] runtime armed — settings API at /api/model-fallback` +
    `${ctx.get?.('webServer') === undefined ? ' (unavailable: no webServer facility)' : ''}`,
  )

  return failoverHost
}

export { resolveDshHome, loadChains, saveChains, isDisabled, appendLog }
