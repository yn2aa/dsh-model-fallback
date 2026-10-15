/**
 * Host wiring — connects the pure decision core to the live kernel seams.
 *
 * Everything decision-shaped lives in `failover.js` / `chains.js` / `cooldown.js`
 * and is unit-testable on its own. This module is the thin, impure layer that:
 *   - reads the chains the user saved (fresh on every use, so an edit in the
 *     settings page takes effect on the next request without a restart — task 4.7);
 *   - answers "what is this model's context window" from the kernel;
 *   - measures the pending request so an undersized candidate is skipped (D4);
 *   - registers the three kernel listeners;
 *   - serves the settings page's HTTP API.
 *
 * ## The three seams (all verified against the kernel sources)
 *
 * `agent/request` (waterfall) — decides which model the NEXT attempt targets.
 * Registered `{prepend:true}` so this listener is outermost and its returned
 * config wins over the kernel's own `installModelSelection`, which would
 * otherwise re-impose the user's selected model. Its result MUST be returned:
 * returning `undefined` replaces the chain's resolution with `undefined`, which
 * crashed every workspace (see `probe.js`).
 *
 * `agent/request-error` (waterfall) — the only place a failure is observable.
 * Payload is `{turn, step, provider, failure, retryPolicy, signal}`: it names the
 * provider but NOT the model, so the failing model is taken from what
 * `agent/request` last recorded for the same `turn:step`. Returning
 * `{kind:'retry'}` makes the loop re-enter the SAME `turn:step`, running
 * `agent/request` again — which is where the redirect happens. Here (unlike
 * `agent/request`) returning `undefined` is safe: the caller tests
 * `action?.kind !== 'retry'`, so a pass-through just surfaces the original error.
 *
 * `agent/pre-step` (waterfall) — the only safe place to add a session message.
 * The loop commits `decision.messages` before the request is derived
 * (`dsh-agent-loop/lib/index.js:1061`), so a notice added here is durable and
 * does not violate the `llm/stream` log-reconstruction invariant.
 *
 * @module dsh-model-fallback/failover-host
 */

import { createFailover } from './failover.js'
import { createCooldowns } from './cooldown.js'
import { createNotices } from './notice.js'
import { collectCatalog, contextWindowOf, describeCatalogSource } from './catalog.js'
import { estimateTokens } from './request-size.js'
import { normalizeChain } from './chains.js'
import { createApi, toWebHandler, API_BASE } from './routes.js'

/** How long a collected catalog is reused before it is refreshed, in ms. */
export const CATALOG_TTL_MS = 30_000

/** Cached `LlmError` constructor; `undefined` = not resolved yet, `null` = unavailable. */
let llmErrorCtor

/**
 * Build the error that reports the PRIMARY's failure once the chain is exhausted.
 *
 * The kernel reports `LlmError` instances verbatim — `error instanceof LlmError ?
 * error.failure : {message: errorChain(error), code: 'UNKNOWN'}` — so constructing
 * a real `LlmError` keeps the original code and status attached to the failure the
 * user sees. `@deepseek-ai/dsh-llm` is provided by the running host rather than
 * being present on disk beside this plugin, so it is imported lazily and the
 * message is still carried through a plain Error when it cannot be resolved
 * (which is also what happens under `node --test`).
 *
 * @param {string|null} primary - the primary model key, for the explanation.
 * @param {object} failure - the primary's original failure.
 * @returns {Promise<Error>} the error to raise from the seam.
 */
async function primaryError(primary, failure) {
  const message = typeof failure?.message === 'string' && failure.message.length > 0
    ? failure.message
    : 'request failed'
  const code = typeof failure?.code === 'string' && failure.code.length > 0 ? failure.code : 'UNKNOWN'
  const note = primary === null
    ? '（候选模型已全部尝试，以下是主模型的原始失败）'
    : `（候选模型已全部尝试，以下是主模型 ${primary} 的原始失败）`
  const text = `${message}${note}`
  try {
    if (llmErrorCtor === undefined) {
      const mod = await import('@deepseek-ai/dsh-llm')
      llmErrorCtor = typeof mod?.LlmError === 'function' ? mod.LlmError : null
    }
    if (llmErrorCtor !== null) return new llmErrorCtor(text, code, failure)
  } catch {
    llmErrorCtor = null
  }
  const error = new Error(text)
  error.name = 'ModelFallbackError'
  error.code = code
  return error
}

/**
 * Attach the runtime failover machinery.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {object} deps - injected collaborators.
 * @param {() => object[]} deps.loadChains - read the saved chains.
 * @param {(chains: object[]) => void} deps.saveChains - persist the chains.
 * @param {(kind: string, payload: object) => void} deps.appendLog - observation log.
 * @param {() => boolean} deps.isDisabled - the kill switch.
 * @returns {object} handles for the caller (status, disposers, API).
 */
export function attachFailover(ctx, deps) {
  const { loadChains, saveChains, appendLog } = deps
  const isDisabled = deps.isDisabled ?? (() => false)

  /**
   * Resolve the `llm` service LATE, on every use.
   *
   * `apply()` may run before the service is provided, and the plugins that read
   * the model catalog all resolve it inside their request handlers rather than
   * once at load time. Caching it here is what made the settings page show an
   * empty catalog while the kernel had 695 models: the captured value was
   * `undefined` forever, and every later refresh dutifully enumerated nothing.
   */
  function currentLlm() {
    try {
      return ctx.get?.('llm')
    } catch {
      return undefined
    }
  }

  const cooldowns = createCooldowns({})
  const notices = createNotices({})

  /**
   * Resolve a primary model's chain from what is CURRENTLY on disk.
   *
   * Deliberately not cached: the settings page writes chains while the session
   * runs, and the runtime must obey the newest configuration (task 4.7, D6).
   * `loadChains` reads one small JSON file and is only reached on a failure.
   *
   * A chain the user switched off resolves to `null` — indistinguishable from
   * not having one, which is what "disabled" means to the request path.
   */
  function chainOf(provider, model) {
    try {
      const key = `${provider}/${model}`
      for (const raw of loadChains()) {
        if (raw === null || typeof raw !== 'object') continue
        if (raw.enabled === false) continue
        if (raw.primary === key) return raw
      }
    } catch {
      // An unreadable store must not break the request path.
    }
    return null
  }

  /** The kernel's context window for a model, or undefined when unknown. */
  async function contextWindow(provider, model) {
    const llm = currentLlm()
    if (llm?.resolveModelInfo === undefined) return undefined
    try {
      const info = await Promise.resolve(llm.resolveModelInfo(provider, model))
      return contextWindowOf(info)
    } catch {
      return undefined
    }
  }

  const failover = createFailover({
    chainOf,
    cooldowns,
    // Synchronous by contract: the selector runs inside a sync decision. The
    // window is therefore read from the catalog snapshot rather than awaited.
    contextWindowOf: (key) => catalogWindow(key),
    requestTokensOf: () => undefined,
  })

  // --- catalog snapshot, used both by the settings page and the size filter ---

  let catalog = []
  let catalogAt = 0
  let catalogInFlight = null
  /** Last logged catalog shape, so the observation log records changes only. */
  let catalogSignature = null

  /** Refresh the catalog snapshot, de-duplicating concurrent refreshes. */
  function refreshCatalog(force = false) {
    const now = Date.now()
    if (!force && now - catalogAt < CATALOG_TTL_MS) return catalogInFlight ?? Promise.resolve(catalog)
    if (catalogInFlight !== null) return catalogInFlight
    catalogInFlight = (async () => {
      try {
        const llm = currentLlm()
        const source = await describeCatalogSource(llm)
        const models = await collectCatalog(llm ?? {}, {})
        catalog = models
        // An empty result is NOT cached: it usually means the `llm` service was
        // not provided yet (or an adapter was briefly unavailable), and caching
        // it for the whole TTL is what leaves the settings page stuck on
        // "no matching models" until the next window elapses.
        catalogAt = models.length === 0 ? 0 : Date.now()
        // Record the observed windows. The settings API is behind the host's
        // authentication, so this log is the only way to verify from disk that
        // the catalog really comes from the live kernel and which windows it
        // reports (tasks 7.3 and 7.5).
        const withWindow = models.filter((m) => m.contextWindow !== undefined).length
        const signature = `${models.length}/${withWindow}/${source.providers}/${source.llm}`
        if (signature !== catalogSignature) {
          catalogSignature = signature
          appendLog?.('catalog', {
            models: models.length,
            withWindow,
            // Distinguishes "no llm service", "llm present but not enumerating
            // yet" and "llm present with a real provider list" — the settings
            // page alone cannot tell these apart.
            source,
            windows: models
              .filter((m) => m.contextWindow !== undefined)
              .slice(0, 40)
              .map((m) => `${m.key}=${m.contextWindow}`),
          })
        }
      } catch {
        // Keep the previous snapshot on failure.
      } finally {
        catalogInFlight = null
      }
      return catalog
    })()
    return catalogInFlight
  }

  /** Look up a catalog entry's window by `provider/model`. */
  function catalogWindow(key) {
    const entry = catalog.find((item) => item.key === key)
    return entry?.contextWindow
  }

  // --- seam 1: agent/request (choose the next attempt's model) ---

  const disposeRequest = ctx.on('agent/request', async (event, next) => {
    const resolved = await next()
    if (isDisabled()) return resolved
    try {
      const session = event?.agent?.session
      // The attempt series is scoped to this session: subagents and workflow
      // children all start at `turn 1 / step 1`, so without the session id an
      // unrelated session would inherit this one's engaged series.
      const sessionId = session?.id
      // The pending request's size. `deriveMessages()` here excludes the
      // user batch that has not been committed yet, so prefer the size
      // measured at `agent/pre-step` for as long as it still describes this
      // exact history (same derived length) — see the seam 3 comment.
      let tokens
      try {
        const base = session?.deriveMessages?.()
        const pending = typeof sessionId === 'string' ? pendingSizes.get(sessionId) : undefined
        tokens = (Array.isArray(base) && pending !== undefined && base.length === pending.count)
          ? pending.total
          : estimateTokens(base)
      } catch {
        tokens = undefined
      }

      const decision = failover.decide({ session: sessionId, turn: event?.turn, step: event?.step, resolved })

      // Record what is actually about to be SENT, not what the kernel resolved.
      // `agent/request-error` names no model, so `shouldRetry` attributes a
      // failure from this record — if it stored the kernel's own selection
      // instead of the redirected target, the second failure in a series would
      // be blamed on the primary and the walk would stall after one hop.
      const sent = decision.takeover === true ? decision.config : resolved
      failover.observeRequest({
        session: sessionId,
        turn: event?.turn, step: event?.step, provider: sent?.provider, model: sent?.model, tokens,
      })

      if (decision.takeover !== true) return resolved

      appendLog?.('failover', {
        session: sessionId,
        turn: event?.turn, step: event?.step,
        from: decision.record?.from, to: decision.record?.to,
        trigger: decision.record?.trigger, skipped: decision.record?.skipped,
        failure: decision.record?.failure,
      })
      // Queue the in-session notice; it is committed on the next pre-step.
      notices.mark(session?.id, decision.record)
      return decision.config
    } catch (error) {
      appendLog?.('failover-error', { message: String(error?.message ?? error) })
      return resolved
    }
  }, { prepend: true })

  // --- seam 2: agent/request-error (decide whether to retry onto a candidate) ---

  const disposeError = ctx.on('agent/request-error', async (payload, next) => {
    if (isDisabled()) return next()
    let result
    try {
      const { turn, step, provider, failure } = payload ?? {}
      // The seam injects `agent`, so the failing session is known here too. It
      // must match the session `agent/request` recorded under, or the series
      // would be looked up in the wrong bucket.
      const sessionId = payload?.agent?.session?.id
      result = failover.shouldRetry({ session: sessionId, turn, step, provider, failure })
      if (result.retry === true) {
        appendLog?.('failover-retry', { session: sessionId, turn, step, provider, trigger: result.trigger })
      } else {
        appendLog?.('failover-skip', {
          session: sessionId, turn, step, provider,
          reason: result.reason, trigger: result.trigger, primary: result.primary ?? null,
        })
      }
    } catch (error) {
      appendLog?.('failover-error', { message: String(error?.message ?? error) })
      return next()
    }

    if (result.retry === true) return { kind: 'retry' }

    // Every candidate has now been tried, and the kernel is about to throw the
    // LAST attempt's failure. `request-failover` requires the PRIMARY's original
    // failure to be the one the user sees, so raise that instead of letting the
    // loop report an unrelated candidate's error. Thrown OUTSIDE the try above so
    // it is never mistaken for a handler failure.
    if (result.reason === 'exhausted' && result.primaryFailure != null) {
      throw await primaryError(result.primary, result.primaryFailure)
    }
    return next()
  }, { prepend: true })

  // --- seam 3: agent/pre-step (measure the pending request + deliver the deferred notice) ---

  // `agent/request` runs BEFORE the kernel commits the accepted user batch, so
  // `deriveMessages()` there is missing exactly the prompt that makes the
  // request large — measuring the size at that point undercounts and the
  // context-window filter never fires (`agent-loop` README: the first attempt's
  // `agent/request` "sees neither the pending system prompt nor the accepted
  // users"). `agent/pre-step` hands over the pending batch in
  // `decision.messages`, so the full request size is measurable here. The
  // measurement is remembered per session and used by seam 1 only while the
  // batch is still uncommitted (same derived length); once the kernel commits
  // it, `deriveMessages()` covers the content and the fresh measurement wins.
  const PENDING_LIMIT = 128
  const pendingSizes = new Map()
  const rememberPendingSize = (sessionId, session, decision) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const batch = Array.isArray(decision?.messages) ? decision.messages : []
    const base = session?.deriveMessages?.()
    if (!Array.isArray(base)) return
    let total
    try {
      total = estimateTokens([...base, ...batch])
    } catch {
      total = undefined
    }
    if (pendingSizes.has(sessionId)) pendingSizes.delete(sessionId)
    pendingSizes.set(sessionId, { total, count: base.length })
    while (pendingSizes.size > PENDING_LIMIT) {
      const oldest = pendingSizes.keys().next()
      if (oldest.done === true) break
      pendingSizes.delete(oldest.value)
    }
  }

  const disposePreStep = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject') return decision
    if (isDisabled()) return decision
    try {
      const session = payload?.agent?.session
      rememberPendingSize(session?.id, session, decision)
      const message = notices.take(session?.id)
      if (message === null) return decision
      return { ...decision, messages: [...(decision.messages ?? []), message] }
    } catch (error) {
      appendLog?.('notice-error', { message: String(error?.message ?? error) })
      return decision
    }
  }, { prepend: true })

  // --- settings page API over the host webServer ---

  const handle = createApi({
    loadChains: () => loadChains(),
    saveChains: (chains) => saveChains(chains.map((c) => normalizeChain(c))),
    listModels: async () => {
      const models = await refreshCatalog()
      return models
    },
    listCooldowns: () => cooldowns.list(),
    clearCooldown: (key) => cooldowns.clear(key),
    clearAllCooldowns: () => cooldowns.clearAll(),
    history: () => failover.history(),
    status: () => ({
      chains: loadChains().length,
      cooldowns: cooldowns.size(),
      failovers: failover.count(),
      pendingNotices: notices.size(),
      disabled: isDisabled(),
    }),
  })

  let disposeRoute = null

  /**
   * Mount the settings API on a web server.
   *
   * @param {object} server - the `webServer` service.
   * @param {object} [scope] - the cordis scope that owns the registration.
   * @returns {boolean} whether a route was registered.
   */
  function mountRoute(server, scope) {
    if (server === null || typeof server?.register !== 'function') return false
    try {
      // Registered through `effect` when available so the route is torn down with
      // the plugin fiber, exactly as the installed plugins do.
      const register = () => server.register({
        kind: 'prefix', path: API_BASE, handler: toWebHandler(handle),
      })
      const owner = scope ?? ctx
      if (typeof owner.effect === 'function') owner.effect(register, 'model-fallback: settings API')
      else disposeRoute = register()
      // Logged because a silently unregistered route is indistinguishable from a
      // broken page: the settings UI showed "加载失败: not found" for a whole session
      // while the plugin believed it had mounted.
      appendLog?.('route', { path: API_BASE, mounted: true })
      ctx.logger?.info?.(`[model-fallback] settings API mounted at ${API_BASE}`)
      return true
    } catch (error) {
      appendLog?.('route', { path: API_BASE, mounted: false, error: String(error?.message ?? error) })
      return false
    }
  }

  // `ctx.inject(deps, callback)` is cordis' "run this once these services exist":
  // the callback pends while `webServer` is absent *or merely not provided yet*,
  // and is re-run if the service is replaced. Reading `ctx.get('webServer')` once
  // during `apply()` answered `undefined` in the real web composition — plugins
  // load before the browser half publishes it — so the routes never registered and
  // the settings page had no data source while a web server was busy serving it.
  // `dsh-our-free-model/index.js:1267` documents this exact hazard, and
  // `dsh-better-sidebar` avoids it by declaring `inject = ['webServer', ...]`.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => {
      mountRoute(scoped?.webServer ?? scoped?.get?.('webServer'), scoped)
    })
  } else if (!mountRoute(ctx.get?.('webServer'), ctx)) {
    ctx.logger?.info?.('[model-fallback] no webServer facility — the settings API is unavailable in this profile')
    appendLog?.('route', { path: API_BASE, mounted: false, reason: 'no-webServer' })
  }

  // Warm the catalog once `llm` really exists. Reading it during `apply()` finds
  // the service before its model adapters have registered, so the first snapshot
  // comes back empty; the size filter reads this snapshot synchronously and would
  // otherwise stay silently inert until the user happened to open the settings
  // page. An empty snapshot is never cached, so a late adapter still shows up.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], () => { void refreshCatalog(true) })
  } else if (currentLlm() !== undefined) {
    void refreshCatalog(true)
  }

  return {
    failover,
    cooldowns,
    notices,
    handle,
    refreshCatalog,
    dispose() {
      disposeRequest()
      disposeError()
      disposePreStep()
      disposeRoute?.()
    },
  }
}
