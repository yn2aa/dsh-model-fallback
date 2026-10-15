/**
 * Explicit override test (`agent/request` contract, task 2.2).
 *
 * Answers the one question static reading cannot: does RETURNING a replacement
 * config actually change which model the request goes to?
 *
 * Armed by a file so it cannot fire by accident:
 *   `<DSH_HOME>/model-fallback/override-test`  containing `provider|model`
 *
 * When armed, this listener returns that target on every `agent/request`, and
 * every decision is logged. It registers with `{prepend: true}`, so it runs
 * OUTERMOST and its return value is the one the agent loop actually uses.
 *
 * Deliberately NOT wired into `apply` yet: the probe result is read before this
 * is switched on, so the override cannot confound the baseline observation.
 *
 * @module dsh-model-fallback/override-test
 */

import fs from 'node:fs'
import path from 'node:path'

import { dataDir } from './store.js'

/** The arming file's name inside the plugin data directory. */
export const OVERRIDE_FILE = 'override-test'

/** Absolute path to the arming file. */
export function overridePath() {
  return path.join(dataDir(), OVERRIDE_FILE)
}

/**
 * Read the armed override target.
 *
 * Format is `provider|model`; anything malformed resolves to null so a stray
 * file cannot redirect traffic by accident.
 *
 * @returns {{provider: string, model: string}|null} the target, or null.
 */
export function readOverride() {
  try {
    const raw = fs.readFileSync(overridePath(), 'utf8').trim()
    if (raw === '') return null
    const sep = raw.indexOf('|')
    if (sep <= 0 || sep === raw.length - 1) return null
    const provider = raw.slice(0, sep).trim()
    const model = raw.slice(sep + 1).trim()
    if (provider === '' || model === '') return null
    return { provider, model }
  } catch {
    return null
  }
}

/**
 * Attach the override listener.
 *
 * @param {object} ctx - plugin context.
 * @param {object} deps - injected dependencies.
 * @param {(kind: string, payload: object) => boolean} deps.appendLog - log sink.
 * @param {() => {provider: string, model: string}|null} [deps.read] - override reader.
 */
export function attachOverrideTest(ctx, deps) {
  if (typeof ctx?.on !== 'function') return
  const append = deps.appendLog ?? (() => false)
  const read = deps.read ?? readOverride

  ctx.on('agent/request', async (event, next) => {
    const resolved = await next()
    try {
      const target = read()
      if (target === null) return resolved

      append('override-test', {
        turn: event?.turn,
        step: event?.step,
        was: `${resolved?.provider}/${resolved?.model}`,
        now: `${target.provider}/${target.model}`,
      })
      ctx.logger?.info?.(
        `[model-fallback] OVERRIDE-TEST ${resolved?.provider}/${resolved?.model} -> ` +
        `${target.provider}/${target.model} (turn=${event?.turn} step=${event?.step})`,
      )
      // The whole point of the test: hand back a DIFFERENT config.
      return { ...resolved, provider: target.provider, model: target.model }
    } catch (error) {
      ctx.logger?.warn?.(`[model-fallback] override-test failed: ${String(error)}`)
      return resolved
    }
  }, { prepend: true })

  ctx.logger?.info?.(`[model-fallback] override test armed via ${overridePath()}`)
}
