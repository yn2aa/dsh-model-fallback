/**
 * Model catalog — enumerate the models the host can actually reach.
 *
 * The editor must show the models the running host knows about, not a table
 * baked into this plugin (spec: "清单来自内核模型枚举"). When a channel is added
 * or disabled, the list must follow with no plugin change.
 *
 * The kernel API is `ctx.llm.listProviders()` / `await ctx.llm.listModels(provider)`,
 * and per-model size metadata comes from
 * `(await ctx.llm.resolveModelInfo(provider, model))?.context?.contextWindow`.
 * Both are read defensively: every entry shape in the wild is tolerated, and any
 * failure degrades to "unknown" rather than to a wrong number — a candidate with
 * an unknown window is still usable (the selector never drops it).
 *
 * @module dsh-model-fallback/catalog
 */

/** Cap on providers enumerated, so a pathological registry cannot stall the page. */
export const PROVIDER_LIMIT = 200

/** Cap on models enumerated per provider. */
export const MODEL_LIMIT = 500

/** How many window lookups may be in flight at once. */
export const WINDOW_CONCURRENCY = 16

/**
 * Time budget for the window pass, in ms.
 *
 * The settings page fetches the catalog through the host's `webServer`, so it is
 * bounded by the client's own request timeout. Resolving a window for every one
 * of the ~700 reachable models one at a time can run past it; stopping early
 * only costs precision, because a model with an unknown window is still eligible
 * as a candidate (the selector never drops it) and the UI says "未知".
 */
export const WINDOW_BUDGET_MS = 4000

/** Read the provider id from one `listProviders()` entry. */
export function providerIdOf(entry) {
  if (typeof entry === 'string' && entry.length > 0) return entry
  if (entry === null || typeof entry !== 'object') return undefined
  for (const field of ['provider', 'route', 'id', 'name']) {
    const value = entry[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Read the model id from one `listModels()` entry. */
export function modelIdOf(entry) {
  if (typeof entry === 'string' && entry.length > 0) return entry
  if (entry === null || typeof entry !== 'object') return undefined
  for (const field of ['id', 'model', 'name']) {
    const value = entry[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Read the human-facing model name from one `listModels()` entry.
 *
 * This is what the kernel's own model picker shows, and for the paid channels it
 * already carries the billing multiplier as a trailing `· x0.51` segment (the
 * provider adapter appends it — there is no separate price API to call). The
 * editor keeps the raw name so it can render the very same label the user sees
 * elsewhere in DSH.
 */
export function modelNameOf(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  for (const field of ['name', 'displayName', 'label', 'title']) {
    const value = entry[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Read the human-facing provider name from one `listProviders()` entry.
 *
 * The picker groups by this ("WorkBuddy (国际版)", "LobsterAI (有道)"), so the
 * editor groups by it too. Falls back to the provider id, which is always usable
 * as a heading.
 */
export function providerLabelOf(entry, provider) {
  if (entry !== null && typeof entry === 'object') {
    for (const field of ['name', 'displayName', 'label', 'title']) {
      const value = entry[field]
      if (typeof value === 'string' && value.length > 0) return value
    }
  }
  return provider
}

/** Read a context window out of a resolved model info, or undefined. */
export function contextWindowOf(info) {
  if (info === null || typeof info !== 'object') return undefined
  const window = info?.context?.contextWindow
  if (Number.isInteger(window) && window > 0) return window
  return undefined
}

/**
 * Diagnose whether a host `llm` value can actually enumerate anything.
 *
 * The settings page can only report "no matching models", which is ambiguous: it
 * looks the same whether the `llm` service is missing, is present but not yet
 * fully started, or is present and genuinely has no providers. This returns the
 * shape needed to tell those apart from the observation log.
 *
 * @param {object} llm - the value read from `ctx.get('llm')`.
 * @returns {Promise<object>} a JSON-serializable report.
 */
export async function describeCatalogSource(llm) {
  if (llm === null || typeof llm !== 'object') return { llm: llm === undefined ? 'undefined' : typeof llm }
  const report = {
    llm: true,
    listProviders: typeof llm.listProviders,
    listModels: typeof llm.listModels,
    resolveModelInfo: typeof llm.resolveModelInfo,
    providers: null,
  }
  try {
    const listed = await Promise.resolve(llm.listProviders?.())
    if (Array.isArray(listed)) report.providers = listed.length
    else if (listed === undefined) report.providers = 'undefined'
    else report.providers = typeof listed
  } catch (error) {
    report.providers = 'threw'
    report.error = String(error?.message ?? error)
  }
  return report
}

/**
 * Enumerate every reachable model with its context window.
 *
 * @param {object} llm - the host `ctx.llm`.
 * @param {object} [options] - limits and signal.
 * @returns {Promise<Array<{provider: string, model: string, key: string, contextWindow?: number}>>} the catalog.
 */
export async function collectCatalog(llm, options = {}) {
  if (llm === null || typeof llm !== 'object') return []
  const providerLimit = options.providerLimit ?? PROVIDER_LIMIT
  const modelLimit = options.modelLimit ?? MODEL_LIMIT

  let providers = []
  try {
    const listed = await Promise.resolve(llm.listProviders?.())
    if (Array.isArray(listed)) providers = listed.slice(0, providerLimit)
  } catch {
    return []
  }

  const out = []
  for (const entry of providers) {
    const provider = providerIdOf(entry)
    if (provider === undefined) continue
    const providerLabel = providerLabelOf(entry, provider)
    let models = []
    try {
      const listed = await Promise.resolve(llm.listModels?.(provider))
      if (Array.isArray(listed)) models = listed.slice(0, modelLimit)
    } catch {
      continue
    }
    for (const modelEntry of models) {
      const model = modelIdOf(modelEntry)
      if (model === undefined) continue
      out.push({
        provider,
        providerLabel,
        model,
        name: modelNameOf(modelEntry),
        key: `${provider}/${model}`,
        contextWindow: undefined,
      })
    }
  }

  // Fill in context windows, a batch at a time, tolerating every failure. This is
  // a separate pass so a single slow or throwing adapter cannot truncate the list
  // the user sees, and it is time-bounded so a slow registry cannot make the
  // settings page time out. Models the budget cut off simply stay "unknown".
  const now = options.now ?? Date.now
  const startedAt = now()
  const budgetMs = options.windowBudgetMs ?? WINDOW_BUDGET_MS
  const concurrency = Math.max(1, options.windowConcurrency ?? WINDOW_CONCURRENCY)

  for (let index = 0; index < out.length; index += concurrency) {
    if (budgetMs > 0 && now() - startedAt > budgetMs) break
    const batch = out.slice(index, index + concurrency)
    await Promise.all(batch.map(async (item) => {
      try {
        const info = await Promise.resolve(llm.resolveModelInfo?.(item.provider, item.model))
        const window = contextWindowOf(info)
        if (window !== undefined) item.contextWindow = window
      } catch {
        // Unknown window: leave it undefined so the UI says "未知" and the
        // selector keeps the candidate eligible.
      }
    }))
  }

  return out
}
