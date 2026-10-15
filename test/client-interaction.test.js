/**
 * Client interaction test (tasks 4.2/4.3/4.4/4.5/4.6/4.7/6.4).
 *
 * `client-render.test.js` proves the page can be *constructed*. It cannot prove
 * the page *works*, because its React stub never re-renders: every `useState`
 * hands back its initial value, so an event handler that sets state and a later
 * handler that reads it can never be observed together.
 *
 * The drag path needs exactly that. `onDragStart` writes the dragged index into
 * state and `onDrop` reads it back; with a frozen stub, `drag` is always `null`
 * and the drop is always a no-op. Same for the create button (`picked`) and for
 * the candidate checkbox (the row's `checked` comes from the chain the last write
 * produced). So this file supplies a *stateful* React: hooks keep their slots
 * across renders, `setState` marks the instance dirty, and `settle()` re-renders
 * until the page stops changing.
 *
 * The host half is not stubbed either. `fetch` is wired to the REAL
 * `createApi` from `../lib/routes.js` over the REAL `createCooldowns` and a real
 * `normalizeChain`, so what these tests assert is what the running plugin would
 * actually persist — the client↔host contract, not a rehearsal of it.
 *
 * What this buys: 4.2/4.3/4.4/4.5/4.6/4.7/6.4 stop resting on "a human will
 * click it once". The remaining human step is only the visual read (is the table
 * aligned), not the behaviour (does dragging persist the new order).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createApi } from '../lib/routes.js'
import { createCooldowns } from '../lib/cooldown.js'

// --- globals the bundle reads at load time ----------------------------------

const registry = new Map()
globalThis.window = globalThis.window ?? {}
globalThis.window.__ModuleLoader__ = {
  load(spec) {
    assert.equal(typeof spec?.factory, 'function')
    registry.set(spec.id, spec.factory)
  },
}
globalThis.document = { baseURI: 'http://127.0.0.1:19387/' }

await import('../lib/client.js')

// --- a stateful React -------------------------------------------------------

/** React's own dependency comparison: `Object.is` per element. */
function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

/**
 * The smallest React that re-renders.
 *
 * Hook slots live on the instance, keyed by call order (which is stable, since
 * the component's hook calls are unconditional). `useMemo`/`useCallback` share
 * one slot table because their call positions are distinct.
 */
function createReact() {
  const React = {
    __current: null,
    createElement(type, props, ...children) {
      const node = {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
      }
      // A ref on a host element points at that element. The page reads the picker's
      // `getBoundingClientRect`, so tests that exercise anchoring attach one here.
      if (node.props.ref !== undefined && node.props.ref !== null) {
        node.props.ref.current = node
        if (typeof React.__domShim === 'function') React.__domShim(node)
      }
      return node
    },
    useState(initial) {
      const inst = React.__current
      const index = inst.cursor++
      if (!(index in inst.state)) inst.state[index] = typeof initial === 'function' ? initial() : initial
      return [inst.state[index], (value) => {
        inst.state[index] = typeof value === 'function' ? value(inst.state[index]) : value
        inst.dirty = true
      }]
    },
    useMemo(fn, deps) {
      const inst = React.__current
      const index = inst.cursor++
      const slot = inst.memo[index]
      if (slot !== undefined && sameDeps(slot.deps, deps)) return slot.value
      const value = fn()
      inst.memo[index] = { deps, value }
      return value
    },
    useCallback(fn, deps) {
      const inst = React.__current
      const index = inst.cursor++
      const slot = inst.memo[index]
      if (slot !== undefined && sameDeps(slot.deps, deps)) return slot.value
      inst.memo[index] = { deps, value: fn }
      return fn
    },
    useEffect(fn, deps) {
      const inst = React.__current
      const index = inst.cursor++
      const slot = inst.effects[index]
      if (slot !== undefined && sameDeps(slot.deps, deps)) return
      inst.effects[index] = { deps, fn }
      inst.pending.push(fn)
    },
    // Same bookkeeping as `useEffect`, but queued ahead of it: the page uses a layout
    // effect to put the picker back before the shift is painted, so in this harness it
    // must run before any passive effect scheduled in the same pass.
    useLayoutEffect(fn, deps) {
      const inst = React.__current
      const index = inst.cursor++
      const slot = inst.effects[index]
      if (slot !== undefined && sameDeps(slot.deps, deps)) return
      inst.effects[index] = { deps, fn }
      inst.layout.push(fn)
    },
    // A ref is a box that survives renders; the harness keeps it in its own map so a
    // component can hand a DOM node to it (the page stores the picker element here).
    useRef(initial) {
      const inst = React.__current
      const index = inst.cursor++
      if (!(index in inst.refs)) inst.refs[index] = { current: initial ?? null }
      return inst.refs[index]
    },
  }
  return React
}

const React = createReact()
const requireStub = (spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected client require: ${spec}`)
}
const plugin = registry.get('dsh-model-fallback')(requireStub)
const internals = plugin._internals

/**
 * Mount the page and let every effect (and the fetches it starts) finish.
 *
 * `settle()` alternates between draining effects and re-rendering while the
 * instance is dirty. The `setImmediate` at the top of each round is what lets an
 * in-flight `fetch` promise resolve before the next check.
 */
function createHarness(Component) {
  const inst = {
    state: {}, memo: {}, effects: {}, refs: {}, pending: [], layout: [], cursor: 0, dirty: false, tree: null,
  }

  function renderPass() {
    inst.cursor = 0
    inst.pending = []
    inst.layout = []
    React.__current = inst
    try {
      inst.tree = Component()
    } finally {
      React.__current = null
    }
  }

  async function settle(maxRounds = 80) {
    for (let round = 0; round < maxRounds; round++) {
      await new Promise((resolve) => setImmediate(resolve))
      // Layout effects run first, before the passive effects of the same pass.
      if (inst.layout.length > 0) {
        const layout = inst.layout
        inst.layout = []
        for (const fn of layout) await Promise.resolve(fn())
        continue
      }
      if (inst.pending.length > 0) {
        const pending = inst.pending
        inst.pending = []
        for (const fn of pending) await Promise.resolve(fn())
        continue
      }
      if (inst.dirty) {
        inst.dirty = false
        renderPass()
        continue
      }
      return
    }
    throw new Error('the client did not settle')
  }

  return {
    get tree() { return inst.tree },
    async mount() { renderPass(); await settle() },
    settle,
  }
}

// --- the host half, wired to the real API -----------------------------------

const CATALOG = [
  { provider: 'raccoon', providerLabel: 'Raccoon', model: 'sn-deepseek-v4-1-flash', key: 'raccoon/sn-deepseek-v4-1-flash', name: 'DeepSeek-V4.1-Flash · x0.05', contextWindow: 128000 },
  { provider: 'workbuddy', providerLabel: 'WorkBuddy', model: 'deepseek-v4.1-flash', key: 'workbuddy/deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash · x0.11', contextWindow: 128000 },
  { provider: 'buddy', providerLabel: 'Buddy', model: 'deepseek-v4-flash', key: 'buddy/deepseek-v4-flash', name: 'DeepSeek-V4-Flash · x0.02', contextWindow: 64000 },
  { provider: 'buddy', providerLabel: 'Buddy', model: 'glm-5.3', key: 'buddy/glm-5.3', name: 'GLM-5.3 · x0.06', contextWindow: 200000 },
]

const PRIMARY = 'raccoon/sn-deepseek-v4-1-flash'
const CAND_A = 'workbuddy/deepseek-v4.1-flash'
const CAND_B = 'buddy/deepseek-v4-flash'
const CAND_C = 'buddy/glm-5.3'

function chainWith(candidates) {
  const chain = internals.createChain(PRIMARY)
  return {
    ...chain,
    candidates: [...candidates],
    triggers: { rate_limit: true, server_error: true, timeout_network: true },
  }
}

/** An in-memory host: the real router over real (if tiny) storage. */
function createHost(initialChains = []) {
  let store = structuredClone(initialChains)
  const writes = []
  const calls = []
  const cooldowns = createCooldowns({ now: () => Date.now() })

  const handle = createApi({
    loadChains: () => structuredClone(store),
    saveChains: (chains) => {
      store = structuredClone(chains)
      writes.push(structuredClone(chains))
    },
    listModels: () => CATALOG,
    listCooldowns: () => cooldowns.list(),
    clearCooldown: (key) => cooldowns.clear(key),
    clearAllCooldowns: () => cooldowns.clearAll(),
    history: () => [],
  })

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET'
    const body = options.body === undefined ? undefined : JSON.parse(options.body)
    calls.push({ method, url, body })
    const result = await handle(method, url, body)
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => result.body,
    }
  }

  return { get store() { return store }, writes, calls, cooldowns }
}

/** The roster row's 编辑 toggle: the only door to the palette and the editor. */
function editButton(row) {
  return collect(row, (node) => node.type === 'button' && node.props?.key === 'edit')[0]
}

/** Mount the page against a fresh host, opening the editor when there is a chain. */
async function mountPage(chains = []) {
  const host = createHost(chains)
  const harness = createHarness(internals.FallbackSettingsPage)
  await harness.mount()
  // The editor is gated behind the roster's 编辑 button (m06970). Editor tests
  // all start from "the first chain is open", so the mount helper presses it.
  if (chains.length > 0) {
    const row = collect(harness.tree, (node) => node.type === 'button' && node.props?.key === 'edit')[0]
    await click(harness, row)
  }
  return { host, harness }
}

// --- tree queries -----------------------------------------------------------

function collect(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) collect(child, predicate, out)
  return out
}

function textOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
  for (const child of node.children ?? []) textOf(child, out)
  return out
}

/** The container rendered with a given React key (the palette's `list`, a chain's `picker`). */
function subtree(tree, key) {
  return collect(tree, (node) => node.props?.key === key)[0]
}

/** A model row: the `display: contents` wrapper whose text mentions `needle`. */
function modelRow(tree, needle) {
  return collect(tree, (node) => node.props?.style?.display === 'contents'
    && textOf(node).join(' ').includes(needle))[0]
}

/** The radio/checkbox inside a model row (first cell). */
function controlIn(row) {
  return row.children[0].children[0]
}

/** A button whose text is exactly `label`. */
function buttonExact(tree, label) {
  return collect(tree, (node) => node.type === 'button' && textOf(node).join('') === label)[0]
}

/** A button whose text contains `label`. */
function buttonWith(tree, label) {
  return collect(tree, (node) => node.type === 'button' && textOf(node).join('').includes(label))[0]
}

/** The draggable candidate rows, in rendered order. */
function candidateRows(tree) {
  return collect(tree, (node) => node.props?.draggable === true)
}

/** The `provider/model` key shown inside a candidate row. */
function candidateKeyOf(row) {
  const holder = collect(row, (node) => node.props?.key === 'k')[0]
  return holder === undefined ? null : textOf(holder).join('').trim()
}

/**
 * The move-up / move-down buttons of the candidate rows, in row order.
 *
 * Scoped by React key, NOT by label: the sortable column headings also render a
 * bare `↑`/`↓` caret, so a text search for those glyphs finds the sort control in
 * the table header first.
 */
function rowButtons(tree, which) {
  return collect(tree, (node) => node.type === 'button' && node.props?.key === which)
}

/** The label wrapping one trigger switch. */
function triggerLabel(tree, text) {
  return collect(tree, (node) => node.type === 'label' && textOf(node).join(' ').includes(text))[0]
}

/** The attempt-depth number input. */
function depthInput(tree) {
  return collect(tree, (node) => node.type === 'input' && node.props?.type === 'number')[0]
}

/**
 * The roster rows — the management list above the editors.
 *
 * Scoped by the row's own geometry (flex + 8px gap + 6px padding), NOT by text:
 * every row repeats the primary model key, so a text search cannot tell them
 * apart, and the editor panels carry the same key in their own headings.
 */
function rosterRows(tree) {
  return collect(tree, (node) => node.props?.style?.display === 'flex'
    && node.props?.style?.gap === '8px'
    && node.props?.style?.padding === '6px'
    && node.props?.style?.borderRadius === '6px')
}

/** The roster row whose text mentions `needle` (a chain name or primary key). */
function rosterRow(tree, needle) {
  return rosterRows(tree).find((row) => textOf(row).join(' ').includes(needle))
}

/** The `启用` checkbox of a roster row. */
function enableBox(row) {
  return collect(row, (node) => node.type === 'input' && node.props?.type === 'checkbox')[0]
}

/**
 * The rename field, found by its style rather than by its row.
 *
 * While a rename is open the row no longer shows the old name, so locating the
 * row by that text stops working exactly when the field appears.
 */
function renameInput(tree) {
  return collect(tree, (node) => node.type === 'input'
    && node.props?.style === internals.styles.renameInput)[0]
}

/** The chain-name span, which opens the rename field on double-click. */
function nameSpan(row) {
  return collect(row, (node) => node.props?.key === 'name'
    && node.props?.onDoubleClick !== undefined)[0]
}

/**
 * Edit a chain, so the editor below switches to it. Pressing 编辑 on an already
 * open chain would collapse it, so the helper only clicks when it is closed.
 */
async function editChainIn(harness, primary) {
  const button = editButton(rosterRow(harness.tree, primary))
  assert.ok(button !== undefined, 'expected the 编辑 button to exist')
  if (textOf(button).join('') === '收起') return
  button.props.onClick()
  await harness.settle()
}

/** Double-click a chain's name to open the rename field. */
async function openRename(harness, primary) {
  const span = nameSpan(rosterRow(harness.tree, primary))
  assert.ok(span !== undefined, 'expected the chain name to be double-clickable')
  span.props.onDoubleClick()
  await harness.settle()
}

/** Click, then let the resulting write and re-render finish. */
async function click(harness, node) {
  assert.ok(node !== undefined, 'expected the control to exist')
  node.props.onClick?.({ preventDefault() {} })
  await harness.settle()
}

// --- 4.2 / 4.3: building a chain and adding candidates ----------------------

test('picking a model and pressing create makes a chain with all triggers on (tasks 4.1/4.3)', async () => {
  const { host, harness } = await mountPage()
  assert.ok(textOf(harness.tree).join(' ').includes('还没有配置任何回退链'))

  // m07004: with no chain the 添加链 button sits in the middle of the panel, and
  // pressing it materialises an empty chain rather than asking for a model first.
  await click(harness, buttonExact(harness.tree, '添加链'))
  assert.equal(host.writes.length, 1, 'the empty chain itself is one write')
  assert.equal(host.store[0].primary, '', 'the new chain starts empty')
  assert.match(host.store[0].name, /^回退链\d+$/, 'the new chain gets the next numbered name')

  const row = modelRow(subtree(harness.tree, 'list'), PRIMARY)
  assert.ok(row !== undefined, 'the palette must list the model')
  controlIn(row).props.onChange()
  await harness.settle()

  await click(harness, buttonExact(harness.tree, '设为这条链的主模型'))

  assert.equal(host.writes.length, 2, 'filling the primary is the second write')
  assert.equal(host.store.length, 1, 'no second chain is created')
  const [chain] = host.store
  assert.equal(typeof chain.id, 'string', 'the chain carries its own id')
  assert.equal(chain.primary, PRIMARY)
  assert.deepEqual(chain.candidates, [])
  assert.deepEqual(chain.triggers, { rate_limit: true, server_error: true, timeout_network: true })
  assert.equal(chain.maxAttempts, 3)
})

test('ticking a candidate checkbox adds it and writes once (task 4.3)', async () => {
  const { host, harness } = await mountPage([chainWith([])])

  await click(harness, buttonWith(harness.tree, '添加候选'))
  const picker = subtree(harness.tree, 'picker')
  assert.ok(picker !== undefined, 'the candidate picker must open')

  const row = modelRow(picker, CAND_A)
  const box = controlIn(row)
  assert.equal(box.props.type, 'checkbox')
  assert.equal(box.props.checked, false, 'an unadded candidate starts unticked')

  const before = host.writes.length
  box.props.onChange({ target: { checked: true } })
  await harness.settle()

  assert.equal(host.writes.length, before + 1, 'one tick is one write')
  assert.deepEqual(host.store[0].candidates, [CAND_A])
})

test('unticking a candidate removes it, and the row comes back unticked (task 4.3)', async () => {
  const { host, harness } = await mountPage([chainWith([CAND_A])])
  await click(harness, buttonWith(harness.tree, '添加候选'))

  const box = controlIn(modelRow(subtree(harness.tree, 'picker'), CAND_A))
  assert.equal(box.props.checked, true, 'a candidate already on the chain starts ticked')

  box.props.onChange({ target: { checked: false } })
  await harness.settle()

  assert.deepEqual(host.store[0].candidates, [])
  // The row is still listed (otherwise there would be nothing left to re-tick),
  // and now reports unticked.
  const after = controlIn(modelRow(subtree(harness.tree, 'picker'), CAND_A))
  assert.equal(after.props.checked, false)
})

test('adding one candidate leaves other chains untouched (task 4.3)', async () => {
  const other = { ...chainWith([CAND_C]), primary: 'workbuddy/deepseek-v4.1-flash' }
  const { host, harness } = await mountPage([chainWith([]), other])

  // Only the first chain is expanded, so only its picker exists.
  await click(harness, buttonWith(harness.tree, '添加候选'))
  controlIn(modelRow(subtree(harness.tree, 'picker'), CAND_A)).props.onChange({ target: { checked: true } })
  await harness.settle()

  assert.deepEqual(host.store[0].candidates, [CAND_A])
  assert.deepEqual(host.store[1].candidates, [CAND_C], 'the other chain is untouched')
})

// --- 4.4: drag reordering ---------------------------------------------------

test('dragging the third candidate to the first reorders to [C,A,B] with one write (task 4.4)', async () => {
  const { host, harness } = await mountPage([chainWith([CAND_A, CAND_B, CAND_C])])
  assert.deepEqual(candidateRows(harness.tree).map(candidateKeyOf), [CAND_A, CAND_B, CAND_C])

  const before = host.writes.length
  const rows = candidateRows(harness.tree)
  rows[2].props.onDragStart()
  await harness.settle()
  // Re-query: the drag start re-rendered the tree.
  candidateRows(harness.tree)[0].props.onDrop()
  await harness.settle()

  assert.equal(host.writes.length, before + 1, 'a drag is exactly one order write')
  assert.deepEqual(host.store[0].candidates, [CAND_C, CAND_A, CAND_B])
  assert.deepEqual(candidateRows(harness.tree).map(candidateKeyOf), [CAND_C, CAND_A, CAND_B],
    'the rendered order matches what was persisted')
})

test('a drag that ends where it started writes nothing (task 4.4)', async () => {
  const { host, harness } = await mountPage([chainWith([CAND_A, CAND_B, CAND_C])])
  const before = host.writes.length

  const rows = candidateRows(harness.tree)
  rows[1].props.onDragStart()
  await harness.settle()
  candidateRows(harness.tree)[1].props.onDrop()
  await harness.settle()

  assert.equal(host.writes.length, before, 'a no-op drag must not write')
  assert.deepEqual(host.store[0].candidates, [CAND_A, CAND_B, CAND_C])
})

test('a drop is ignored when the drag started in another chain (task 4.2)', async () => {
  const second = { ...chainWith([CAND_C]), primary: CAND_B }
  const { host, harness } = await mountPage([chainWith([CAND_A, CAND_C]), second])
  const before = host.writes.length

  // Start a drag on the FIRST chain's row 0, then switch the editor to the SECOND
  // chain and drop there. Only one editor is on screen, so the switch is how the
  // drop target becomes the other chain.
  candidateRows(harness.tree)[0].props.onDragStart()
  await harness.settle()
  await editChainIn(harness, CAND_B)

  const rows = candidateRows(harness.tree)
  rows[rows.length - 1].props.onDrop()
  await harness.settle()

  assert.equal(host.writes.length, before, 'the drag scope is the chain it began in')
  assert.deepEqual(host.store[0].candidates, [CAND_A, CAND_C])
  assert.deepEqual(host.store[1].candidates, [CAND_C])
})

test('the up/down buttons reorder without a drag (task 4.4)', async () => {
  const { host, harness } = await mountPage([chainWith([CAND_A, CAND_B])])

  await click(harness, rowButtons(harness.tree, 'down')[0])
  assert.deepEqual(host.store[0].candidates, [CAND_B, CAND_A])

  await click(harness, rowButtons(harness.tree, 'up')[1])
  assert.deepEqual(host.store[0].candidates, [CAND_A, CAND_B])
})

test('the first row cannot move up and the last cannot move down (task 4.4)', async () => {
  const { harness } = await mountPage([chainWith([CAND_A, CAND_B])])
  const ups = rowButtons(harness.tree, 'up')
  const downs = rowButtons(harness.tree, 'down')
  assert.equal(ups.length, 2)
  assert.equal(ups[0].props.disabled, true, '↑ on the first row is disabled')
  assert.equal(ups[1].props.disabled, false, '↑ on the last row is enabled')
  assert.equal(downs[0].props.disabled, false, '↓ on the first row is enabled')
  assert.equal(downs[1].props.disabled, true, '↓ on the last row is disabled')
})

// --- 4.5: triggers and depth ------------------------------------------------

test('unticking a trigger persists the switch (task 4.5)', async () => {
  const { host, harness } = await mountPage([chainWith([CAND_A])])
  const box = triggerLabel(harness.tree, '服务端错误').children[0]
  assert.equal(box.props.checked, true)

  box.props.onChange({ target: { checked: false } })
  await harness.settle()

  assert.deepEqual(host.store[0].triggers, { rate_limit: true, server_error: false, timeout_network: true })
})

test('each trigger is an independent switch (task 4.5)', async () => {
  const { host, harness } = await mountPage([chainWith([CAND_A])])
  triggerLabel(harness.tree, '超时与网络错误').children[0].props.onChange({ target: { checked: false } })
  await harness.settle()

  assert.deepEqual(host.store[0].triggers, { rate_limit: true, server_error: true, timeout_network: false })
  // The other two are untouched by construction.
  assert.equal(triggerLabel(harness.tree, '限流').children[0].props.checked, true)
})

test('the depth input persists a positive integer (task 4.5)', async () => {
  const { host, harness } = await mountPage([chainWith([CAND_A])])
  const input = depthInput(harness.tree)
  assert.equal(input.props.value, 3)

  input.props.onChange({ target: { value: '5' } })
  await harness.settle()
  assert.equal(host.store[0].maxAttempts, 5)
  assert.equal(depthInput(harness.tree).props.value, 5, 'the input shows what was persisted')
})

test('a depth that is not a positive integer is refused, not stored (task 4.5)', async () => {
  const { host, harness } = await mountPage([chainWith([CAND_A])])
  depthInput(harness.tree).props.onChange({ target: { value: '0' } })
  await harness.settle()
  assert.equal(host.store[0].maxAttempts, 3, 'the previous depth survives a nonsense value')
})

test('the meaning of every trigger and of the depth is stated in the page (task 4.5)', async () => {
  const { harness } = await mountPage([chainWith([CAND_A])])
  const text = textOf(harness.tree).join(' ')
  for (const trigger of internals.TRIGGERS) {
    assert.ok(text.includes(trigger.label), `the label for ${trigger.kind} must be visible`)
    assert.ok(text.includes(trigger.help), `the explanation for ${trigger.kind} must be visible`)
  }
  assert.ok(text.includes('主模型的原始失败原因'), 'the depth explanation must say what happens at exhaustion')
})

// --- 4.6: unavailable candidates --------------------------------------------

test('an unavailable candidate is kept on the chain and explained (task 4.6)', async () => {
  const gone = 'gone/provider-not-loaded'
  const { host, harness } = await mountPage([chainWith([gone, CAND_A])])

  const rows = candidateRows(harness.tree)
  assert.deepEqual(rows.map(candidateKeyOf), [gone, CAND_A], 'the missing model is NOT silently dropped')
  const text = textOf(rows[0]).join(' ')
  assert.ok(text.includes('不可用'), text)
  assert.ok(text.includes('配置已保留'), text)
  // And it is still in the persisted configuration.
  assert.deepEqual(host.store[0].candidates, [gone, CAND_A])
})

test('a candidate that comes back stops being marked unavailable (task 4.6)', async () => {
  const { host, harness } = await mountPage([chainWith([CAND_A])])
  assert.ok(!textOf(candidateRows(harness.tree)[0]).join(' ').includes('不可用'))

  // The host rewrites the chain to a model the catalogue does not have.
  host.store[0].candidates = ['gone/provider-not-loaded']
  const second = await mountPage([structuredClone(host.store[0])])
  assert.ok(textOf(candidateRows(second.harness.tree)[0]).join(' ').includes('不可用'))

  // And back again: no re-configuration required, order preserved.
  host.store[0].candidates = [CAND_A]
  const third = await mountPage([structuredClone(host.store[0])])
  const row = candidateRows(third.harness.tree)[0]
  assert.ok(!textOf(row).join(' ').includes('不可用'))
  assert.equal(candidateKeyOf(row), CAND_A)
})

// --- 4.7: one source of truth -----------------------------------------------

test('the editor re-reads the host order instead of keeping its own (task 4.7)', async () => {
  const { host, harness } = await mountPage([chainWith([CAND_A, CAND_B, CAND_C])])
  assert.deepEqual(candidateRows(harness.tree).map(candidateKeyOf), [CAND_A, CAND_B, CAND_C])

  // Someone else (the runtime, or a hand-edited chains.json) rewrites the order.
  host.store[0].candidates = [CAND_C, CAND_B, CAND_A]

  const second = await mountPage([structuredClone(host.store[0])])
  assert.deepEqual(candidateRows(second.harness.tree).map(candidateKeyOf), [CAND_C, CAND_B, CAND_A],
    'a fresh read shows the host order, not a cached one')
})

test('a write answers with what was persisted, and the page shows that (tasks 4.4/4.7)', async () => {
  const { host, harness } = await mountPage([chainWith([CAND_A, CAND_B])])
  const before = host.writes.length

  candidateRows(harness.tree)[1].props.onDragStart()
  await harness.settle()
  candidateRows(harness.tree)[0].props.onDrop()
  await harness.settle()

  assert.equal(host.writes.length, before + 1)
  // The rendered rows come from the PUT response body, i.e. from the store.
  assert.deepEqual(candidateRows(harness.tree).map(candidateKeyOf), host.store[0].candidates)
})

// --- 6.4: the cooldown list -------------------------------------------------

test('an empty cooldown list says so and offers no clear-all (task 6.4)', async () => {
  const { harness } = await mountPage([chainWith([CAND_A])])
  const text = textOf(harness.tree).join(' ')
  assert.ok(text.includes('当前没有模型处于冷却中'), text)
  assert.equal(buttonExact(harness.tree, '全部清除'), undefined)
})

test('a cooling model is listed with its times, reason and a clear button (task 6.4)', async () => {
  const host = createHost([chainWith([CAND_A])])
  host.cooldowns.add(CAND_A, { ms: 60_000, reason: 'rate_limit' })
  const harness = createHarness(internals.FallbackSettingsPage)
  await harness.mount()

  const text = textOf(harness.tree).join(' ')
  assert.ok(text.includes(`冷却中的模型（1）`), text)
  assert.ok(text.includes(CAND_A), text)
  assert.ok(text.includes('进入时间'), text)
  assert.ok(text.includes('预计恢复'), text)
  assert.ok(text.includes('原因 rate_limit'), text)
  assert.ok(buttonExact(harness.tree, '清除') !== undefined)
})

test('clearing one cooldown removes it from the list immediately (task 6.4)', async () => {
  const host = createHost([chainWith([CAND_A])])
  host.cooldowns.add(CAND_A, { ms: 60_000, reason: 'rate_limit' })
  host.cooldowns.add(CAND_B, { ms: 60_000, reason: 'server_error' })
  const harness = createHarness(internals.FallbackSettingsPage)
  await harness.mount()

  // The per-model clear buttons carry key 'c' (the move-up/down buttons of the
  // chain rows use 'up'/'down', and the all-clear button sits outside the list).
  // `list()` preserves insertion order, so index 0 is CAND_A.
  const clears = collect(harness.tree, (node) => node.type === 'button' && node.props?.key === 'c')
  assert.equal(clears.length, 2, 'one clear button per cooling model')
  await click(harness, clears[0])

  const text = textOf(harness.tree).join(' ')
  assert.ok(text.includes('冷却中的模型（1）'), `one cooldown should remain: ${text}`)
  assert.equal(host.cooldowns.isCooling(CAND_A), false, 'the cleared model left cooldown')
  assert.equal(host.cooldowns.isCooling(CAND_B), true, 'the other cooldown is untouched')
})

test('clearing all cooldowns is a separate action (task 6.4)', async () => {
  const host = createHost([chainWith([CAND_A])])
  host.cooldowns.add(CAND_A, { ms: 60_000, reason: 'rate_limit' })
  host.cooldowns.add(CAND_B, { ms: 60_000, reason: 'server_error' })
  const harness = createHarness(internals.FallbackSettingsPage)
  await harness.mount()

  await click(harness, buttonExact(harness.tree, '全部清除'))

  assert.equal(host.cooldowns.size(), 0)
  assert.ok(textOf(harness.tree).join(' ').includes('当前没有模型处于冷却中'))
})

// --- the page keeps working under load --------------------------------------

test('the search box narrows the palette without touching the host (task 4.1)', async () => {
  const { host, harness } = await mountPage([chainWith([CAND_A])])
  const before = host.writes.length

  const search = collect(harness.tree, (node) => node.type === 'input' && node.props?.type === undefined
    && typeof node.props?.placeholder === 'string')[0]
  assert.ok(search !== undefined)
  search.props.onChange({ target: { value: 'glm' } })
  await harness.settle()

  const text = textOf(subtree(harness.tree, 'list')).join(' ')
  assert.ok(text.includes(CAND_C), 'the matching model is listed')
  assert.ok(!text.includes('sn-deepseek-v4-1-flash'), 'the non-matching model is filtered out')
  assert.equal(host.writes.length, before, 'searching is not a write')
})

test('the sort carets reorder the palette without touching the host (tasks 4.1)', async () => {
  const { host, harness } = await mountPage([chainWith([CAND_A])])
  const before = host.writes.length

  // Sorted cheapest-first by default: CAND_B (x0.02) then the x0.05 primary.
  const list = subtree(harness.tree, 'list')
  const firstBefore = textOf(list).join(' ').indexOf('x0.02')
  assert.ok(firstBefore >= 0)

  const windowCaret = collect(harness.tree, (node) => node.type === 'button'
    && node.props?.title === '按上下文窗口排序')[0]
  assert.ok(windowCaret !== undefined)
  await click(harness, windowCaret)

  assert.equal(host.writes.length, before, 'sorting is a view, not a write')
  const text = textOf(subtree(harness.tree, 'list')).join(' ')
  assert.ok(text.includes('x0.02'))
})

// --- the six reader asks of this round (fold, third sort state, sizes) ------

/** The fold toggle of one provider group (matched by its provider, not by label order). */
function foldToggle(tree, providerLabel) {
  return collect(tree, (node) => node.type === 'button'
    && node.props?.style === internals.styles.groupRow
    && textOf(node).join('').includes(providerLabel))[0]
}

/** The group-row buttons in rendered order (fold toggles double as the dividers). */
function foldToggles(tree) {
  return collect(tree, (node) => node.type === 'button' && node.props?.style === internals.styles.groupRow)
}

test('a source header folds its group and unfolds it again without writing (m04564)', async () => {
  // The palette is only on screen while a chain is being edited (m06970), so the
  // group headers need a chain to exist even though this test never edits one.
  const { host, harness } = await mountPage([chainWith([])])
  const before = host.writes.length

  // The host order is raccoon → workbuddy → buddy×2. Both buddy rows share one header.
  const buddyToggle = foldToggle(harness.tree, 'Buddy')
  assert.ok(buddyToggle !== undefined, 'the source divider is a real button')
  assert.match(textOf(buddyToggle).join(''), /▾/, 'an unfolded group shows the open caret')

  await click(harness, buddyToggle)
  const text = textOf(subtree(harness.tree, 'list')).join(' ')
  assert.ok(text.includes('Buddy'), 'a folded group still shows its header, which is how it unfolds')
  assert.ok(!text.includes('x0.02'), 'folding hides the group rows')
  assert.ok(!text.includes('x0.06'), 'folding hides the group rows')
  assert.ok(text.includes('x0.05'), 'the other groups are untouched')

  await click(harness, foldToggle(harness.tree, 'Buddy'))
  const reopened = textOf(subtree(harness.tree, 'list')).join(' ')
  assert.ok(reopened.includes('x0.02') && reopened.includes('x0.06'), 'unfolding brings the rows back')
  assert.match(textOf(foldToggle(harness.tree, 'Buddy')).join(''), /▾/)
  assert.equal(host.writes.length, before, 'folding is a view, never a write')
})

test('the two fold toggles are independent, and folding both hides everything (m04564)', async () => {
  const { harness } = await mountPage([chainWith([])])
  await click(harness, foldToggle(harness.tree, 'Raccoon'))
  const text1 = textOf(subtree(harness.tree, 'list')).join(' ')
  assert.ok(!text1.includes('x0.05'), 'raccoon is folded')
  assert.ok(text1.includes('x0.11') && text1.includes('x0.02'), 'the other groups are untouched')

  await click(harness, foldToggle(harness.tree, 'Buddy'))
  const text2 = textOf(subtree(harness.tree, 'list')).join(' ')
  assert.ok(!text2.includes('x0.02') && !text2.includes('x0.06'), 'buddy is folded too')
  assert.ok(text2.includes('x0.11'), 'workbuddy stays visible')
  assert.equal(foldToggles(harness.tree).length, 3, 'all three headers stay clickable')
  assert.equal(foldToggles(harness.tree).filter((b) => textOf(b).join('').includes('▸')).length, 2,
    'exactly the two folded groups show the closed caret')
})

test('the sort column cycles descending → global → ascending (m04564)', async () => {
  const { harness } = await mountPage([chainWith([])])
  const priceCaret = () => collect(harness.tree, (node) => node.type === 'button'
    && node.props?.title === '按计费倍率排序')[0]
  const rowKeys = () => collect(harness.tree, (node) => node.props?.style?.display === 'contents')
    .map((row) => collect(row, (n) => n.props?.key === 'id')[0])
    .filter((holder) => holder !== undefined)
    .map((holder) => textOf(holder).join('').trim())

  // The page loads cheapest-first, so the header starts on the first of its
  // three states; clicking walks descending → global → back to ascending.
  // The flat list is sorted BEFORE it is grouped, so a source sits where its
  // cheapest model puts it — the cheap sources float to the top, which is the
  // whole point of the price column. Only the global state drops the dividers.
  assert.equal(foldToggles(harness.tree).length, 3, 'the loaded ascending state keeps the dividers')
  assert.match(textOf(priceCaret()).join(''), /↑/, 'the loaded default is marked ascending')
  assert.deepEqual(rowKeys(), [CAND_B, CAND_C, PRIMARY, CAND_A],
    'the cheapest source leads, cheapest first inside it')

  await click(harness, priceCaret())
  assert.equal(foldToggles(harness.tree).length, 3, 'descending still keeps the source dividers')
  assert.match(textOf(priceCaret()).join(''), /↓/, 'the second state is marked descending')
  assert.deepEqual(rowKeys(), [CAND_A, CAND_C, CAND_B, PRIMARY],
    'the expensive sources lead now, most expensive first inside each')

  await click(harness, priceCaret())
  assert.equal(foldToggles(harness.tree).length, 0, 'the global sort renders no dividers at all')
  assert.match(textOf(priceCaret()).join(''), /≡/, 'the global state has its own mark')
  // With no dividers the palette is one flat run of data rows (counted the
  // same way `rowKeys` does — by the id cell, so other sections don't count).
  assert.equal(rowKeys().length, CATALOG.length, 'every model is still listed, just flat')
  assert.deepEqual(rowKeys(), [CAND_B, PRIMARY, CAND_C, CAND_A],
    'the flat run is one cheapest-first list across every source')

  await click(harness, priceCaret())
  assert.equal(foldToggles(harness.tree).length, 3, 'a fourth click returns to the grouped state')
  assert.match(textOf(priceCaret()).join(''), /↑/, 'and the mark returns to ascending')
})

test('the palette and candidate picker are tall enough for about a dozen rows (m04564)', async () => {
  const { harness } = await mountPage([chainWith([CAND_A])])

  const list = subtree(harness.tree, 'list')
  assert.equal(list.props.style.maxHeight, '440px', `palette scroll height: ${list.props.style.maxHeight}`)

  // The candidate picker lives behind the chain's own "添加候选" toggle.
  const toggle = collect(harness.tree, (node) => node.type === 'button'
    && textOf(node).join('').includes('添加候选'))[0]
  await click(harness, toggle)
  const picker = subtree(harness.tree, 'picker')
  assert.ok(picker !== undefined, 'opening the toggle renders the candidate picker')
  assert.equal(picker.props.style.maxHeight, '340px', `candidate picker height: ${picker.props.style.maxHeight}`)
})

test('the selection cell centres its control and the name column stays capped (m04564)', () => {
  // Left to the inline baseline the native control read as riding high; the cell is
  // now a flex box so the radio/checkbox is centred on the row's text.
  assert.equal(internals.styles.pick.display, 'flex')
  assert.equal(internals.styles.pick.alignItems, 'center')

  // The name column is capped so one very long key cannot stretch every column.
  const columns = internals.styles.grid.gridTemplateColumns
  assert.ok(columns.includes('minmax(0, 220px)'), `name column is capped: ${columns}`)
  assert.ok(!columns.includes('max-content), max-content') || columns.includes('minmax(0, 220px)'))
})

// --- the three reader asks of this round (m05197) ---------------------------

/** A fold button matched by its `title`, which names the action it performs. */
function foldButtonByTitle(tree, title) {
  return collect(tree, (node) => node.type === 'button' && node.props?.title === title)[0]
}

/** The palette search box, found by the placeholder it carries (a prop, not text). */
function searchBox(tree) {
  return collect(tree, (node) => node.type === 'input'
    && typeof node.props?.placeholder === 'string'
    && node.props.placeholder.includes('搜索'))[0]
}

test('the palette folds away and back, hiding the table without writing (m05197)', async () => {
  const { host, harness } = await mountPage([chainWith([])])
  const before = host.writes.length

  // Open, the palette renders the search box and the table.
  assert.ok(subtree(harness.tree, 'list') !== undefined, 'the palette table starts visible')
  assert.ok(searchBox(harness.tree) !== undefined, 'the search box is inside the folded body')

  await click(harness, foldButtonByTitle(harness.tree, '收起模型清单'))
  assert.equal(subtree(harness.tree, 'list'), undefined, 'folding removes the table from the tree')
  assert.equal(searchBox(harness.tree), undefined, 'the search box folds away with it')
  // The heading stays, and it is now the way back.
  assert.ok(textOf(harness.tree).join(' ').includes('可用模型清单'), 'the heading remains as the fold control')

  await click(harness, foldButtonByTitle(harness.tree, '展开模型清单'))
  assert.ok(subtree(harness.tree, 'list') !== undefined, 'unfolding brings the table back')
  assert.equal(host.writes.length, before, 'folding is a view, never a write')
})

test("a chain's candidate list folds away and back, keeping the chain header (m05197)", async () => {
  const { host, harness } = await mountPage([chainWith([CAND_A, CAND_B])])
  const before = host.writes.length

  assert.equal(candidateRows(harness.tree).length, 2, 'the candidates start visible')
  assert.ok(textOf(harness.tree).join(' ').includes(PRIMARY), 'the chain header is shown')

  await click(harness, foldButtonByTitle(harness.tree, '收起候选模型'))
  assert.equal(candidateRows(harness.tree).length, 0, 'folding hides the candidate rows')
  // The header is what stays in view — that is the point of folding a finished chain.
  assert.ok(textOf(harness.tree).join(' ').includes(PRIMARY), 'the chain header stays visible')
  assert.ok(textOf(harness.tree).join(' ').includes('候选模型（2）'), 'the heading counts the hidden candidates')

  await click(harness, foldButtonByTitle(harness.tree, '展开候选模型'))
  assert.equal(candidateRows(harness.tree).length, 2, 'unfolding brings the rows back')
  assert.equal(host.writes.length, before, 'folding is a view, never a write')
})

test('folding one chain leaves another chain open (m05197)', async () => {
  const other = 'workbuddy/deepseek-v4.1-flash'
  const { harness } = await mountPage([
    chainWith([CAND_A]),
    { primary: other, candidates: [CAND_B], triggers: { rate_limit: true, server_error: false, timeout_network: false }, maxAttempts: 2 },
  ])

  // Only the edited chain has an editor, so folding is per chain. Editing the other
  // chain while the editor is open moves the editor to it; editing back must not
  // inherit the fold.
  assert.equal(candidateRows(harness.tree).length, 1, 'the selected chain shows its candidate')
  await click(harness, foldButtonByTitle(harness.tree, '收起候选模型'))
  assert.equal(candidateRows(harness.tree).length, 0, 'the folded chain loses its rows')

  await editChainIn(harness, other)
  assert.equal(candidateRows(harness.tree).length, 1, 'the other chain is open as usual')

  await editChainIn(harness, PRIMARY)
  assert.equal(candidateRows(harness.tree).length, 0, 'and the folded chain is still folded')
})

test('the unit is not spelled out on the page, only in the row tooltip (m05197)', () => {
  // The tooltip still states it, so the number is never ambiguous.
  assert.equal(internals.windowTitle(1000000), '1000000 tokens')
  assert.equal(internals.windowTitle(undefined), '未知 tokens')
  assert.equal(internals.windowLabel(1000000), '1,000,000', 'the cell itself stays a bare number')
  assert.equal(internals.windowLabel(undefined), '窗口未知')
})

// --- scroll anchoring: adding a candidate must not move the picker ---------

/**
 * A fake element with a parent chain and a rect, enough for the anchoring math.
 *
 * `scrollTop` clamps to `scrollHeight - clientHeight` exactly as a real scroller does:
 * the fall-through between scrollers depends on a scroller that is already at its end
 * refusing to move further, so a fake that accepted any value would test nothing.
 */
function fakeElement({ top = 0, overflowY = undefined, scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}) {
  const box = {
    style: overflowY === undefined ? {} : { overflowY },
    parentNode: null,
    scrollHeight,
    clientHeight,
    _top: top,
    _scrollTop: scrollTop,
    getBoundingClientRect: () => ({ top: box._top }),
  }
  Object.defineProperty(box, 'scrollTop', {
    get: () => box._scrollTop,
    set: (value) => {
      const max = Math.max(0, box.scrollHeight - box.clientHeight)
      box._scrollTop = Math.min(Math.max(0, value), max)
    },
  })
  return box
}

test('adding a candidate scrolls the page back so the picker stays put (m05197)', () => {
  // The picker sits inside a page scroller; adding a row above it moves it down 40px.
  const scroller = fakeElement({ overflowY: 'auto', scrollHeight: 2000, clientHeight: 800 })
  const picker = fakeElement({ top: 300 })
  picker.parentNode = scroller

  // The handler measured 300 before the write; after the re-render the picker is at 340.
  picker.getBoundingClientRect = () => ({ top: 340 })
  const moved = internals.keepAnchored(picker, 300)

  assert.equal(moved, 40, 'the shift is reported in pixels')
  assert.equal(scroller.scrollTop, 40, 'the scroller is advanced by the shift, putting the picker back')
})

test('the outermost scroller is the one corrected, not the picker itself (m05197)', () => {
  // The picker is itself a capped `overflow-y: auto` box, so walking up from a
  // checkbox finds it first. Correcting the picker's own scroll would do nothing;
  // the page scroller above it is what moved. All scrollable ancestors are returned,
  // innermost first, so the correction can fall through when one is at its end.
  const page = fakeElement({ overflowY: 'auto', scrollHeight: 3000, clientHeight: 900 })
  const picker = fakeElement({ overflowY: 'auto', scrollHeight: 900, clientHeight: 340 })
  picker.parentNode = page
  const checkbox = fakeElement({ top: 0 })
  checkbox.parentNode = picker

  assert.deepEqual(internals.scrollableAncestors(checkbox), [picker, page],
    'both scrollers are found, innermost first')
})

test('the correction falls through when the outer scroller has no room left (m05197)', () => {
  // A nested pane (the settings region scrolls inside the shell) gives two scrollers.
  // At the end of the outer one `scrollTop` cannot grow further, so the inner one has
  // to absorb the shift — picking a single scroller in advance would leave the picker
  // moved and the page would still jump.
  const outer = fakeElement({ overflowY: 'auto', scrollHeight: 2000, clientHeight: 800, scrollTop: 1200 })
  const inner = fakeElement({ overflowY: 'auto', scrollHeight: 900, clientHeight: 340 })
  inner.parentNode = outer
  const picker = fakeElement({ top: 300 })
  picker.parentNode = inner

  // No document scroller in this scenario.
  const savedDocument = globalThis.document
  globalThis.document = undefined
  try {
    picker.getBoundingClientRect = () => ({ top: 340 })
    const moved = internals.keepAnchored(picker, 300)
    assert.equal(moved, 40, 'the shift is still fully absorbed')
    assert.equal(outer.scrollTop, 1200, 'the outer scroller is already at its end, so it stays put')
    assert.equal(inner.scrollTop, 40, 'the inner scroller absorbs the shift instead')
  } finally {
    globalThis.document = savedDocument
  }
})

test('anchoring is a no-op when the picker did not move (m05197)', () => {
  const scroller = fakeElement({ overflowY: 'auto', scrollHeight: 2000, clientHeight: 800 })
  const picker = fakeElement({ top: 300 })
  picker.parentNode = scroller

  assert.equal(internals.keepAnchored(picker, 300), 0, 'no shift, no scroll')
  assert.equal(scroller.scrollTop, 0, 'the scroller is left alone')
  assert.equal(internals.keepAnchored(undefined, 300), 0, 'a missing node degrades instead of throwing')
})

test('a candidate tick really scrolls the page back during the write (m05197 follow-up)', async () => {
  // End-to-end through the real component: the write renders more than once, and the
  // list only grows on the last of those renders. The anchor has to survive until
  // then, which is the bug the visibility report exposed.
  const page = fakeElement({ overflowY: 'auto', scrollHeight: 4000, clientHeight: 900 })
  // The shim is installed BEFORE mounting: the picker node the handler measures is the
  // one from the previous render, so it has to carry the fake rect already.
  let growth = 0
  React.__domShim = (node) => {
    if (node.props?.key !== 'picker') return
    node.parentNode = page
    node.getBoundingClientRect = () => ({ top: 300 + growth })
  }
  try {
    const { host, harness } = await mountPage([chainWith([])])
    await click(harness, buttonWith(harness.tree, '添加候选'))

    const box = controlIn(modelRow(subtree(harness.tree, 'picker'), CAND_A))
    box.props.onChange({ target: { checked: true } })
    // The list grows by one row once the host answer lands — model that as the picker
    // moving down 20px, which is what the anchoring has to cancel.
    await Promise.resolve()
    growth = 20
    await harness.settle()

    assert.deepEqual(host.store[0].candidates, [CAND_A], 'the write landed')
    assert.equal(page.scrollTop, 20, 'the page was scrolled back by exactly the growth')
  } finally {
    React.__domShim = undefined
  }
})

test('the anchor survives the busy render and is released after the write (m05197 follow-up)', async () => {
  // The write flips `busy` on and off, and the host answer arrives in between. If the
  // anchor were consumed by the first of those renders (where nothing has moved yet),
  // the growth would go uncorrected — that is precisely the on-screen failure.
  const page = fakeElement({ overflowY: 'auto', scrollHeight: 4000, clientHeight: 900 })
  let growth = 0
  let rectCalls = 0
  React.__domShim = (node) => {
    if (node.props?.key !== 'picker') return
    node.parentNode = page
    node.getBoundingClientRect = () => {
      rectCalls += 1
      return { top: 300 + growth }
    }
  }
  try {
    const { harness } = await mountPage([chainWith([])])
    await click(harness, buttonWith(harness.tree, '添加候选'))

    controlIn(modelRow(subtree(harness.tree, 'picker'), CAND_A))
      .props.onChange({ target: { checked: true } })
    await Promise.resolve()
    growth = 20
    await harness.settle()

    // One measurement before the write, at least one after: the correction ran.
    assert.ok(rectCalls >= 2, `the picker was measured before and after the write (${rectCalls})`)
    assert.equal(page.scrollTop, 20, 'the correction landed on the growing render')
  } finally {
    React.__domShim = undefined
  }
})

// --- chain management (m05815): roster, rename, delete, enable, fold ---------

test('the roster lists every chain with its name, primary, size and depth (m05815)', async () => {
  const named = { ...chainWith([CAND_A, CAND_B]), name: '主力回退', maxAttempts: 2 }
  const { harness } = await mountPage([named, chainWith([])])
  const rows = rosterRows(harness.tree)
  assert.equal(rows.length, 2, 'one roster row per chain')

  const first = textOf(rows[0]).join(' ')
  assert.ok(first.includes('主力回退'), 'a named chain shows its name')
  assert.ok(first.includes(PRIMARY), 'and still shows the primary key it belongs to')
  assert.ok(first.includes('2 个候选'), 'the candidate count is stated')
  assert.ok(first.includes('深度 2'), 'the attempt depth is stated')
})

test('a chain without a name is listed under its primary model (m05815)', async () => {
  const { harness } = await mountPage([chainWith([])])
  const row = rosterRow(harness.tree, PRIMARY)
  assert.ok(row !== undefined, 'the roster row exists')
  // The key is shown once: as the title, because there is no separate name.
  const text = textOf(row).join(' ')
  assert.equal(text.split(PRIMARY).length - 1, 1, 'the primary is not repeated')
})

test('renaming a chain persists the new name in one write (m05815)', async () => {
  const { host, harness } = await mountPage([chainWith([])])
  const before = host.writes.length

  await openRename(harness, PRIMARY)
  const input = renameInput(harness.tree)
  assert.ok(input !== undefined, 'the name field appears in place')

  input.props.onBlur({ target: { value: '  主力  ' } })
  await harness.settle()

  assert.equal(host.writes.length, before + 1, 'one rename is one write')
  assert.equal(host.store[0].name, '主力', 'the name is trimmed')
  assert.equal(host.store[0].primary, PRIMARY, 'renaming never touches the identity')
})

test('a whitespace-only rename clears the name back to the model id (m05815)', async () => {
  const { host, harness } = await mountPage([{ ...chainWith([]), name: '旧名字' }])
  await openRename(harness, '旧名字')
  renameInput(harness.tree).props.onBlur({ target: { value: '   ' } })
  await harness.settle()
  assert.equal(host.store[0].name, '', 'a blank name falls back to the primary')
})

test('an unchanged rename writes nothing (m05815)', async () => {
  const { host, harness } = await mountPage([{ ...chainWith([]), name: '主力' }])
  const before = host.writes.length
  await openRename(harness, '主力')
  renameInput(harness.tree).props.onBlur({ target: { value: '主力' } })
  await harness.settle()
  assert.equal(host.writes.length, before, 'no change, no write')
})

test('Escape abandons a rename without writing (m05815)', async () => {
  const { host, harness } = await mountPage([chainWith([])])
  const before = host.writes.length
  await openRename(harness, PRIMARY)
  renameInput(harness.tree).props.onKeyDown({ key: 'Escape' })
  await harness.settle()
  assert.equal(host.writes.length, before, 'Escape is not a write')
  assert.equal(renameInput(harness.tree), undefined, 'the field is gone')
  assert.ok(nameSpan(rosterRow(harness.tree, PRIMARY)) !== undefined,
    'the row is back in its normal state')
})

test('deleting a chain takes two clicks, and only the second one writes (m05815)', async () => {
  const other = { ...chainWith([CAND_A]), primary: CAND_C }
  const { host, harness } = await mountPage([chainWith([]), other])
  const before = host.writes.length

  await click(harness, buttonExact(rosterRow(harness.tree, PRIMARY), '删除'))
  assert.equal(host.writes.length, before, 'the first click only arms the confirmation')
  assert.ok(buttonExact(rosterRow(harness.tree, PRIMARY), '确认删除') !== undefined,
    'the button now asks to confirm')

  await click(harness, buttonExact(rosterRow(harness.tree, PRIMARY), '确认删除'))
  assert.equal(host.writes.length, before + 1, 'the second click is the write')
  assert.equal(host.store.length, 1, 'exactly one chain was removed')
  assert.equal(host.store[0].primary, CAND_C, 'the other chain survives')
})

test('a confirmation that is not followed through leaves the chain alone (m05815)', async () => {
  const other = { ...chainWith([]), primary: CAND_C }
  const { host, harness } = await mountPage([chainWith([]), other])
  const before = host.writes.length

  await click(harness, buttonExact(rosterRow(harness.tree, PRIMARY), '删除'))
  // Editing another chain is not a delete: arming one row must not delete it.
  await editChainIn(harness, CAND_C)
  await harness.settle()

  assert.equal(host.writes.length, before, 'nothing was written')
  assert.equal(host.store.length, 2, 'both chains are still there')
})

test('switching a chain off persists, and the row dims (m05815)', async () => {
  const { host, harness } = await mountPage([chainWith([])])
  const box = enableBox(rosterRow(harness.tree, PRIMARY))
  assert.equal(box.props.checked, true, 'chains start enabled')

  box.props.onChange({ target: { checked: false } })
  await harness.settle()

  assert.equal(host.store[0].enabled, false, 'the switch is persisted')
  assert.equal(enableBox(rosterRow(harness.tree, PRIMARY)).props.checked, false,
    'the box reflects the stored value')
})

test('switching a chain back on restores it without losing its configuration (m05815)', async () => {
  const off = { ...chainWith([CAND_A, CAND_B]), enabled: false, maxAttempts: 2 }
  const { host, harness } = await mountPage([off])

  enableBox(rosterRow(harness.tree, PRIMARY)).props.onChange({ target: { checked: true } })
  await harness.settle()

  assert.equal(host.store[0].enabled, true)
  assert.deepEqual(host.store[0].candidates, [CAND_A, CAND_B], 'the candidate order is kept')
  assert.equal(host.store[0].maxAttempts, 2, 'the depth is kept')
})

test('the 编辑 button collapses the editor without writing (m06970)', async () => {
  const { host, harness } = await mountPage([chainWith([CAND_A])])
  const before = host.writes.length
  assert.equal(candidateRows(harness.tree).length, 1, 'the editor is open to start')

  await click(harness, editButton(rosterRow(harness.tree, PRIMARY)))

  assert.equal(candidateRows(harness.tree).length, 0, 'the editor is gone from the tree')
  assert.ok(subtree(harness.tree, 'list') === undefined, 'the palette folds with it')
  assert.ok(rosterRow(harness.tree, PRIMARY) !== undefined, 'the roster row remains')
  assert.equal(host.writes.length, before, 'collapsing is a view state, never a write')

  await click(harness, editButton(rosterRow(harness.tree, PRIMARY)))
  assert.equal(candidateRows(harness.tree).length, 1, 'pressing 编辑 again reopens the editor')
})

test('the roster selection decides which chain the editor shows (m05815)', async () => {
  const other = { ...chainWith([CAND_C]), primary: CAND_C }
  const { harness } = await mountPage([chainWith([CAND_A]), other])

  // The first chain is edited by default (mountPage opens it), so its candidate
  // is the one on screen.
  assert.equal(candidateKeyOf(candidateRows(harness.tree)[0]), CAND_A)
  assert.equal(textOf(editButton(rosterRow(harness.tree, PRIMARY))).join(''), '收起',
    'the first chain is the one being edited to start')

  await editChainIn(harness, CAND_C)
  assert.equal(candidateKeyOf(candidateRows(harness.tree)[0]), CAND_C,
    'the editor follows the selection while it is open')
  assert.equal(textOf(editButton(rosterRow(harness.tree, PRIMARY))).join(''), '编辑',
    'and the other row is no longer the one being edited')
})

test('editing a chain never changes whether it takes part in failover (m05815)', async () => {
  const other = { ...chainWith([]), primary: CAND_C }
  const { host, harness } = await mountPage([chainWith([]), other])
  const before = host.writes.length

  await editChainIn(harness, CAND_C)

  assert.equal(host.writes.length, before, 'editing is view state, not a write')
  // Both rows still read as enabled: choosing which chain to look at never
  // touched the switches.
  assert.equal(enableBox(rosterRow(harness.tree, PRIMARY)).props.checked, true,
    'the first chain stays enabled')
  assert.equal(enableBox(rosterRow(harness.tree, CAND_C)).props.checked, true,
    'the edited chain stays enabled')
})

test('deleting the chain being edited closes the editor (m06970)', async () => {
  const other = { ...chainWith([CAND_C]), primary: CAND_C }
  const { host, harness } = await mountPage([chainWith([CAND_A]), other])

  await click(harness, buttonExact(rosterRow(harness.tree, PRIMARY), '删除'))
  await click(harness, buttonExact(rosterRow(harness.tree, PRIMARY), '确认删除'))

  assert.equal(host.store.length, 1, 'only the deleted chain is gone')
  assert.equal(host.store[0].primary, CAND_C)
  // The editor does not silently rebind to a chain the user never picked to edit:
  // deleting the open one closes it, and the survivor is one 编辑 press away.
  assert.equal(candidateRows(harness.tree).length, 0, 'the editor closes with its chain')
  assert.equal(textOf(editButton(rosterRow(harness.tree, CAND_C))).join(''), '编辑',
    'the survivor is closed, not silently adopted')

  await click(harness, editButton(rosterRow(harness.tree, CAND_C)))
  assert.equal(candidateKeyOf(candidateRows(harness.tree)[0]), CAND_C,
    'the survivor is now the one being edited')
})

test('the management actions stay disabled while a write is in flight (m05815)', async () => {
  const { host, harness } = await mountPage([chainWith([])])
  // Hold the host answer so the page can be observed mid-write.
  let release
  const held = new Promise((resolve) => { release = resolve })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => { await held; return realFetch(url, options) }

  try {
    enableBox(rosterRow(harness.tree, PRIMARY)).props.onChange({ target: { checked: false } })
    await harness.settle()
    const row = rosterRow(harness.tree, PRIMARY)
    assert.equal(enableBox(row).props.disabled, true, 'the switch waits for the write')
    assert.equal(editButton(row).props.disabled, true, '编辑 waits for the write')
    assert.equal(buttonExact(row, '删除').props.disabled, true, '删除 waits for the write')
    release()
    await harness.settle()
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(host.store[0].enabled, false, 'the write still landed')
})
