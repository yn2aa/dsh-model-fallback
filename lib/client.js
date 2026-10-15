/**
 * dsh-model-fallback — client half (settings page).
 *
 * A DSH plugin's client half has no IPC to its host half: the two talk over HTTP
 * routes on the host's `webServer` (this plugin mounts `/api/model-fallback`).
 * The client bundle is loaded as a classic script through
 * `window.__ModuleLoader__.load`, so it must be self-contained — the loader
 * rejects relative chunks that were never built, and this plugin has no build
 * step. Everything therefore lives in this one file.
 *
 * Design D6 shapes the whole page: the editor keeps no copy of the chains.
 * It reads them from the host, and every edit is a write followed by a re-read,
 * so the page can never display a configuration the runtime is not enforcing.
 *
 * The pure helpers (`filterModels`, `reorder`, `addCandidate`, …) are attached to
 * the returned plugin as `_internals` so the render smoke test can drive the real
 * code rather than a parallel copy of it.
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-fallback',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } = React

    /**
     * Resolve the API base against the document so the plugin still works when
     * DSH is served under a reverse-proxy sub-path: a leading slash in the
     * REQUEST would drop the prefix and 404 at the gateway, so the request path
     * is relative and only the resulting `pathname` (which does begin with `/`)
     * is used. Mirrors the fix `dsh-our-free-model` shipped for issue #54.
     *
     * @param {string|undefined} baseURI - `document.baseURI`.
     * @returns {string} the request base path.
     */
    function resolveApiBase(baseURI) {
      try { return new URL('api/model-fallback', baseURI).pathname } catch { return '/api/model-fallback' }
    }

    const API_BASE = resolveApiBase(typeof document === 'undefined' ? undefined : document.baseURI)

    /** Fetch JSON from the host half, with a timeout so a dead route cannot hang. */
    async function api(path, options) {
      const { timeout = 8000, ...rest } = options ?? {}
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const response = await fetch(`${API_BASE}${path}`, { ...rest, redirect: 'error', signal: controller.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const get = (path) => api(path, { method: 'GET' })
    const put = (path, body) => api(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    // --- pure editor logic (unit-tested through `_internals`) -----------------

    /** The `provider/model` identity used everywhere in this plugin. */
    function modelKey(provider, model) {
      return `${provider}/${model}`
    }

    /** Read a chain into the exact shape the editor edits. */
    function normalizeChain(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const triggers = source.triggers !== null && typeof source.triggers === 'object' ? source.triggers : {}
      const depth = source.maxAttempts
      return {
        // Stable identity, independent of the primary model: two chains may share
        // one primary (two candidate sets to switch between), so the primary can
        // no longer identify a chain. Older files have no id and keep `''`.
        id: typeof source.id === 'string' ? source.id : '',
        // Mirrors `lib/chains.js`: an unnamed chain falls back to its primary
        // model for display, and a chain is enabled unless explicitly off.
        name: typeof source.name === 'string' ? source.name : '',
        enabled: source.enabled !== false,
        primary: typeof source.primary === 'string' ? source.primary : '',
        candidates: Array.isArray(source.candidates)
          ? source.candidates.filter((c) => typeof c === 'string' && c.length > 0)
          : [],
        triggers: {
          rate_limit: triggers.rate_limit === true,
          server_error: triggers.server_error === true,
          timeout_network: triggers.timeout_network === true,
        },
        maxAttempts: Number.isInteger(depth) && depth > 0 ? depth : 3,
      }
    }

    /**
     * The identity the page uses for a chain: its id, else its primary model.
     *
     * Every piece of editor state (which chain is being edited, renamed, deleted,
     * folded, dragged) is keyed by this. Chains created in the UI always carry a
     * generated id, so the primary fallback only ever applies to a hand-written
     * file — where it is unique, because that was the only way to name a chain
     * before ids existed.
     */
    function chainId(chain) {
      const normalized = normalizeChain(chain)
      return normalized.id !== '' ? normalized.id : normalized.primary
    }

    /**
     * Generate an id for a new chain.
     *
     * `crypto.randomUUID` when the page has it; otherwise a counter combined with
     * the clock. The id only has to be unique among the chains in one file, so a
     * fallback is fine — and a page without `crypto` must still be able to create
     * a chain rather than throw.
     */
    let idCounter = 0
    function newChainId() {
      try {
        const uuid = globalThis.crypto?.randomUUID?.()
        if (typeof uuid === 'string' && uuid.length > 0) return uuid
      } catch {
        // Fall through to the counter.
      }
      idCounter += 1
      return `chain-${Date.now().toString(36)}-${idCounter}`
    }

    /**
     * The next default name: 回退链1, 回退链2, …
     *
     * Numbered from the highest existing 回退链N rather than from the count, so
     * deleting 回退链1 and adding another does not produce a second 回退链1.
     * Names are only labels, so a collision would not be a correctness bug — it
     * would just be confusing.
     */
    function nextChainName(chains) {
      let highest = 0
      for (const chain of Array.isArray(chains) ? chains : []) {
        const match = /^回退链(\d+)$/.exec(normalizeChain(chain).name)
        if (match !== null) highest = Math.max(highest, Number(match[1]))
      }
      return `回退链${highest + 1}`
    }

    /**
     * The preference behind the notice's 不再提示 link.
     *
     * Kept in `localStorage` because it is a per-browser display preference, not
     * plugin configuration: it changes nothing about how failover works, and the
     * host stores chains, not UI habits. Every access is guarded — a page with no
     * storage (a test harness, or storage disabled) simply never remembers, which
     * is the harmless direction: the notice shows again rather than vanishing.
     */
    const DISMISS_KEY = 'dsh-model-fallback:conflict-notice-dismissed'
    let conflictDismissedInMemory = false
    function dismissedConflict() {
      if (conflictDismissedInMemory) return true
      try {
        return globalThis.localStorage?.getItem(DISMISS_KEY) === '1'
      } catch {
        return false
      }
    }
    function dismissConflict() {
      conflictDismissedInMemory = true
      try {
        globalThis.localStorage?.setItem(DISMISS_KEY, '1')
      } catch {
        // The in-memory flag still holds for this page.
      }
    }

    /**
     * Filter the model catalog by a case-insensitive substring.
     *
     * Matches the model id, the display name and the provider name, so a search
     * for `workbuddy` finds the whole channel and a search for `kimi` finds the
     * models wherever they live. An empty query returns everything: the list is
     * the user's palette, and hiding models until they type makes the page look
     * broken.
     */
    function filterModels(models, query) {
      const list = Array.isArray(models) ? models : []
      const needle = String(query ?? '').trim().toLowerCase()
      if (needle === '') return list
      return list.filter((item) => [item?.key, item?.name, item?.providerLabel, item?.provider, item?.model]
        .filter((value) => typeof value === 'string')
        .join(' ')
        .toLowerCase()
        .includes(needle))
    }

    /**
     * Move one candidate to another position, preserving the order of the rest.
     *
     * Returns the same array when the move is a no-op, so a drag that ends where
     * it started does not produce a spurious write (task 4.4 asserts one write).
     */
    function reorder(candidates, from, to) {
      if (!Array.isArray(candidates)) return []
      // Every no-op returns the ORIGINAL reference: the caller skips persistence
      // on identity, so returning a copy here would write an unchanged order and
      // break task 4.4's "one write per drag" guarantee.
      if (!Number.isInteger(from) || !Number.isInteger(to)) return candidates
      if (from < 0 || from >= candidates.length) return candidates
      if (to < 0 || to >= candidates.length) return candidates
      if (from === to) return candidates
      const list = [...candidates]
      const [moved] = list.splice(from, 1)
      list.splice(to, 0, moved)
      return list
    }

    /** Append a candidate, ignoring duplicates (a model appears at most once). */
    function addCandidate(chain, key) {
      const normalized = normalizeChain(chain)
      if (typeof key !== 'string' || key.length === 0) return normalized
      if (normalized.candidates.includes(key)) return normalized
      if (key === normalized.primary) return normalized
      return { ...normalized, candidates: [...normalized.candidates, key] }
    }

    /** Remove a candidate; other chains are untouched by construction. */
    function removeCandidate(chain, key) {
      const normalized = normalizeChain(chain)
      return { ...normalized, candidates: normalized.candidates.filter((c) => c !== key) }
    }

    /**
     * Build a new chain for one primary model.
     *
     * All three triggers start ENABLED. A chain that stays silently inert until
     * the user also discovers the switches is the worst possible first run — they
     * would build a chain, watch nothing happen, and conclude the plugin is
     * broken. The switches are right there to narrow it afterwards, and the
     * runtime default (no triggers, for a hand-written `chains.json`) is the safe
     * default for a file, not for a chain the editor just built.
     */
    function createChain(primary, options = {}) {
      const name = typeof options.name === 'string' ? options.name : ''
      return {
        // A fresh id, so this chain stays itself even if two chains share a
        // primary model or its primary is not chosen yet.
        id: newChainId(),
        // An empty name means "show the primary model" — but a chain created
        // without a primary yet is given a default label (回退链1, 回退链2, …) by
        // the caller, because an empty label next to an empty model says nothing.
        name,
        enabled: true,
        // A chain may start with no primary at all: the empty state's 添加链
        // button creates one, and the palette then fills the model in. Such a
        // chain never engages (the runtime matches by provider/model), which is
        // exactly right for something still being configured.
        primary: typeof primary === 'string' ? primary : '',
        candidates: [],
        triggers: { rate_limit: true, server_error: true, timeout_network: true },
        maxAttempts: 3,
      }
    }

    /** Point a chain at a primary model (used to fill in a chain created empty). */
    function setPrimary(chain, key) {
      const normalized = normalizeChain(chain)
      if (typeof key !== 'string' || key.length === 0) return normalized
      // The model cannot also be one of its own candidates.
      return {
        ...normalized,
        primary: key,
        candidates: normalized.candidates.filter((candidate) => candidate !== key),
      }
    }

    /** Rename a chain. Whitespace-only input clears the name back to the model id. */
    function setName(chain, value) {
      const normalized = normalizeChain(chain)
      const text = typeof value === 'string' ? value.trim() : ''
      return { ...normalized, name: text }
    }

    /** Switch a chain on or off. A disabled chain never engages the runtime. */
    function setEnabled(chain, on) {
      const normalized = normalizeChain(chain)
      return { ...normalized, enabled: on === true }
    }

    /** The label a chain is listed under: its name, else its primary model. */
    function chainTitle(chain) {
      const normalized = normalizeChain(chain)
      return normalized.name !== '' ? normalized.name : normalized.primary
    }

    /** Flip one trigger switch. */
    function setTrigger(chain, kind, on) {
      const normalized = normalizeChain(chain)
      return { ...normalized, triggers: { ...normalized.triggers, [kind]: on === true } }
    }

    /** Set the attempt depth, clamped to a positive integer. */
    function setDepth(chain, value) {
      const normalized = normalizeChain(chain)
      const depth = Number.parseInt(value, 10)
      return { ...normalized, maxAttempts: Number.isInteger(depth) && depth > 0 ? depth : normalized.maxAttempts }
    }

    /**
     * State-identity guards for `refresh`.
     *
     * React re-renders whenever a `set` call hands it a value it does not
     * consider identical, so a poll that rewrites the same data with fresh
     * array/object instances every time would keep the page dirty forever.
     * These helpers compare the payload the host returned against what is
     * already on screen and let `refresh` keep the current value when nothing
     * changed. Chains are compared by value (name + enabled + primary + candidate
     * order + trigger/depth settings), because `refresh` normalises before
     * storing; models, cooldowns and history are compared by reference, which is
     * exact: the host rebuilds those arrays only when their content moves.
     */
    function sameChainValue(a, b) {
      if (a === b) return true
      if (a === undefined || b === undefined) return false
      return a.name === b.name
        && a.id === b.id
        && a.enabled === b.enabled
        && a.primary === b.primary
        && a.maxAttempts === b.maxAttempts
        && a.candidates.length === b.candidates.length
        && a.candidates.every((key, index) => key === b.candidates[index])
        && a.triggers.rate_limit === b.triggers.rate_limit
        && a.triggers.server_error === b.triggers.server_error
        && a.triggers.timeout_network === b.triggers.timeout_network
    }

    function sameChains(current, payload) {
      const next = Array.isArray(payload) ? payload : (payload?.chains ?? [])
      if (!Array.isArray(current) || current.length !== next.length) return false
      return current.every((chain, index) => sameChainValue(chain, next[index]))
    }

    function sameModels(current, payload) {
      return current === (payload ?? [])
    }

    function sameCooldowns(current, payload) {
      return current === (payload ?? [])
    }

    function sameHistory(current, payload) {
      return current === (payload ?? [])
    }

    /**
     * Mark each candidate as available or not, WITH a reason (task 4.6).
     *
     * An unavailable candidate is kept on the chain and explained, never
     * silently dropped: the user's configuration must survive a channel being
     * temporarily disabled, and must come back unchanged when it returns.
     */
    function availabilityOf(candidates, catalogIndex) {
      return (Array.isArray(candidates) ? candidates : []).map((key) => {
        const entry = catalogIndex instanceof Map ? catalogIndex.get(key) : undefined
        if (entry === undefined) {
          return {
            key,
            available: false,
            reason: '当前渠道未提供该模型（配置已保留）',
            price: { display: '', value: null, free: false },
          }
        }
        return {
          key,
          available: true,
          reason: null,
          contextWindow: entry.contextWindow,
          name: entry.name,
          price: priceOf(entry.name),
        }
      })
    }

    /**
     * Render a context window. The unit lives in the catalogue row's tooltip, so a
     * bare number is returned everywhere — repeating "tokens" on every row is exactly
     * the noise the table is there to remove.
     */
    function windowLabel(contextWindow) {
      return Number.isInteger(contextWindow) && contextWindow > 0
        ? contextWindow.toLocaleString('en-US')
        : '窗口未知'
    }

    /**
     * The tooltip under a window value. This is the only place the unit is written
     * down: a standing "窗口单位为 tokens" sentence said nothing the number did not, and
     * every row already had to carry a tooltip for the unknown case.
     */
    function windowTitle(contextWindow) {
      return `${contextWindow ?? '未知'} tokens`
    }

    /**
     * Split the billing multiplier off a model's display name.
     *
     * The channel adapters append it to the name (`Deepseek-V4-Pro · x0.51`,
     * `Step-5-Preview · x0.00→免费`, `Hy4 preview · x0.29→免费`); there is no
     * separate price API to call, and the kernel's own picker shows this same
     * string. Parsing it is what lets the palette put the cheap and free models
     * first instead of making the user read every row. A name without a `·`
     * suffix simply has no known price.
     *
     * A name can carry BOTH a multiplier and a 免费 tag, and they disagree:
     * `x0.29→免费` is a paid multiplier that the channel is currently waiving.
     * The tag wins for display and for ordering, because what the user actually
     * pays is zero — sorting it at x0.29 between two paid rows (m08011) is
     * exactly the "free model in the middle of the numbers" the ordering is
     * meant to prevent. `free` therefore means "costs nothing now", not "has a
     * zero multiplier".
     *
     * @returns {{display: string, value: number|null, free: boolean}}
     */
    function priceOf(name) {
      const text = typeof name === 'string' ? name : ''
      const at = text.lastIndexOf('·')
      if (at < 0) return { display: '', value: null, free: false }
      const tail = text.slice(at + 1).trim()
      const match = /^x\s*([0-9]+(?:\.[0-9]+)?)/.exec(tail)
      const waived = tail.includes('免费')
      if (match === null) {
        // `Qwen3.8-Flash · 免费` — no multiplier at all, just the tag.
        if (!waived) return { display: '', value: null, free: false }
        return { display: '免费', value: 0, free: true }
      }
      const value = Number(match[1])
      const free = waived || value === 0
      // `x0.00 免费` is redundant: the multiplier is zero precisely because it is
      // free, and the extra glyphs are what made the price column the widest cell in
      // the table — and therefore the thing every other column had to line up with.
      return { display: free ? '免费' : `x${match[1]}`, value: free ? 0 : value, free }
    }

    /** The model's display name with the price suffix removed; falls back to the id. */
    function titleOf(model) {
      const name = typeof model?.name === 'string' ? model.name : ''
      const at = name.lastIndexOf('·')
      const trimmed = (at < 0 ? name : name.slice(0, at)).trim()
      if (trimmed !== '') return trimmed
      if (typeof model?.model === 'string' && model.model !== '') return model.model
      return String(model?.key ?? '')
    }

    /** Order two models cheapest-first, unknown price last (see `compareWindow`). */
    function comparePrice(left, right) {
      const a = priceOf(left?.name).value
      const b = priceOf(right?.name).value
      if (a === b) return 0
      if (a === null) return 1
      if (b === null) return -1
      return a - b
    }

    /** The context window as a number, or null when the host did not report one. */
    function windowValueOf(model) {
      const window = model?.contextWindow
      return Number.isInteger(window) && window > 0 ? window : null
    }

    /** Order two models smallest-window-first. */
    function compareWindow(left, right) {
      const a = windowValueOf(left)
      const b = windowValueOf(right)
      if (a === b) return 0
      if (a === null) return 1
      if (b === null) return -1
      return a - b
    }

    /** The columns the table headers can sort by. */
    const SORT_KEYS = Object.freeze({ price: comparePrice, window: compareWindow })

    /**
     * Sort the catalogue by one column.
     *
     * A null sort leaves the host's order alone. Values the host did not report
     * stay last in BOTH directions — flipping a column must never promote a model
     * with no known price or window above one that has a real number.
     */
    function sortModels(models, sort) {
      const list = Array.isArray(models) ? models : []
      const comparator = sort === null || sort === undefined ? undefined : SORT_KEYS[sort.key]
      if (comparator === undefined) return list
      // `global` is the third click of a sortable column: the rows sort by the same
      // column but render without their source dividers, so the run is continuous.
      const direction = sort.direction === 'desc' ? -1 : 1
      return [...list].sort((a, b) => {
        const aUnknown = isUnknownFor(sort.key, a)
        const bUnknown = isUnknownFor(sort.key, b)
        if (aUnknown || bUnknown) {
          if (aUnknown && bUnknown) return 0
          return aUnknown ? 1 : -1
        }
        return direction * comparator(a, b)
      })
    }

    /** Whether the host reported no value for the column being sorted. */
    function isUnknownFor(key, model) {
      return key === 'window' ? windowValueOf(model) === null : priceOf(model?.name).value === null
    }

    /**
     * Group the catalog by provider.
     *
     * Groups keep the host's own provider order — the same order the DSH model
     * picker uses — and are labelled with the provider's human name, so the list
     * reads like the picker the user already knows rather than like a flat dump
     * of `provider/model` keys. Row order inside a group is the caller's
     * (already-sorted) order: grouping never reorders.
     */
    function groupModels(models) {
      const groups = []
      const index = new Map()
      for (const model of Array.isArray(models) ? models : []) {
        if (model === null || typeof model !== 'object') continue
        const provider = String(model.provider ?? '')
        let group = index.get(provider)
        if (group === undefined) {
          group = { provider, label: String(model.providerLabel ?? provider), models: [] }
          index.set(provider, group)
          groups.push(group)
        }
        group.models.push(model)
      }
      return groups
    }

    // The bold part is the switch's name and nothing else; every qualifier that used
    // to sit in parentheses moves into the grey help text, so the label reads at a
    // glance and the explanation lives in exactly one place.
    const TRIGGERS = [
      { kind: 'rate_limit', label: '限流', help: 'TPM/RPM 或额度用尽，上游返回限流错误时改派。典型是每分钟 token 用量超限，或账号全部在限流中。' },
      { kind: 'server_error', label: '服务端错误', help: 'HTTP 5xx，上游返回服务端错误时改派。适合应对服务端临时故障。' },
      { kind: 'timeout_network', label: '超时与网络错误', help: '请求超时或连接中断时改派。' },
    ]

    const DEPTH_HELP = '一次失败最多尝试几个候选。用尽后不再重试，直接向用户报告主模型的原始失败原因。'

    // --- styles (inline: the bundle ships no stylesheet) ----------------------

    // DSH ships a design-token layer (`--dsw-*`) that every installed plugin's
    // client bundle paints with. Leaning on it instead of ad-hoc colours keeps this
    // page consistent with the rest of the shell and correct in both themes.
    const MONO = 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
    const TEXT_PRIMARY = 'var(--dsw-alias-label-primary)'
    const TEXT_SECONDARY = 'var(--dsw-alias-label-secondary)'
    const TEXT_TERTIARY = 'var(--dsw-alias-label-tertiary)'
    const BORDER = 'var(--dsw-alias-border-l2)'
    const SURFACE = 'var(--dsw-alias-bg-layer-1)'

    const styles = {
      page: { padding: '16px', fontFamily: 'inherit', fontSize: '13px', lineHeight: '1.6' },
      h2: { margin: '0 0 4px', fontSize: '16px' },
      hint: { margin: '0 0 16px', color: TEXT_SECONDARY },
      // The surface is painted, not inherited: the sticky table header sits on this
      // exact colour, and `background: inherit` resolved to transparent (no
      // ancestor paints a background), which let rows scroll through the header.
      panel: { border: `1px solid ${BORDER}`, borderRadius: '8px', padding: '16px', marginBottom: '12px', background: SURFACE },
      primaryRow: { display: 'flex', alignItems: 'baseline', gap: '8px', fontWeight: 600, marginBottom: '10px', flexWrap: 'wrap' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' },
      candidate: { cursor: 'grab', flex: '1', padding: '4px 8px', borderRadius: '4px', border: `1px dashed ${BORDER}` },
      candidateUnavailable: {
        cursor: 'grab',
        flex: '1',
        padding: '4px 8px',
        borderRadius: '4px',
        border: '1px dashed var(--dsw-alias-state-warn-primary)',
        color: 'var(--dsw-alias-state-warn-primary)',
      },
      tag: { fontSize: 'var(--dsw-font-xxxs-11, 11px)', color: TEXT_SECONDARY },
      tagId: { fontSize: 'var(--dsw-font-xxxs-11, 11px)', color: TEXT_TERTIARY, fontFamily: MONO },
      // The catalogue is a table: one grid template shared by the header row, the
      // channel divider rows and every data row, so columns line up instead of
      // drifting with the length of each label. A grid track is only as wide as its
      // widest cell, so the numeric columns are `max-content` **and** their headings
      // are kept narrower than the values — a heading wider than the data would leave
      // a gap in front of every number. That is why the window column's heading says
      // only `上下文窗口` and the unit lives in each row's tooltip. The trailing 来源
      // column is the only flexible one: the slack lands after the last value, where
      // empty space is invisible.
      grid: {
        display: 'grid',
        // The name track is capped rather than `max-content`: one unusually long
        // key used to stretch the column past every other name, leaving a wide
        // blank band to the right of the short ones. A capped track pulls the
        // numeric columns back towards the names, and the rare long name keeps
        // its full text in the row's `title`.
        gridTemplateColumns: '26px minmax(0, 220px) max-content max-content minmax(120px, 1fr)',
        alignItems: 'center',
        columnGap: '12px',
      },
      // The selection cell: a flex box so the radio/checkbox lands on the row's
      // text centre line instead of the inline baseline (which reads as high).
      pick: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
      th: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: '3px',
        // One tight line. The label used to share the cell with a second line holding
        // the unit, which pushed the labels out of step and left a band of air between
        // the text and the border. An explicit line-height keeps the tightness even if
        // the shell hands down a looser one.
        height: '26px',
        boxSizing: 'border-box',
        lineHeight: '1.3',
        fontSize: 'var(--dsw-font-xxxs-11, 11px)',
        fontWeight: 600,
        color: TEXT_TERTIARY,
        padding: '4px 6px',
        borderBottom: `1px solid ${BORDER}`,
        position: 'sticky',
        top: 0,
        // Measured, not assumed: with a painted background the heading already
        // out-paints the rows (elementFromPoint inside the overlap returns the
        // heading), so this level is only insurance against a stacking context the
        // host shell might introduce around the table.
        zIndex: 2,
        background: SURFACE,
      },
      thRight: { justifyContent: 'flex-end' },
      cell: { padding: '6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      cellRight: { textAlign: 'right' },
      stripe: { background: 'var(--dsw-alias-bg-layer-2)' },
      // The source divider doubles as the fold toggle, so it is a real button with
      // the default chrome reset — the previous `div` had no interactive contract.
      groupRow: {
        gridColumn: '1 / -1',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        cursor: 'pointer',
        border: 'none',
        background: SURFACE,
        textAlign: 'left',
        width: '100%',
        font: 'inherit',
        fontSize: 'var(--dsw-font-xxxs-11, 11px)',
        fontWeight: 600,
        color: TEXT_TERTIARY,
        letterSpacing: '0.04em',
        padding: '12px 6px 4px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      groupCaret: { fontSize: '10px', lineHeight: '1', opacity: 0.8 },
      // A panel heading that folds its panel: chrome reset, so it reads as text that
      // happens to be clickable rather than as a second kind of button on the page.
      foldButton: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        cursor: 'pointer',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        padding: '0',
      },
      // A bare caret rather than a boxed button: the box's padding and border made the
      // heading wider than the numbers underneath it, which is what pushes a gap in
      // front of every value in a `max-content` numeric column.
      sortButton: {
        cursor: 'pointer',
        padding: '0',
        margin: '0',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        lineHeight: '1',
      },
      // Tabular figures: the whole point of a numeric column is that the digits line up.
      // No mono face — the table reads better with one typographic register, and
      // `tabular-nums` alone keeps the digits aligned.
      numeric: { fontVariantNumeric: 'tabular-nums' },
      sourceTag: { fontSize: 'var(--dsw-font-xxxs-11, 11px)', color: TEXT_TERTIARY },
      free: { fontWeight: 600, color: 'var(--dsw-alias-state-success-primary)' },
      // A row in the chain roster: the selection radio, then the title and the
      // enable/delete controls. The row itself is not a click target — the radio
      // selects it, the name renames it — so nothing here invites a stray click.
      //
      // The row is one line: the title takes whatever is left and ellipsises, and the
      // metadata and controls are sized to their content. Without that split a long
      // model key steals width from the controls and wraps them into a vertical stack.
      chainRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        padding: '6px',
        borderRadius: '6px',
      },
      // A disabled chain is still listed and still editable — dimmed, not hidden, so
      // switching one back on is one click rather than a rebuild.
      chainRowOff: { opacity: 0.55 },
      chainFold: { flex: '1 1 auto', minWidth: '0', overflow: 'hidden' },
      chainName: { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      chainKey: { flex: '0 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chainMeta: { fontSize: 'var(--dsw-font-xxxs-11, 11px)', color: TEXT_TERTIARY, whiteSpace: 'nowrap', flex: '0 0 auto' },
      chainSpacer: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto', whiteSpace: 'nowrap' },
      renameInput: { flex: '1 1 auto', minWidth: '0', padding: '2px 6px', borderRadius: '4px', border: `1px solid ${BORDER}`, background: 'transparent', color: 'inherit', font: 'inherit' },
      button: { cursor: 'pointer', padding: '4px 10px', borderRadius: '6px', border: `1px solid ${BORDER}`, background: 'transparent', color: 'inherit', whiteSpace: 'nowrap' },
      buttonDisabled: { cursor: 'not-allowed', padding: '4px 10px', borderRadius: '6px', border: `1px solid ${BORDER}`, background: 'transparent', color: TEXT_TERTIARY, whiteSpace: 'nowrap' },
      input: { flex: '1 1 auto', minWidth: '0', padding: '6px 10px', borderRadius: '6px', border: `1px solid ${BORDER}`, background: 'transparent', color: 'inherit', fontSize: 'inherit' },
      error: { color: 'var(--dsw-alias-state-error-primary)', marginBottom: '8px' },
      muted: { color: TEXT_TERTIARY },
      label: { display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '6px' },
      mono: { fontFamily: MONO, fontSize: '12px' },
      // The empty state's whole point is its one button, so the button sits alone on
      // its own line with room around it rather than tucked under the sentence.
      blankState: { display: 'flex', justifyContent: 'center', padding: '18px 0 6px' },
      // The "one chain per primary at a time" notice: an inline strip between the
      // roster and the editor, not a dialog — it reports something that already
      // happened, and blocking the page to say so would be heavier than the event.
      conflictNotice: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        flexWrap: 'wrap',
        border: `1px solid ${BORDER}`,
        borderRadius: '6px',
        padding: '8px 12px',
        marginBottom: '12px',
        background: SURFACE,
      },
      // 不再提示 is a link, not a button: it dismisses a note, it does not act on
      // the chains, so it should not look like the controls that do.
      linkButton: {
        cursor: 'pointer',
        padding: '0',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-state-info-primary, #4c8dff)',
        font: 'inherit',
      },
    }

    // --- scroll anchoring -----------------------------------------------------

    /** Whether a box scrolls its own overflow, reading inline style first. */
    function scrollsOverflow(box) {
      const inline = box?.style?.overflowY
      if (inline === 'auto' || inline === 'scroll') return true
      if (inline !== undefined && inline !== '') return false
      if (typeof getComputedStyle !== 'function') return false
      try {
        const computed = getComputedStyle(box)?.overflowY
        return computed === 'auto' || computed === 'scroll'
      } catch { return false }
    }

    /**
     * Every ancestor of `node` that can actually scroll, innermost first, then the
     * document scroller.
     *
     * The picker itself is deliberately excluded (the walk starts at `parentNode`):
     * it is a capped `overflow-y: auto` box, and scrolling its own contents is not
     * what moved.
     *
     * All of them rather than just one, because the correction is applied by whatever
     * has room: if the outermost scroller is already at its end it cannot absorb the
     * shift, and the next one in has to. A single choice made in advance gets that
     * case wrong and the page jumps anyway.
     *
     * @param {object} node - an element inside the scroll containers.
     * @returns {object[]} scrolling elements, innermost first.
     */
    function scrollableAncestors(node) {
      const found = []
      let current = node?.parentNode ?? null
      while (current !== null && current !== undefined) {
        if (scrollsOverflow(current)
          && Number.isFinite(current.scrollHeight) && current.scrollHeight > current.clientHeight
          && !found.includes(current)) {
          found.push(current)
        }
        current = current.parentNode ?? null
      }
      const doc = typeof document === 'undefined' ? null : (document.scrollingElement ?? null)
      if (doc !== null && doc !== undefined && !found.includes(doc)) found.push(doc)
      return found
    }

    /**
     * Keep an element at the same place on screen while content above it grows.
     *
     * Adding a candidate renders a new row in the chain's candidate list, which sits
     * directly above the picker the user is clicking in. Everything below the new row
     * moves down, so the picker slides out from under the pointer and the page appears
     * to jump. The browser's own scroll anchoring does not cover this: it anchors on a
     * node near the top of the viewport, and when the growth is inside the viewport
     * that node does not move — so nothing is compensated and the picker drifts down.
     *
     * So the shift is measured and undone by hand. Scrolling any ancestor of the picker
     * moves it on screen, so the amount it moved is spread over the scrollable
     * ancestors until it is fully cancelled — the outermost one first, falling through
     * to the next when one is already at its end.
     *
     * @param {object} node - the element to hold still (the candidate picker).
     * @param {number} beforeTop - its viewport top before the write.
     * @returns {number} pixels actually scrolled (0 when nothing moved).
     */
    function keepAnchored(node, beforeTop) {
      if (typeof node?.getBoundingClientRect !== 'function') return 0
      const delta = node.getBoundingClientRect().top - beforeTop
      if (!Number.isFinite(delta) || delta === 0) return 0

      let remaining = delta
      let moved = 0
      const scrollers = scrollableAncestors(node)
      for (let i = scrollers.length - 1; i >= 0 && remaining !== 0; i--) {
        const scroller = scrollers[i]
        if (!Number.isFinite(scroller.scrollTop)) continue
        const before = scroller.scrollTop
        scroller.scrollTop = before + remaining
        const applied = scroller.scrollTop - before
        if (applied !== 0) {
          moved += applied
          remaining -= applied
        }
      }
      return moved
    }

    // --- the settings page ----------------------------------------------------

    function FallbackSettingsPage() {
      const [chains, setChains] = useState([])
      const [models, setModels] = useState([])
      const [cooldowns, setCooldowns] = useState([])
      const [history, setHistory] = useState([])
      const [query, setQuery] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [expanded, setExpanded] = useState(null)
      const [drag, setDrag] = useState(null)
      // Provider groups the user folded up: a Set of provider keys, null while
      // nothing is folded so the Set is only allocated on demand.
      const [collapsed, setCollapsed] = useState(null)
      // Cheapest-first is the useful default: the whole point of showing the
      // multiplier is picking a cheap candidate. Clicking a column header flips it.
      const [sort, setSort] = useState({ key: 'price', direction: 'asc' })
      const [picked, setPicked] = useState(null)
      // The palette is the tallest thing on the page and the least interesting once a
      // model is chosen, so it can be folded away to leave the chains in view.
      const [paletteFolded, setPaletteFolded] = useState(false)
      // Chains whose candidate list is folded up: a Set of chain primaries, null while
      // nothing is folded.
      const [candidatesFolded, setCandidatesFolded] = useState(null)
      // The chain currently being renamed, so its row shows a text box instead of its
      // title. The box is uncontrolled and the value is read off the event on commit,
      // so typing a name is one write at the end rather than one per keystroke.
      const [renaming, setRenaming] = useState(null)
      // The chain awaiting a second click before it is deleted. Deleting is the one
      // action here with nothing to undo, so it takes two deliberate clicks.
      const [confirmingDelete, setConfirmingDelete] = useState(null)
      // The chain whose editor is open. Nothing is edited until 编辑 is pressed: the
      // management list is the page's home, and the palette plus the candidate
      // editor are a lot of surface to carry around while just looking at the list.
      const [editing, setEditing] = useState(null)
      // The "same primary model, one chain at a time" notice: null when nothing was
      // just displaced, else `{primary, count}`.
      const [conflictNotice, setConflictNotice] = useState(null)
      // Scroll anchoring: the picker's viewport top captured just before a write, and
      // the picker node itself. `useLayoutEffect` below puts it back after the re-render.
      const anchor = useRef(null)
      const pickerRef = useRef(null)

      const refresh = useCallback(async () => {
        try {
          const [chainPayload, modelPayload, coolPayload, historyPayload] = await Promise.all([
            get('/chains'), get('/models'), get('/cooldowns'), get('/history'),
          ])
          // Skip no-op writes: with a fresh array on every poll the render loop
          // never converges, and a re-read is not a user-visible change anyway.
          setChains((current) => sameChains(current, chainPayload.chains) ? current : chainPayload.chains.map(normalizeChain))
          setModels((current) => sameModels(current, modelPayload.models) ? current : (modelPayload.models ?? []))
          setCooldowns((current) => sameCooldowns(current, coolPayload.cooldowns) ? current : (coolPayload.cooldowns ?? []))
          setHistory((current) => sameHistory(current, historyPayload.history) ? current : (historyPayload.history ?? []))
          setError(null)
        } catch (caught) {
          setError(caught?.message ?? String(caught))
        }
      }, [])

      useEffect(() => { void refresh() }, [refresh])

      /** Persist the whole chain set, then re-read it from the host (D6). */
      const persist = useCallback(async (next) => {
        setBusy(true)
        try {
          const payload = await put('/chains', { chains: next })
          // Trust the host's answer over local state: it is what the runtime reads.
          setChains((payload.chains ?? []).map(normalizeChain))
          setError(null)
        } catch (caught) {
          setError(caught?.message ?? String(caught))
        } finally {
          setBusy(false)
        }
      }, [])

      /** Apply an edit to one chain and persist the result once. */
      const editChain = useCallback((id, transform) => {
        const next = chains.map((chain) => (chainId(chain) === id ? transform(chain) : chain))
        void persist(next)
      }, [chains, persist])

      /**
       * Note where the open picker sits, so a write that grows the list above it can
       * be undone. Called from the handlers that add or remove a candidate — the ones
       * whose write changes the height of the content above the picker.
       */
      const rememberPicker = useCallback(() => {
        const node = pickerRef.current
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return
        const top = node.getBoundingClientRect().top
        anchor.current = Number.isFinite(top) ? top : null
      }, [])

      // Runs after every render, before paint: if a write just moved the picker, put
      // it back. A layout effect rather than a passive one because a passive effect
      // would let the browser paint the shifted frame first, which is the flicker.
      //
      // The anchor is NOT released on the first render it sees. A write renders at
      // least twice — once for the busy flag, then again when the host's answer
      // replaces the chains — and the candidate list only grows on the later one.
      // Releasing on the first (where nothing has moved yet) is what made the
      // correction miss whenever the growth was on screen: Chrome's own scroll
      // anchoring happens to cover the off-screen case, which is why it looked like it
      // worked sometimes and not others. So the anchor lives until the layout actually
      // moves, or until the write it belongs to has finished.
      useLayoutEffect(() => {
        if (anchor.current === null) return
        const moved = keepAnchored(pickerRef.current, anchor.current)
        if (moved !== 0 || !busy) anchor.current = null
      })

      const catalogIndex = useMemo(() => {
        const index = new Map()
        for (const model of models) {
          const key = model?.key ?? modelKey(model?.provider, model?.model)
          if (typeof key === 'string' && key.length > 0) index.set(key, model)
        }
        return index
      }, [models])

      const visible = useMemo(() => filterModels(models, query), [models, query])

      /** Provider groups over the sorted catalogue (the palette's exact shape). */
      const flat = useMemo(() => sortModels(visible, sort), [visible, sort])
      const groups = useMemo(() => groupModels(flat), [flat])
      /** A header's third click: sort the whole catalogue flat, ignoring the sources. */
      const globalSort = sort !== null && sort.direction === 'global'

      /** Fold or unfold one provider group. */
      const toggleGroup = useCallback((provider) => {
        setCollapsed((current) => {
          const next = new Set(current ?? [])
          if (next.has(provider)) next.delete(provider)
          else next.add(provider)
          return next.size === 0 ? null : next
        })
      }, [])

      /** Fold or unfold one chain's candidate list. */
      const toggleCandidates = useCallback((primary) => {
        setCandidatesFolded((current) => {
          const next = new Set(current ?? [])
          if (next.has(primary)) next.delete(primary)
          else next.add(primary)
          return next.size === 0 ? null : next
        })
      }, [])

      /**
       * The chain whose editor is open — the single source of truth for "which chain
       * am I looking at". The roster's 编辑 button is the only thing that changes it,
       * so there is no second control whose meaning could drift from this one.
       *
       * An id that no longer exists (the chain was deleted, or the host answered with
       * a different set) simply closes the editor: the page falls back to the
       * management list, which is its home state.
       */
      const active = editing === null
        ? null
        : (chains.find((chain) => chainId(chain) === editing) ?? null)

      /** The identity of the chain currently being edited (what every handler keys off). */
      const activeId = active === null ? null : chainId(active)

      /**
       * Delete a chain, one write.
       *
       * Filtering by id rather than by index: the roster is keyed by id everywhere
       * else, and an index would go stale the moment a write reorders the list the
       * host returns. Ids also survive two chains sharing one primary model.
       */
      const deleteChain = useCallback((id) => {
        if (editing === id) setEditing(null)
        void persist(chains.filter((chain) => chainId(chain) !== id))
      }, [chains, persist, editing])

      /**
       * Add a chain and open its editor.
       *
       * With no model picked this creates an EMPTY chain (no primary), which is
       * what the empty state's 添加链 button asks for: a chain you then point at a
       * model. It is named 回退链N from the start, because an unnamed chain shows
       * its primary model — and an empty primary would show nothing at all.
       */
      const addChain = useCallback((primary = '') => {
        const chain = createChain(primary, { name: nextChainName(chains) })
        setEditing(chainId(chain))
        void persist([...chains, chain])
      }, [chains, persist])

      /**
       * Switch a chain on, switching off any other chain on the same primary model.
       *
       * The runtime resolves a request to ONE chain (`chainOf` returns the first
       * match), so two enabled chains on one primary would make the second dead
       * weight — silently, with no way to tell from the page. Rather than allow
       * that, enabling one switches the others off in the same write: the last
       * choice wins, which is what "启用" looks like it should do. Chains on the
       * same primary but switched OFF are untouched, so two candidate sets can be
       * kept and swapped between.
       */
      const enableChain = useCallback((id, on) => {
        const target = chains.find((chain) => chainId(chain) === id) ?? null
        if (target === null) return
        const primary = target.primary
        const switched = []
        const next = chains.map((chain) => {
          const current = chainId(chain)
          if (current === id) return setEnabled(chain, on)
          // Only a chain being switched ON displaces others, and only chains that
          // actually name the same primary model can displace each other.
          if (!on || primary === '' || chain.primary !== primary) return chain
          if (chain.enabled === false) return chain
          switched.push(chain)
          return setEnabled(chain, false)
        })
        if (on && primary !== '' && switched.length > 0 && !dismissedConflict()) {
          setConflictNotice({ primary, count: switched.length })
        }
        void persist(next)
      }, [chains, persist])

      /** Clicking a sortable header walks asc → desc → global; another column starts asc. */
      const toggleSort = useCallback((key) => {
        setSort((current) => (current === null || current.key !== key
          ? { key, direction: 'asc' }
          : { key, direction: current.direction === 'asc' ? 'desc' : current.direction === 'desc' ? 'global' : 'asc' }))
      }, [])

      /** The mark on a sortable header: `↕` inactive, `≡` while sorting across sources. */
      const sortMark = (key) => (sort !== null && sort.key === key
        ? (sort.direction === 'asc' ? '↑' : sort.direction === 'desc' ? '↓' : '≡')
        : '↕')

      /** The window as a bare number — the unit lives in the row's tooltip. */
      const windowCell = (contextWindow) => (Number.isInteger(contextWindow) && contextWindow > 0
        ? contextWindow.toLocaleString('en-US')
        : '未知')

      /**
       * Render the catalogue as a table.
       *
       * One column header row, one full-width divider per channel, then a row per
       * model. The header carries the sort controls, so both the header and the rows
       * hold bare labels and numbers; the unit the window column is measured in lives
       * in each row's tooltip. Every row uses the same grid template as the header,
       * which is what makes the columns line up.
       *
       * @param {(model: object, key: string) => object} control - the row's radio/checkbox.
       * @param {(model: object) => boolean} [allow] - skip rows this chain cannot use.
       * @param {number} [cap] - cap on rendered rows, so ~700 models stay cheap.
       */
      // A column heading is one tight line: the label, then the sort caret at the right
      // edge. The unit a column measures in does not go here — on this line it would
      // widen the column past its own numbers (`上下文窗口 tokens` is 99px against
      // `1,000,000`'s 60px), and on a line of its own it would leave every other
      // heading with a band of air under its label. It is stated once, above the table.
      function columnHead(key, label, sortKey) {
        return h('div', { key, style: { ...styles.th, ...styles.thRight } }, [
          h('span', { key: 't' }, label),
          h('button', {
            key: 's',
            style: styles.sortButton,
            title: `按${label}排序`,
            onClick: () => toggleSort(sortKey),
          }, sortMark(sortKey)),
        ])
      }

      function renderPicker(control, allow = null, cap = 300) {
        // The first cell is the selection column; it carries no label because the
        // radio/checkbox is self-explanatory and a one-character heading only ever
        // wrapped onto two lines in a 26px column.
        const header = h('div', { key: '__head', style: { display: 'contents' } }, [
          h('div', { key: 'h0', style: styles.th }),
          h('div', { key: 'h1', style: styles.th }, '模型名称'),
          columnHead('h2', '计费倍率', 'price'),
          columnHead('h3', '上下文窗口', 'window'),
          h('div', { key: 'h4', style: styles.th }, '来源'),
        ])

        const nodes = []
        let emitted = 0
        // One row = five grid cells wrapped in `display: contents`. The pick cell is
        // a flex box so the radio/checkbox is centred on the row's text: left to the
        // inline baseline a native control reads as riding slightly high.
        const rowFor = (model, band) => {
          const key = typeof model.key === 'string' && model.key !== ''
            ? model.key
            : modelKey(model.provider, model.model)
          const price = priceOf(model.name)
          const cell = (extra) => ({ ...styles.cell, ...band, ...extra })
          // The three value columns use the name column's own face: a mono face here
          // split the table into two typographic registers for no gain, and
          // `tabular-nums` alone already lines the digits up.
          return h('div', { key, style: { display: 'contents' } }, [
            h('div', { key: 'pick', style: cell(styles.pick) }, control(model, key)),
            h('div', { key: 'n', style: cell({ color: TEXT_PRIMARY }), title: key }, titleOf(model)),
            h('div', {
              key: 'p',
              style: cell({ ...(price.free ? styles.free : styles.numeric), ...styles.cellRight }),
              title: price.display,
            }, price.display === '' ? '—' : price.display),
            h('div', {
              key: 'w',
              style: cell({ ...styles.numeric, ...styles.cellRight }),
              title: windowTitle(model.contextWindow),
            }, windowCell(model.contextWindow)),
            h('div', { key: 'id', style: cell(styles.sourceTag), title: key }, key),
          ])
        }
        if (globalSort) {
          // `≡`: the whole catalogue as one flat, sorted run — no source dividers.
          // This walks the sorted list itself, not the groups: grouping keeps a
          // source's rows together, which would silently re-introduce the source
          // order the user asked to ignore.
          for (const model of flat) {
            if (emitted >= cap) break
            if (allow !== null && !allow(model)) continue
            nodes.push(rowFor(model, emitted % 2 === 1 ? styles.stripe : {}))
            emitted += 1
          }
        } else {
          for (const group of groups) {
            if (emitted >= cap) break
            const folded = collapsed !== null && collapsed.has(group.provider)
            const rows = []
            if (!folded) {
              for (const model of group.models) {
                if (emitted >= cap) break
                if (allow !== null && !allow(model)) continue
                rows.push(rowFor(model, emitted % 2 === 1 ? styles.stripe : {}))
                emitted += 1
              }
            }
            // A folded group still shows its row — that row is how the user unfolds
            // it — while a group with no matching model stays hidden.
            if (folded || rows.length > 0) {
              nodes.push(h('button', {
                key: group.provider,
                type: 'button',
                style: styles.groupRow,
                title: folded ? '展开该来源的模型' : '收起该来源的模型',
                onClick: () => toggleGroup(group.provider),
              }, [
                h('span', { key: 'c', style: styles.groupCaret }, folded ? '▸' : '▾'),
                h('span', { key: 'l' }, group.label),
              ]), ...rows)
            }
          }
        }

        const body = nodes.length === 0
          ? [h('div', { key: 'empty', style: { gridColumn: '1 / -1', ...styles.muted, padding: '8px 6px' } }, '没有匹配的模型')]
          : nodes
        return [header, ...body]
      }

      const clearCooldown = useCallback(async (key) => {
        try {
          await api(`/cooldowns/${encodeURIComponent(key)}`, { method: 'DELETE' })
          const payload = await get('/cooldowns')
          setCooldowns(payload.cooldowns ?? [])
        } catch (caught) {
          setError(caught?.message ?? String(caught))
        }
      }, [])

      const clearAllCooldowns = useCallback(async () => {
        try {
          await api('/cooldowns', { method: 'DELETE' })
          const payload = await get('/cooldowns')
          setCooldowns(payload.cooldowns ?? [])
        } catch (caught) {
          setError(caught?.message ?? String(caught))
        }
      }, [])

      const children = []

      children.push(h('h2', { key: 'title', style: styles.h2 }, '模型回退链'))
      children.push(h('p', { key: 'hint', style: styles.hint },
        '为每个主模型编排候选模型。主模型触发已勾选的失败类型时，本次请求改由候选模型按顺序接管；改派不会修改你的配置，下一次请求仍先试主模型。'))

      if (error !== null) {
        children.push(h('div', { key: 'error', style: styles.error }, `加载失败：${error}`))
      }

      // --- model palette (task 4.1) ---
      // The primary model belongs here rather than on the chain editor: it is picked
      // from this list, and with one editor following the roster it needs a home that
      // does not move when the selection changes.
      // `active` is null when there is no chain at all, and `activePrimary` is null when
      // the chain's model is not in the catalogue — both mean "no name or price to show".
      const activePrimary = active === null || active.primary === '' ? null : (catalogIndex.get(active.primary) ?? null)
      const activePrice = activePrimary === null ? null : priceOf(activePrimary.name)
      // A chain created by 添加链 has no primary yet, and this list is where it gets
      // one: with such a chain open, the button fills it in instead of making another.
      const fillingEmptyChain = active !== null && active.primary === ''
      // Two chains may share a primary model (two candidate sets to swap between), so
      // the button no longer refuses a model that already leads a chain.
      const canPick = picked !== null && !busy
      const palettePanel = h('div', { key: 'palette', style: styles.panel }, [
        h('div', { key: 'p-title', style: styles.primaryRow }, [
          h('button', {
            key: 'fold',
            type: 'button',
            style: styles.foldButton,
            title: paletteFolded ? '展开模型清单' : '收起模型清单',
            onClick: () => setPaletteFolded((current) => !current),
          }, [
            h('span', { key: 'c', style: styles.groupCaret }, paletteFolded ? '▸' : '▾'),
            h('span', { key: 't' }, `可用模型清单（${models.length}）`),
          ]),
          active === null ? null : h('span', {
            key: 'current',
            style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px' },
          }, active.primary === ''
            ? [h('span', { key: 'l', style: styles.tag }, '当前主模型：'), h('span', { key: 'n', style: styles.muted }, '尚未选择')]
            : [
              h('span', { key: 'l', style: styles.tag }, '当前主模型：'),
              h('span', { key: 'n' }, activePrimary === null ? active.primary : titleOf(activePrimary)),
              activePrice === null || activePrice.display === ''
                ? null
                : h('span', { key: 'p', style: activePrice.free ? styles.free : styles.numeric }, activePrice.display),
              h('span', { key: 'k', style: styles.tagId }, active.primary),
            ]),
        ]),
        paletteFolded ? null : h('div', { key: 'body' }, [
          h('div', { key: 'controls', style: styles.row }, [
            h('input', {
              key: 'search',
              style: styles.input,
              placeholder: '搜索模型或渠道，例如 kimi / workbuddy',
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),
            h('button', {
              key: 'create',
              style: canPick ? styles.button : styles.buttonDisabled,
              disabled: !canPick,
              title: picked === null
                ? '先在左侧选中一个模型，再点这里'
                : fillingEmptyChain
                  ? `把 ${picked} 设为当前这条链的主模型`
                  : `以 ${picked} 为主模型新建一条回退链`,
              onClick: () => {
                if (picked === null) return
                if (fillingEmptyChain) {
                  editChain(activeId, (current) => setPrimary(current, picked))
                  return
                }
                void persist([...chains, createChain(picked)])
              },
            }, fillingEmptyChain ? '设为这条链的主模型' : '设为回退链主模型'),
          ]),
          // One line only: the count and the current selection. The window column's
          // unit lives in each row's `title` tooltip rather than on this line, so the
          // line stays about what the user is choosing.
          h('div', { key: 'count', style: styles.tag },
            picked === null
              ? `匹配 ${visible.length} 个`
              : `匹配 ${visible.length} 个 · 已选 ${picked}`),
          h('div', { key: 'list', style: { ...styles.grid, maxHeight: '440px', overflowY: 'auto', marginTop: '8px' } },
            renderPicker((model, key) => h('input', {
              key: 'pick',
              type: 'radio',
              name: 'model-fallback-primary',
              checked: picked === key,
              onChange: () => setPicked(key),
            }))),
        ]),
      ])

      // --- chain roster (management) ---
      //
      // One window for every chain: a row per chain carrying the selection, the name,
      // the enable box, 编辑 and delete. Nothing is edited until 编辑 is pressed — the
      // list is the page's home, and the palette plus the candidate editor are too much
      // surface to carry around while just looking at which chains exist.
      if (chains.length === 0) {
        // Nothing to manage: the one useful action is to start a chain, so the empty
        // state is that action rather than a paragraph explaining there is nothing.
        children.push(h('div', { key: 'empty', style: styles.panel }, [
          h('div', { key: 'title', style: styles.primaryRow }, '回退链（0）'),
          h('p', { key: 'hint', style: styles.hint },
            '还没有配置任何回退链。插件不会干预任何请求，行为与安装前一致。'),
          h('div', { key: 'blank', style: styles.blankState }, [
            h('button', {
              key: 'add',
              type: 'button',
              style: busy ? styles.buttonDisabled : styles.button,
              disabled: busy,
              title: '新建一条空链，然后在下面的模型清单里给它挑一个主模型',
              onClick: () => addChain(''),
            }, '添加链'),
          ]),
        ]))
      } else {
        children.push(h('div', { key: 'roster', style: styles.panel }, [
          h('div', { key: 'title', style: styles.primaryRow }, [
            h('span', { key: 't' }, `回退链（${chains.length}）`),
            // With chains present the add button belongs on the title line: the list
            // is the thing being managed, so adding to it sits with it.
            h('span', { key: 'add-wrap', style: { marginLeft: 'auto' } }, [
              h('button', {
                key: 'add',
                type: 'button',
                style: busy ? styles.buttonDisabled : styles.button,
                disabled: busy,
                title: '新建一条空链，然后在下面的模型清单里给它挑一个主模型',
                onClick: () => addChain(''),
              }, '添加链'),
            ]),
          ]),
          h('p', { key: 'hint', style: styles.hint },
            '每条链只对它自己声明的主模型生效。停用的链不参与改派，但配置会保留。'),
          ...chains.map((chain) => {
            const id = chainId(chain)
            const renamingHere = renaming === id
            const confirmingHere = confirmingDelete === id
            const editingHere = editing === id
            return h('div', {
              key: id,
              style: { ...styles.chainRow, ...(chain.enabled ? {} : styles.chainRowOff) },
            }, [
              // No pick control here on purpose (m07714): 编辑 already says "show me
              // this one", so a radio would be a second lever for the same job and
              // only invite the question of how it differs from the enable box.
              renamingHere
                ? h('input', {
                  key: 'rename',
                  style: styles.renameInput,
                  defaultValue: chain.name,
                  placeholder: chain.primary,
                  autoFocus: true,
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') event.target.blur()
                    if (event.key === 'Escape') setRenaming(null)
                  },
                  onBlur: (event) => {
                    setRenaming(null)
                    const next = event.target.value
                    if (next.trim() === chain.name) return
                    editChain(id, (current) => setName(current, next))
                  },
                })
                : h('span', {
                  key: 'name',
                  style: { ...styles.chainFold, display: 'flex', alignItems: 'center', gap: '8px' },
                  title: '双击以重命名',
                  onDoubleClick: () => setRenaming(id),
                }, [
                  h('span', { key: 'n', style: styles.chainName }, chainTitle(chain)),
                  // The primary key is always shown; the title only repeats it when the
                  // chain has no name of its own, so that case shows it once.
                  chain.name === '' || chain.primary === ''
                    ? null
                    : h('span', { key: 'k', style: { ...styles.tagId, ...styles.chainKey }, title: chain.primary }, chain.primary),
                ]),
              h('span', { key: 'meta', style: styles.chainMeta },
                `${chain.candidates.length} 个候选 · 深度 ${chain.maxAttempts}`),
              h('span', { key: 'actions', style: styles.chainSpacer }, [
                h('label', { key: 'enable', style: { display: 'flex', alignItems: 'center', gap: '4px' } }, [
                  h('input', {
                    key: 'box',
                    type: 'checkbox',
                    checked: chain.enabled,
                    disabled: busy,
                    onChange: (event) => enableChain(id, event.target.checked),
                  }),
                  h('span', { key: 't', style: styles.tag }, '启用'),
                ]),
                h('button', {
                  key: 'edit',
                  style: busy ? styles.buttonDisabled : styles.button,
                  disabled: busy,
                  title: editingHere ? '收起这条链的编辑面板' : '编辑这条链的主模型与候选模型',
                  onClick: () => {
                    // One editor at a time: opening this chain closes whichever was
                    // open, so 编辑 always means "show me this one" rather than a
                    // toggle that could leave two open.
                    setEditing(editingHere ? null : id)
                  },
                }, editingHere ? '收起' : '编辑'),
                h('button', {
                  key: 'delete',
                  style: busy ? styles.buttonDisabled : styles.button,
                  disabled: busy,
                  title: confirmingHere ? '再点一次即可删除' : '删除这条回退链',
                  onClick: () => {
                    if (!confirmingHere) {
                      setConfirmingDelete(id)
                      return
                    }
                    setConfirmingDelete(null)
                    deleteChain(id)
                  },
                }, confirmingHere ? '确认删除' : '删除'),
              ]),
            ])
          }),
        ]))
      }

      // The "one chain per primary at a time" notice belongs between the roster (where
      // the enable box that caused it lives) and the editor. It is deliberately NOT
      // inside the editor: the chain that was just switched off may be a different one
      // from the one being edited, and the notice is about the roster as a whole.
      if (conflictNotice !== null) {
        children.push(h('div', { key: 'conflict', style: styles.conflictNotice }, [
          h('span', { key: 't' },
            `同一个主模型只能同时激活一条回退链，已自动停用另外 ${conflictNotice.count} 条（${conflictNotice.primary}）。`),
          h('button', {
            key: 'dismiss',
            type: 'button',
            style: styles.linkButton,
            title: '以后不再显示这条提示',
            onClick: () => {
              dismissConflict()
              setConflictNotice(null)
            },
          }, '不再提示'),
        ]))
      }

      // The palette is part of editing, not of the management list: it appears with the
      // editor so the page stays about the chains until 编辑 is pressed.
      if (editing !== null && active !== null && chainId(active) === editing) {
        children.push(palettePanel)
      }

      // --- chain editor (tasks 4.2/4.3/4.4/4.5/4.6/4.7) ---
      //
      // Only the chain being edited is on screen; the roster above says which one. The
      // primary model's identity lives on the palette panel (it is chosen there), so
      // this panel is about the candidates that back it up.
      if (editing !== null && active !== null && chainId(active) === editing) {
        const chain = active
        const chainKeyId = chainId(chain)
        const marks = availabilityOf(chain.candidates, catalogIndex)
        const candidatesFoldedHere = candidatesFolded !== null && candidatesFolded.has(chainKeyId)

        children.push(h('div', { key: chainKeyId, style: styles.panel }, [
          h('div', { key: 'head', style: styles.primaryRow }, [
            h('button', {
              key: 'fold-candidates',
              type: 'button',
              style: styles.foldButton,
              title: candidatesFoldedHere ? '展开候选模型' : '收起候选模型',
              onClick: () => toggleCandidates(chainKeyId),
            }, [
              h('span', { key: 'c', style: styles.groupCaret }, candidatesFoldedHere ? '▸' : '▾'),
              h('span', { key: 't' }, `候选模型（${marks.length}）`),
            ]),
          ]),

          // candidates — the drag scope is this chain only (task 4.2)
          candidatesFoldedHere ? null : h('div', { key: 'cands' },
            marks.length === 0
              ? h('div', { style: styles.muted }, '尚未添加候选模型')
              : marks.map((mark, index) => h('div', {
                key: mark.key,
                style: styles.row,
                draggable: true,
                onDragStart: () => setDrag({ id: chainKeyId, index }),
                onDragOver: (event) => event.preventDefault(),
                onDrop: () => {
                  // Drag scope is the chain the drag started on, by id: two chains can
                  // share one primary model, so the primary cannot tell them apart.
                  if (drag === null || drag.id !== chainKeyId) return
                  const next = reorder(chain.candidates, drag.index, index)
                  setDrag(null)
                  if (next === chain.candidates) return
                  editChain(chainKeyId, (current) => ({ ...current, candidates: next }))
                },
              }, [
                h('span', { key: 'grip', style: styles.tag }, '⠿'),
                h('span', {
                  key: 'name',
                  style: mark.available ? styles.candidate : styles.candidateUnavailable,
                  title: mark.reason ?? '',
                }, mark.available
                  ? [
                    h('span', { key: 't' }, titleOf({ name: mark.name, key: mark.key })),
                    mark.price.display === ''
                      ? null
                      : h('span', { key: 'p', style: mark.price.free ? styles.free : styles.numeric }, ` ${mark.price.display}`),
                    h('span', { key: 'k', style: styles.tagId }, ` ${mark.key}`),
                    h('span', { key: 'w', style: styles.tag }, ` ${windowLabel(mark.contextWindow)}`),
                  ]
                  : [
                    h('span', { key: 'k', style: styles.mono }, mark.key),
                    h('span', { key: 'r', style: styles.tag }, ` 不可用：${mark.reason}`),
                  ]),
                h('button', {
                  key: 'up',
                  style: index === 0 || busy ? styles.buttonDisabled : styles.button,
                  disabled: index === 0 || busy,
                  onClick: () => editChain(chainKeyId, (current) => ({
                    ...current, candidates: reorder(current.candidates, index, index - 1),
                  })),
                }, '↑'),
                h('button', {
                  key: 'down',
                  style: index === marks.length - 1 || busy ? styles.buttonDisabled : styles.button,
                  disabled: index === marks.length - 1 || busy,
                  onClick: () => editChain(chainKeyId, (current) => ({
                    ...current, candidates: reorder(current.candidates, index, index + 1),
                  })),
                }, '↓'),
                h('button', {
                  key: 'remove',
                  style: busy ? styles.buttonDisabled : styles.button,
                  disabled: busy,
                  onClick: () => editChain(chainKeyId, (current) => removeCandidate(current, mark.key)),
                }, '移除'),
              ]))),

          // Add/remove candidates from the filtered palette (task 4.3). The
          // checkbox IS the membership: ticking one adds it, unticking removes
          // it, so the list can never disagree with the chain it edits. Already
          // added candidates stay listed on purpose — otherwise there would be
          // nothing left to untick.
          h('div', { key: 'add', style: { marginTop: '8px' } }, [
            h('button', {
              key: 'toggle',
              style: styles.button,
              onClick: () => setExpanded(expanded === chainKeyId ? null : chainKeyId),
            }, expanded === chainKeyId ? '收起候选清单' : '添加候选（勾选即加入）'),
            expanded === chainKeyId
              ? h('div', {
                key: 'picker',
                ref: pickerRef,
                style: { ...styles.grid, maxHeight: '340px', overflowY: 'auto', marginTop: '6px' },
              },
                renderPicker((model, candidateKey) => h('input', {
                  key: 'pick',
                  type: 'checkbox',
                  name: 'model-fallback-candidate',
                  checked: chain.candidates.includes(candidateKey),
                  disabled: busy,
                  onChange: (event) => {
                    // Measure before the write: adding a candidate grows the list
                    // above this picker, which would otherwise slide it down the page.
                    rememberPicker()
                    editChain(chainKeyId, (current) => (event.target.checked
                      ? addCandidate(current, candidateKey)
                      : removeCandidate(current, candidateKey)))
                  },
                }), (model) => {
                  const candidateKey = typeof model.key === 'string' && model.key !== ''
                    ? model.key
                    : modelKey(model.provider, model.model)
                  return candidateKey !== chain.primary
                }, 200))
              : null,
          ]),

          // triggers + depth (task 4.5)
          h('div', { key: 'triggers', style: { marginTop: '10px' } }, [
            h('div', { key: 'label', style: styles.tag }, '触发条件'),
            ...TRIGGERS.map((trigger) => h('label', { key: trigger.kind, style: styles.label }, [
              h('input', {
                key: 'box',
                type: 'checkbox',
                checked: chain.triggers[trigger.kind] === true,
                disabled: busy,
                onChange: (event) => editChain(chainKeyId, (current) => setTrigger(current, trigger.kind, event.target.checked)),
              }),
              h('span', { key: 'text' }, [
                h('span', { key: 'l', style: { fontWeight: 600 } }, `${trigger.label}　`),
                h('span', { key: 'h', style: styles.muted }, trigger.help),
              ]),
            ])),
            h('label', { key: 'depth', style: styles.label }, [
              h('span', { key: 'text', style: { whiteSpace: 'nowrap' } }, '尝试深度：'),
              h('input', {
                key: 'input',
                type: 'number',
                min: 1,
                style: { ...styles.input, flex: '0 0 auto', width: '70px' },
                value: chain.maxAttempts,
                disabled: busy,
                onChange: (event) => editChain(chainKeyId, (current) => setDepth(current, event.target.value)),
              }),
              h('span', { key: 'help', style: styles.muted }, `　${DEPTH_HELP}`),
            ]),
          ]),
        ]))
      }

      // --- cooldowns (task 6.4) ---
      children.push(h('div', { key: 'cooldowns', style: styles.panel }, [
        h('div', { key: 'title', style: styles.primaryRow }, [
          h('span', { key: 't' }, `冷却中的模型（${cooldowns.length}）`),
          cooldowns.length === 0 ? null : h('button', {
            key: 'clear-all', style: styles.button, onClick: () => void clearAllCooldowns(),
          }, '全部清除'),
        ]),
        h('p', { key: 'hint', style: styles.hint },
          '失败的模型会短暂进入冷却，冷却期内不会被改派选中。冷却不影响你直接使用该模型。'),
        cooldowns.length === 0
          ? h('div', { key: 'empty', style: styles.muted }, '当前没有模型处于冷却中')
          : cooldowns.map((entry) => h('div', { key: entry.key, style: styles.row }, [
            h('span', { key: 'k', style: styles.mono }, entry.key),
            h('span', { key: 's', style: styles.tag }, `进入时间 ${new Date(entry.startedAt).toLocaleTimeString()}`),
            h('span', { key: 'u', style: styles.tag }, `预计恢复 ${new Date(entry.until).toLocaleTimeString()}`),
            h('span', { key: 'r', style: styles.tag }, `原因 ${entry.reason || '未分类'}`),
            h('button', { key: 'c', style: styles.button, onClick: () => void clearCooldown(entry.key) }, '清除'),
          ])),
      ]))

      // --- recent failovers ---
      children.push(h('div', { key: 'history', style: styles.panel }, [
        h('div', { key: 'title', style: styles.primaryRow }, `最近改派记录（${history.length}）`),
        history.length === 0
          ? h('div', { key: 'empty', style: styles.muted }, '尚未发生改派')
          : history.slice(-10).reverse().map((record, index) => h('div', {
            key: `${record.turn}:${record.step}:${index}`, style: styles.row,
          }, [
            h('span', { key: 'k', style: styles.mono }, `${record.from} → ${record.to ?? '（无可用候选）'}`),
            h('span', { key: 't', style: styles.tag }, record.trigger ?? '未分类'),
            h('span', { key: 'r', style: styles.tag }, record.reason ?? ''),
          ])),
      ]))

      return h('div', { style: styles.page }, children)
    }

    const plugin = {
      name: 'model-fallback',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'model-fallback',
          order: 40,
          label: () => '模型回退链',
        }, FallbackSettingsPage))
      },
      // Exposed for the render smoke test (task 1.5) so it drives the real code.
      _internals: {
        API_BASE,
        resolveApiBase,
        normalizeChain,
        filterModels,
        priceOf,
        titleOf,
        comparePrice,
        compareWindow,
        windowValueOf,
        sortModels,
        SORT_KEYS,
        groupModels,
        reorder,
        addCandidate,
        removeCandidate,
        createChain,
        setPrimary,
        chainId,
        nextChainName,
        setName,
        setEnabled,
        chainTitle,
        setTrigger,
        setDepth,
        availabilityOf,
        windowLabel,
        windowTitle,
        // Scroll anchoring is arithmetic over the DOM, so the smoke test drives it
        // with a fake element chain rather than a browser.
        keepAnchored,
        scrollableAncestors,
        scrollsOverflow,
        TRIGGERS,
        styles,
        FallbackSettingsPage,
      },
    }
    return plugin
  },
})
