/**
 * HTTP API surface for the fallback editor — pure request handling.
 *
 * The client half of a DSH plugin has no IPC to the host half; the two halves
 * talk over HTTP routes registered on the host's `webServer` facility (this is
 * how every installed plugin with a UI works, e.g. `dsh-our-free-model` at
 * `/api/our-free-model`). The route registration itself needs a live server, but
 * the request handling does not — so it lives here, taking its data access as
 * injected functions and returning a plain `(method, path, body) -> response`
 * function that tests can drive directly.
 *
 * One deliberate rule (design D6): the editor never keeps its own copy of the
 * chains. Every read goes back to the same store the runtime reads, so the UI
 * cannot drift from what is actually enforced.
 *
 * @module dsh-model-fallback/routes
 */

/** Base path; the client resolves it against `document.baseURI`. */
export const API_BASE = '/api/model-fallback'

/** Build a JSON response description. */
function json(status, payload) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(payload) }
}

/** Split a request path into its non-empty segments, dropping the base. */
function segmentsOf(path) {
  const clean = String(path ?? '').split('?')[0]
  const rest = clean.startsWith(API_BASE) ? clean.slice(API_BASE.length) : clean
  return rest.split('/').filter((part) => part.length > 0)
}

/**
 * Create the API request handler.
 *
 * @param {object} deps - injected data access.
 * @param {() => object[]} deps.loadChains - read the persisted chains.
 * @param {(chains: object[]) => void} deps.saveChains - persist the chains.
 * @param {() => Promise<object[]>|object[]} deps.listModels - enumerate `{provider, model, contextWindow}`.
 * @param {() => object[]} deps.listCooldowns - current cooldown entries.
 * @param {(key: string) => boolean} deps.clearCooldown - clear one model's cooldown.
 * @param {() => void} deps.clearAllCooldowns - clear every cooldown.
 * @param {() => object[]} [deps.history] - failover facts so far.
 * @param {() => object} [deps.status] - plugin status for the header.
 * @returns {(method: string, path: string, body?: unknown) => Promise<object>} the handler.
 */
export function createApi(deps) {
  return async function handle(method, path, body) {
    const parts = segmentsOf(path)
    const verb = String(method ?? 'GET').toUpperCase()
    const head = parts[0] ?? ''

    try {
      if (head === '' && verb === 'GET') {
        return json(200, { ok: true, status: deps.status?.() ?? {} })
      }

      if (head === 'chains') {
        if (verb === 'GET') return json(200, { chains: deps.loadChains() })
        if (verb === 'PUT' || verb === 'POST') {
          const chains = Array.isArray(body) ? body : body?.chains
          if (!Array.isArray(chains)) return json(400, { error: 'chains must be an array' })
          deps.saveChains(chains)
          // Read back from the store rather than echoing the request: the UI must
          // show what was actually persisted, not what it hoped to persist.
          return json(200, { chains: deps.loadChains() })
        }
      }

      if (head === 'models' && verb === 'GET') {
        const models = await Promise.resolve(deps.listModels())
        return json(200, { models: Array.isArray(models) ? models : [] })
      }

      if (head === 'cooldowns') {
        if (verb === 'GET') return json(200, { cooldowns: deps.listCooldowns() })
        if (verb === 'DELETE' && parts[1] === undefined) {
          deps.clearAllCooldowns()
          return json(200, { cooldowns: deps.listCooldowns() })
        }
        if ((verb === 'DELETE' || verb === 'POST') && parts[1] !== undefined) {
          const key = decodeURIComponent(parts.slice(1).join('/'))
          const cleared = deps.clearCooldown(key)
          return json(cleared ? 200 : 404, { cleared, key, cooldowns: deps.listCooldowns() })
        }
      }

      if (head === 'history' && verb === 'GET') {
        return json(200, { history: deps.history?.() ?? [] })
      }

      return json(404, { error: `no route for ${verb} ${path}` })
    } catch (error) {
      return json(500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Adapt the pure handler to a `webServer.register` handler.
 *
 * Reads the body for write verbs, then writes the described response. Kept apart
 * from `createApi` so the decision logic stays testable without a server.
 *
 * @param {(method: string, path: string, body?: unknown) => Promise<object>} handle - from `createApi`.
 * @returns {(req: object, res: object) => Promise<void>} a webServer handler.
 */
export function toWebHandler(handle) {
  return async function webHandler(req, res) {
    let raw = ''
    try {
      for await (const chunk of req) raw += chunk
    } catch {
      raw = ''
    }
    let body
    if (raw.length > 0) {
      try { body = JSON.parse(raw) } catch { body = undefined }
    }
    const result = await handle(req?.method ?? 'GET', req?.url ?? '/', body)
    const headers = { ...result.headers, 'content-length': Buffer.byteLength(result.body) }
    res.writeHead(result.status, headers)
    res.end(result.body)
  }
}
