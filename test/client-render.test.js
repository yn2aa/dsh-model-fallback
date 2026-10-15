/**
 * Client render smoke test (task 1.5 / tasks 4.1–4.8, 6.4).
 *
 * The client bundle is loaded by DSH as a classic script through
 * `window.__ModuleLoader__.load`, and it `require('react')` — but neither React
 * nor a DOM exists in this test environment, and React is not even on disk (it is
 * a platform seed inside `app.asar`). So this test supplies the two things the
 * bundle actually depends on:
 *
 *   - a `__ModuleLoader__` stub that captures the registered factory, and
 *   - a minimal React stub with just the hooks the page uses.
 *
 * That is deliberate: the point is to prove the page can be constructed and
 * rendered with no shell, no DOM and no network, and that the real pure helpers
 * behave — not to re-test React. The page reaches the network only through
 * `useEffect`, which the stub does not run, so nothing here touches the host.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// --- a minimal React, installed before the bundle is imported ---------------

function installStubs() {
  const registry = new Map()
  globalThis.window = globalThis.window ?? {}
  globalThis.window.__ModuleLoader__ = {
    load(spec) {
      assert.equal(typeof spec?.id, 'string')
      assert.equal(typeof spec?.factory, 'function')
      registry.set(spec.id, spec.factory)
    },
  }
  globalThis.document = { baseURI: 'http://127.0.0.1:19387/' }

  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
      }
    },
    // The page never re-renders in this test, so `useState` returning its initial
    // value every call is faithful enough to prove the render does not throw.
    // `React.__stateSeed` lets a test hand the page real data (the hooks run in a
    // fixed order, so the seed is an ordered list) and thereby exercise the
    // populated branches — the empty-state render alone would hide them.
    useState: (initial) => [
      Array.isArray(React.__stateSeed) && React.__stateSeed.length > 0 ? React.__stateSeed.shift() : initial,
      () => {},
    ],
    useEffect: () => {},
    useLayoutEffect: () => {},
    // A ref is a stable box the page never reads in this test (it only measures on
    // interaction), so an empty one is faithful.
    useRef: (initial) => ({ current: initial ?? null }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }
  return { registry, React }
}

/** Walk a rendered tree and collect every text node. */
function textOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
  for (const child of node.children ?? []) textOf(child, out)
  return out
}

/** Count rendered elements matching a type. */
function countOfType(node, type, seen = 0) {
  if (node === null || node === undefined || typeof node !== 'object') return seen
  if (Array.isArray(node)) {
    let total = seen
    for (const child of node) total = countOfType(child, type, total)
    return total
  }
  let total = seen + (node.type === type ? 1 : 0)
  for (const child of node.children ?? []) total = countOfType(child, type, total)
  return total
}

/** Collect the props of every rendered element of a type. */
function propsOfType(node, type, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) propsOfType(child, type, out)
    return out
  }
  if (node.type === type) out.push(node.props ?? {})
  for (const child of node.children ?? []) propsOfType(child, type, out)
  return out
}

const { registry, React } = installStubs()

// Import AFTER the globals exist: the bundle registers itself on import.
await import('../lib/client.js')

const factory = registry.get('dsh-model-fallback')
assert.equal(typeof factory, 'function', 'the bundle must register itself under id dsh-model-fallback')

/** `require` as the client bundle sees it. */
const requireStub = (spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected client require: ${spec}`)
}

const plugin = factory(requireStub)
const internals = plugin._internals

test('the bundle registers a plugin with a settings section', () => {
  assert.equal(plugin.name, 'model-fallback')
  assert.deepEqual(plugin.inject, ['slots'])

  const registrations = []
  const ctx = {
    slots: {
      inject: (name, run) => { registrations.push(name); run() },
      register: (spec, Component) => { registrations.push({ spec, Component }) },
    },
  }
  plugin.apply(ctx)
  assert.deepEqual(registrations[0], 'settings.section')
  const { spec, Component } = registrations[1]
  assert.equal(spec.name, 'settings.section')
  assert.equal(spec.id, 'model-fallback')
  assert.equal(spec.order, 40)
  assert.equal(spec.label(), '模型回退链')
  assert.equal(typeof Component, 'function')
})

test('the API base is resolved relative to the document, not from a leading slash', () => {
  // A leading slash in the REQUEST would discard a reverse-proxy sub-path and
  // 404 at the gateway, so resolution must go through the document base.
  assert.equal(internals.resolveApiBase('http://127.0.0.1:19387/'), '/api/model-fallback')
  assert.equal(internals.resolveApiBase('http://host/dsh/'), '/dsh/api/model-fallback')
  assert.equal(internals.resolveApiBase('http://host/dsh/index.html'), '/dsh/api/model-fallback')
  // A missing document degrades to the absolute default rather than throwing.
  assert.equal(internals.resolveApiBase(undefined), '/api/model-fallback')
  assert.equal(internals.resolveApiBase('not a url'), '/api/model-fallback')
  assert.equal(internals.API_BASE, '/api/model-fallback')
})

test('the page renders with no shell, no DOM and no network', () => {
  // The real proof for task 1.5: constructing the page must not throw.
  const tree = internals.FallbackSettingsPage()
  assert.equal(tree.type, 'div')
  const text = textOf(tree).join(' ')
  assert.ok(text.includes('模型回退链'), text)
  // The palette is gated behind 编辑 (m06970): with no chain there is nothing to
  // edit, so the page shows the management empty state instead of the model list.
  assert.ok(text.includes('还没有配置任何回退链'), text)
})

test('an empty configuration renders the documented empty states', () => {
  const text = textOf(internals.FallbackSettingsPage()).join(' ')
  assert.ok(text.includes('还没有配置任何回退链'), text)
  assert.ok(text.includes('当前没有模型处于冷却中'), text)
  assert.ok(text.includes('尚未发生改派'), text)
})

// --- pure editor logic (tasks 4.1–4.6) -------------------------------------

const catalog = [
  { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash', key: 'raccoon/sn-deepseek-v4-1-flash', contextWindow: 200000 },
  { provider: 'workbuddy', model: 'deepseek-v4.1-flash', key: 'workbuddy/deepseek-v4.1-flash', contextWindow: 128000 },
  { provider: 'buddy', model: 'deepseek-v4-flash', key: 'buddy/deepseek-v4-flash' },
  { provider: 'trae', model: 'DeepSeek-V4-Flash', key: 'trae/DeepSeek-V4-Flash', contextWindow: 64000 },
]

test('the model list is filtered by identity, case-insensitively (task 4.1)', () => {
  assert.equal(internals.filterModels(catalog, '').length, 4, 'an empty query shows everything')
  assert.deepEqual(
    internals.filterModels(catalog, 'deepseek-v4').map((m) => m.key),
    ['raccoon/sn-deepseek-v4-1-flash', 'workbuddy/deepseek-v4.1-flash', 'buddy/deepseek-v4-flash', 'trae/DeepSeek-V4-Flash'],
  )
  assert.deepEqual(internals.filterModels(catalog, 'TRAE').map((m) => m.key), ['trae/DeepSeek-V4-Flash'])
  // A substring query matches every identity containing it, which is the point:
  // "buddy" is a substring of "workbuddy" and both belong in the result.
  assert.deepEqual(
    internals.filterModels(catalog, 'buddy').map((m) => m.key),
    ['workbuddy/deepseek-v4.1-flash', 'buddy/deepseek-v4-flash'],
  )
  assert.equal(internals.filterModels(catalog, 'nothing-matches').length, 0)
  assert.deepEqual(internals.filterModels(undefined, 'x'), [])
})

test('a model with no known window says so instead of inventing a number (task 4.1)', () => {
  assert.equal(internals.windowLabel(128000), '128,000')
  assert.equal(internals.windowLabel(undefined), '窗口未知')
  assert.equal(internals.windowLabel(0), '窗口未知')
  assert.equal(internals.windowLabel(-1), '窗口未知')
})

test('dragging the third candidate to the first yields exactly [C, A, B] (task 4.4)', () => {
  assert.deepEqual(internals.reorder(['A', 'B', 'C'], 2, 0), ['C', 'A', 'B'])
  assert.deepEqual(internals.reorder(['A', 'B', 'C'], 0, 2), ['B', 'C', 'A'])
})

test('a drop that changes nothing is not a write (task 4.4, one write per drag)', () => {
  const original = ['A', 'B', 'C']
  // Identity, not just equality: the caller skips persistence on `next === current`.
  assert.equal(internals.reorder(original, 1, 1), original)
  assert.equal(internals.reorder(original, 5, 0), original)
  assert.equal(internals.reorder(original, 0, 5), original)
  assert.notEqual(internals.reorder(original, 0, 1), original)
})

test('adding and removing a candidate never touches another chain (tasks 4.3/4.4)', () => {
  const other = internals.normalizeChain({ primary: 'other/model', candidates: ['keep/me'] })
  let chain = internals.normalizeChain({ primary: 'raccoon/sn-deepseek-v4-1-flash', candidates: ['A'] })
  chain = internals.addCandidate(chain, 'buddy/deepseek-v4-flash')
  assert.deepEqual(chain.candidates, ['A', 'buddy/deepseek-v4-flash'])
  chain = internals.removeCandidate(chain, 'A')
  assert.deepEqual(chain.candidates, ['buddy/deepseek-v4-flash'])
  assert.deepEqual(other.candidates, ['keep/me'], 'the other chain is untouched')
})

test('a candidate cannot be added twice, nor as a fallback to itself (task 4.3)', () => {
  let chain = internals.normalizeChain({ primary: 'raccoon/a', candidates: ['buddy/b'] })
  chain = internals.addCandidate(chain, 'buddy/b')
  assert.deepEqual(chain.candidates, ['buddy/b'])
  chain = internals.addCandidate(chain, 'raccoon/a')
  assert.deepEqual(chain.candidates, ['buddy/b'])
  assert.deepEqual(internals.addCandidate(chain, '').candidates, ['buddy/b'])
})

test('an unavailable candidate is kept and explained, never silently dropped (task 4.6)', () => {
  const index = new Map(catalog.map((m) => [m.key, m]))
  const marks = internals.availabilityOf(['workbuddy/deepseek-v4.1-flash', 'gone/model'], index)
  assert.equal(marks.length, 2, 'the missing model stays on the chain')
  assert.equal(marks[0].available, true)
  assert.equal(marks[1].available, false)
  assert.ok(marks[1].reason.includes('配置已保留'), marks[1].reason)
  assert.equal(marks[1].key, 'gone/model')
})

test('a candidate that returns to the catalog is no longer marked (task 4.6)', () => {
  const without = new Map(catalog.filter((m) => m.key !== 'buddy/deepseek-v4-flash').map((m) => [m.key, m]))
  assert.equal(internals.availabilityOf(['buddy/deepseek-v4-flash'], without)[0].available, false)
  const withIt = new Map(catalog.map((m) => [m.key, m]))
  const back = internals.availabilityOf(['buddy/deepseek-v4-flash'], withIt)[0]
  assert.equal(back.available, true)
  assert.equal(back.reason, null)
})

test('the three trigger kinds exist and each carries an explanation (task 4.5)', () => {
  assert.deepEqual(internals.TRIGGERS.map((t) => t.kind), ['rate_limit', 'server_error', 'timeout_network'])
  for (const trigger of internals.TRIGGERS) {
    assert.ok(trigger.label.length > 0, trigger.kind)
    assert.ok(trigger.help.length > 10, `${trigger.kind} needs an explanation`)
  }
})

test('a trigger switch writes exactly the kind it was given (task 4.5)', () => {
  const chain = internals.normalizeChain({ primary: 'raccoon/a', triggers: { rate_limit: true } })
  const off = internals.setTrigger(chain, 'rate_limit', false)
  assert.equal(off.triggers.rate_limit, false)
  assert.equal(off.triggers.server_error, false)
  const on = internals.setTrigger(chain, 'server_error', true)
  assert.equal(on.triggers.server_error, true)
  assert.equal(on.triggers.rate_limit, true, 'other switches keep their value')
})

test('the attempt depth is clamped to a positive integer (task 4.5)', () => {
  const chain = internals.normalizeChain({ primary: 'raccoon/a' })
  assert.equal(chain.maxAttempts, 3, 'the documented default')
  assert.equal(internals.setDepth(chain, '5').maxAttempts, 5)
  assert.equal(internals.setDepth(chain, '0').maxAttempts, 3)
  assert.equal(internals.setDepth(chain, '-2').maxAttempts, 3)
  assert.equal(internals.setDepth(chain, 'abc').maxAttempts, 3)
})

test('a stored chain is read into the shape the editor edits (task 4.7)', () => {
  const blank = internals.normalizeChain(null)
  assert.equal(typeof blank.id, 'string', 'an absent id becomes a generated one')
  assert.equal(blank.id, '')
  const { id: blankId, ...blankRest } = blank
  assert.equal(blankId, '', 'an absent id stays empty, and chainId falls back to the primary')
  assert.deepEqual(blankRest, {
    name: '', enabled: true, primary: '', candidates: [], maxAttempts: 3,
    triggers: { rate_limit: false, server_error: false, timeout_network: false },
  })
  const chain = internals.normalizeChain({
    primary: 'raccoon/a',
    candidates: ['b/c', '', 42, null],
    triggers: { rate_limit: true },
    maxAttempts: 7,
  })
  assert.deepEqual(chain.candidates, ['b/c'])
  assert.equal(chain.triggers.rate_limit, true)
  assert.equal(chain.triggers.server_error, false)
  assert.equal(chain.maxAttempts, 7)
})

test('editing a chain does not mutate the chain it was given (task 4.7)', () => {
  const chain = internals.normalizeChain({ primary: 'raccoon/a', candidates: ['b/c'] })
  const snapshot = JSON.stringify(chain)
  internals.addCandidate(chain, 'd/e')
  internals.removeCandidate(chain, 'b/c')
  internals.setTrigger(chain, 'rate_limit', true)
  internals.setDepth(chain, 9)
  internals.reorder(chain.candidates, 0, 0)
  assert.equal(JSON.stringify(chain), snapshot, 'every helper is pure')
})

test('a chain built in the editor starts with every trigger enabled', () => {
  const chain = internals.createChain('deepseek-official/deepseek-flash')
  assert.equal(chain.primary, 'deepseek-official/deepseek-flash')
  assert.deepEqual(chain.candidates, [])
  assert.equal(chain.triggers.rate_limit, true, 'a fresh chain must not be silently inert')
  assert.equal(chain.triggers.server_error, true)
  assert.equal(chain.triggers.timeout_network, true)
  assert.equal(chain.maxAttempts, 3)
  // It must survive the host's round-trip unchanged, or the editor would show a
  // different chain than the runtime reads.
  assert.deepEqual(internals.normalizeChain(chain), chain)
})

test('a created chain is a valid editor object even with a junk primary', () => {
  for (const value of [undefined, null, 42, {}]) {
    const chain = internals.createChain(value)
    assert.equal(typeof chain.id, 'string', 'every created chain carries a stable id')
    assert.equal(typeof chain.primary, 'string')
    const normalized = internals.normalizeChain(chain)
    const { id, ...rest } = normalized
    assert.equal(id, chain.id, 'the id survives normalization')
    assert.deepEqual(rest, {
      name: '', enabled: true, primary: '', candidates: [], maxAttempts: 3,
      triggers: { rate_limit: true, server_error: true, timeout_network: true },
    })
  }
})

test('every row carries a single-select control for making it a primary', () => {
  const models = [
    { provider: 'deepseek-official', model: 'deepseek-flash', key: 'deepseek-official/deepseek-flash', contextWindow: 1000000 },
    { provider: 'buddy', model: 'glm-5.3', key: 'buddy/glm-5.3', contextWindow: 200000 },
  ]
  // hooks, in call order: chains, models, cooldowns, history, query, busy, error,
  // expanded, drag, collapsed, sort, picked, paletteFolded, candidatesFolded,
  // renaming, confirmingDelete, editing, conflictNotice
  const chain = internals.createChain('buddy/glm-5.3')
  React.__stateSeed = [[chain], models, [], [], '', false, null, null, null, null, null, null, null, null, null, null, internals.chainId(chain), null]
  let tree
  try {
    tree = internals.FallbackSettingsPage()
  } finally {
    React.__stateSeed = undefined
  }

  // The palette's model rows are the ones in the palette's own radio group.
  const radios = propsOfType(tree, 'input')
    .filter((props) => props.type === 'radio' && props.name === 'model-fallback-primary')
  assert.equal(radios.length, 2, 'one radio per model row')
  assert.equal(radios[0].name, 'model-fallback-primary', 'the radios form one single-select group')
  assert.ok(radios.every((props) => props.checked === false), 'nothing is picked until the user picks')
  const text = textOf(tree).join(' | ')
  assert.ok(text.includes('可用模型清单（2）'), `expected the palette to render, saw: ${text}`)
})

test('the palette is only on screen while a chain is being edited (m06970)', () => {
  const models = [
    { provider: 'buddy', providerLabel: 'Buddy', model: 'glm-5.3', key: 'buddy/glm-5.3', name: 'GLM-5.3 · x0.79', contextWindow: 1000000 },
  ]
  const chain = internals.createChain('buddy/glm-5.3')
  const render = (editing) => {
    React.__stateSeed = [[chain], models, [], [], '', false, null, null, null, null, null, null, null, null, null, null, editing, null]
    try { return textOf(internals.FallbackSettingsPage()).join(' | ') } finally { React.__stateSeed = undefined }
  }
  // Not editing: the management list is the page, and the palette is not on it.
  const closed = render(null)
  assert.ok(closed.includes('回退链（1）'), `the roster stays, saw: ${closed}`)
  assert.ok(!closed.includes('可用模型清单'), 'the palette is hidden until 编辑 is pressed')
  assert.ok(!closed.includes('候选模型（'), 'the candidate editor is hidden too')
  assert.ok(closed.includes('编辑'), 'the row carries the 编辑 button')
  // Editing: both panels appear.
  const open = render(internals.chainId(chain))
  assert.ok(open.includes('可用模型清单（1）'), open)
  assert.ok(open.includes('候选模型（0）'), open)
  assert.ok(open.includes('收起'), 'the button reads 收起 while open')
})

test('a second chain on one primary is allowed, and an empty chain takes the picked model (m07004)', () => {
  const models = [
    { provider: 'buddy', providerLabel: 'Buddy', model: 'glm-5.3', key: 'buddy/glm-5.3', name: 'GLM-5.3 · x0.79', contextWindow: 1000000 },
    { provider: 'buddy', providerLabel: 'Buddy', model: 'glm-5.2', key: 'buddy/glm-5.2', name: 'GLM-5.2 · x0.79', contextWindow: 1000000 },
  ]
  const render = (chains, picked) => {
    const active = chains[0]
    React.__stateSeed = [chains, models, [], [], '', false, null, null, null, null, { key: 'price', direction: 'asc' }, picked, null, null, null, null, internals.chainId(active), null]
    try { return textOf(internals.FallbackSettingsPage()).join(' | ') } finally { React.__stateSeed = undefined }
  }
  // Two chains on one primary model is the point — two candidate sets to swap between.
  const first = internals.createChain('buddy/glm-5.3', { name: '回退链1' })
  const second = internals.createChain('buddy/glm-5.3', { name: '回退链2' })
  const both = render([first, second], 'buddy/glm-5.3')
  assert.ok(both.includes('回退链1') && both.includes('回退链2'), `both chains are listed, saw: ${both}`)
  // The button no longer refuses a model that already leads a chain: it offers a new one.
  assert.ok(both.includes('设为回退链主模型'), 'a second chain may be created on the same primary')

  // A chain created empty by 添加链 takes the picked model instead of making another.
  const empty = internals.createChain('', { name: '回退链1' })
  assert.equal(empty.primary, '', 'the empty chain starts with no primary at all')
  const filling = render([empty], 'buddy/glm-5.2')
  assert.ok(filling.includes('设为这条链的主模型'), filling)
  assert.ok(filling.includes('尚未选择'), 'the palette says the chain has no primary yet')
  const idle = render([empty], null)
  assert.ok(idle.includes('匹配 2 个'), `with nothing picked the page shows the match count, saw: ${idle}`)
  // The build instruction lives in the button's tooltip, not in prose.
  assert.ok(!idle.includes('先在左侧选中一个模型'), 'the instruction prose is gone')
  assert.ok(!idle.includes('点表头'), 'the sort prose is gone')
})

test('an empty chain is given the next 回退链N name, counting from the highest in use (m07004)', () => {
  assert.equal(internals.nextChainName([]), '回退链1')
  assert.equal(internals.nextChainName([{ name: '' }]), '回退链1')
  assert.equal(internals.nextChainName([{ name: '回退链1' }]), '回退链2')
  // Deleting 回退链1 must not make the next add produce a second 回退链1.
  assert.equal(internals.nextChainName([{ name: '回退链1' }, { name: '回退链3' }]), '回退链4')
  assert.equal(internals.nextChainName([{ name: '我的链' }, { name: '回退链2' }]), '回退链3')
})

test('a created chain carries its own id, so two chains on one primary stay distinct (m07004)', () => {
  const first = internals.createChain('buddy/glm-5.3')
  const second = internals.createChain('buddy/glm-5.3')
  assert.equal(typeof first.id, 'string')
  assert.notEqual(first.id, '', 'a chain built in the editor has an id')
  assert.notEqual(first.id, second.id, 'two chains never share an id')
  assert.equal(internals.chainId(first), first.id)
  // A hand-written file has no id: the primary model is the identity, which was unique
  // back when it was the only way to name a chain.
  assert.equal(internals.chainId({ primary: 'buddy/glm-5.3' }), 'buddy/glm-5.3')
})

test('setting a primary fills in an empty chain and drops that model from its candidates', () => {
  const chain = internals.addCandidate(internals.createChain(''), 'buddy/glm-5.3')
  const filled = internals.setPrimary(chain, 'buddy/glm-5.2')
  assert.equal(filled.primary, 'buddy/glm-5.2')
  // A model cannot back itself up.
  const same = internals.setPrimary(internals.addCandidate(internals.createChain(''), 'buddy/glm-5.3'), 'buddy/glm-5.3')
  assert.deepEqual(same.candidates, [])
  // Junk is refused rather than stored as a primary.
  assert.equal(internals.setPrimary(chain, '').primary, '')
  assert.equal(internals.setPrimary(chain, 42).primary, '')
})

test('the candidate picker ticks what is already in the chain (task 4.3)', () => {
  const models = [
    { provider: 'buddy', providerLabel: 'Buddy', model: 'glm-5.3', key: 'buddy/glm-5.3', name: 'GLM-5.3 · x0.79', contextWindow: 1000000 },
    { provider: 'buddy', providerLabel: 'Buddy', model: 'glm-5.2', key: 'buddy/glm-5.2', name: 'GLM-5.2 · x0.79', contextWindow: 1000000 },
    { provider: 'buddy', providerLabel: 'Buddy', model: 'glm-5.1', key: 'buddy/glm-5.1', name: 'GLM-5.1 · x0.79', contextWindow: 1000000 },
  ]
  const chain = internals.addCandidate(internals.createChain('buddy/glm-5.3'), 'buddy/glm-5.2')
  const id = internals.chainId(chain)
  // `expanded` = the chain whose picker is open; `editing` = the chain whose editor is open.
  React.__stateSeed = [[chain], models, [], [], '', false, null, id, null, null, null, null, null, null, null, null, id, null]
  let tree
  try {
    tree = internals.FallbackSettingsPage()
  } finally {
    React.__stateSeed = undefined
  }
  const boxes = propsOfType(tree, 'input')
    .filter((props) => props.name === 'model-fallback-candidate')
  // The chain's own primary is never offered as its own candidate, and ticking a
  // box IS membership — so the box must already be ticked for an added candidate.
  assert.deepEqual(boxes.map((props) => props.checked), [true, false], 'ticked reflects the chain')
})

test('the billing multiplier is read off the model name', () => {
  assert.deepEqual(internals.priceOf('Deepseek-V4-Pro · x0.51'), { display: 'x0.51', value: 0.51, free: false })
  assert.deepEqual(internals.priceOf('GPT-6.1-Sol · x1.33'), { display: 'x1.33', value: 1.33, free: false })
  assert.deepEqual(internals.priceOf('Step-5-Preview · x0.00→免费'), { display: '免费', value: 0, free: true })
  // A waived multiplier (`x0.29→免费`) still says 免费 and still costs nothing
  // today, so it must not sort as if it cost x0.29 (m08011).
  assert.deepEqual(internals.priceOf('Hy4 preview · x0.29→免费'), { display: '免费', value: 0, free: true })
  // A tag with no multiplier at all is free too.
  assert.deepEqual(internals.priceOf('Qwen3.8-Flash · 免费'), { display: '免费', value: 0, free: true })
  assert.deepEqual(internals.priceOf('DeepSeek-V41-Flash'), { display: '', value: null, free: false })
  for (const junk of [undefined, null, 42, {}, '· 没有价格', 'x']) {
    const parsed = internals.priceOf(junk)
    assert.equal(parsed.value, null, `${String(junk)} has no known price`)
    assert.equal(parsed.display, '')
  }
})

test('a waived multiplier sorts as free, not at its list price (m08011)', () => {
  const sorted = [
    { name: 'Expensive · x1.90' },
    { name: 'No price at all' },
    { name: 'Waived · x0.29→免费' },
    { name: 'Free · x0.00→免费' },
    { name: 'Cheap · x0.05' },
  ].sort(internals.comparePrice)
  assert.deepEqual(sorted.map((m) => m.name), [
    // Both free rows lead (equal at 0, so their relative order is the input's),
    // then the cheap one, then the paid ones; an unknown price is last either way.
    'Waived · x0.29→免费', 'Free · x0.00→免费', 'Cheap · x0.05', 'Expensive · x1.90', 'No price at all',
  ])
})

test('the row title drops the price suffix and falls back to the id', () => {
  assert.equal(internals.titleOf({ name: 'Deepseek-V4-Pro · x0.51', model: 'deepseek-v4-pro' }), 'Deepseek-V4-Pro')
  assert.equal(internals.titleOf({ name: 'DeepSeek-V41-Flash', model: 'deepseek-flash' }), 'DeepSeek-V41-Flash')
  assert.equal(internals.titleOf({ model: 'glm-5.3', key: 'buddy/glm-5.3' }), 'glm-5.3')
  assert.equal(internals.titleOf({ key: 'buddy/glm-5.3' }), 'buddy/glm-5.3')
  assert.equal(internals.titleOf({ name: '   · x1', model: 'fallback-id' }), 'fallback-id')
})

test('models sort cheapest-first, and an unknown price sorts last', () => {
  const sorted = [
    { name: 'Expensive · x1.90' },
    { name: 'No price at all' },
    { name: 'Free · x0.00→免费' },
    { name: 'Cheap · x0.05' },
  ].sort(internals.comparePrice)
  assert.deepEqual(sorted.map((m) => m.name), [
    'Free · x0.00→免费', 'Cheap · x0.05', 'Expensive · x1.90', 'No price at all',
  ])
})

test('the catalogue is grouped by channel in the host order, leaving row order alone', () => {
  const groups = internals.groupModels([
    { provider: 'workbuddy', providerLabel: 'WorkBuddy (国际版)', model: 'grok', key: 'workbuddy/grok', name: 'Grok-4.7 · x1.90' },
    { provider: 'lobsterai', providerLabel: 'LobsterAI (有道)', model: 'flash', key: 'lobsterai/flash', name: 'DeepSeek-V4.1-Flash · x0.05' },
    { provider: 'workbuddy', providerLabel: 'WorkBuddy (国际版)', model: 'glm', key: 'workbuddy/glm', name: 'GLM-5.3-Flash · x0.06' },
    null,
  ])
  assert.deepEqual(groups.map((g) => g.provider), ['workbuddy', 'lobsterai'], 'host provider order is kept')
  assert.equal(groups[0].label, 'WorkBuddy (国际版)')
  // Grouping is not sorting: the caller's order survives, so the header's sort
  // control is the only thing that ever reorders rows.
  assert.deepEqual(groups[0].models.map((m) => m.name), ['Grok-4.7 · x1.90', 'GLM-5.3-Flash · x0.06'])
  assert.equal(groups[1].label, 'LobsterAI (有道)')
  assert.deepEqual(internals.groupModels(undefined), [])
})

test('a column sorts ascending then descending, and unknowns stay last either way', () => {
  const models = [
    { key: 'c', name: 'Cheap · x0.05', contextWindow: 200000 },
    { key: 'u', name: 'No price, no window' },
    { key: 'f', name: 'Free · x0.00→免费', contextWindow: 8000 },
    { key: 'e', name: 'Expensive · x1.90', contextWindow: 1000000 },
  ]
  assert.deepEqual(
    internals.sortModels(models, { key: 'price', direction: 'asc' }).map((m) => m.key),
    ['f', 'c', 'e', 'u'],
  )
  assert.deepEqual(
    internals.sortModels(models, { key: 'price', direction: 'desc' }).map((m) => m.key),
    ['e', 'c', 'f', 'u'],
    'flipping the column must not promote the model with no known price',
  )
  assert.deepEqual(
    internals.sortModels(models, { key: 'window', direction: 'asc' }).map((m) => m.key),
    ['f', 'c', 'e', 'u'],
  )
  assert.deepEqual(
    internals.sortModels(models, { key: 'window', direction: 'desc' }).map((m) => m.key),
    ['e', 'c', 'f', 'u'],
  )
})

test('no sort leaves the host order alone, and the input array is never mutated', () => {
  const models = [{ key: 'b', name: 'B · x1' }, { key: 'a', name: 'A · x0.1' }]
  assert.equal(internals.sortModels(models, null), models, 'no column means no copy at all')
  assert.equal(internals.sortModels(models, { key: 'nope', direction: 'asc' }), models)
  const sorted = internals.sortModels(models, { key: 'price', direction: 'asc' })
  assert.deepEqual(sorted.map((m) => m.key), ['a', 'b'])
  assert.deepEqual(models.map((m) => m.key), ['b', 'a'], "the caller's array is untouched")
})

test('the context window is exposed as a bare number for the table column', () => {
  assert.equal(internals.windowValueOf({ contextWindow: 128000 }), 128000)
  for (const junk of [{ contextWindow: 0 }, { contextWindow: -1 }, { contextWindow: 12.5 }, { contextWindow: '128000' }, {}, undefined]) {
    assert.equal(internals.windowValueOf(junk), null, `${JSON.stringify(junk)} has no usable window`)
  }
})

test('a provider without a display name still gets a heading', () => {
  const groups = internals.groupModels([{ provider: 'raccoon', model: 'sn-flash', key: 'raccoon/sn-flash' }])
  assert.equal(groups[0].label, 'raccoon')
})

test('search matches the channel name and the model display name, not just the id', () => {
  const models = [
    { provider: 'workbuddy', providerLabel: 'WorkBuddy (国际版)', model: 'gpt-6-sol', key: 'workbuddy/gpt-6-sol', name: 'GPT-6-Sol · x1.33' },
    { provider: 'buddy', providerLabel: 'Buddy', model: 'kimi-k3-1', key: 'buddy/kimi-k3-1', name: 'Kimi-K3.1 · x0.20' },
  ]
  assert.deepEqual(internals.filterModels(models, 'workbuddy').map((m) => m.key), ['workbuddy/gpt-6-sol'])
  assert.deepEqual(internals.filterModels(models, 'GPT-6').map((m) => m.key), ['workbuddy/gpt-6-sol'])
  assert.deepEqual(internals.filterModels(models, 'KIMI').map((m) => m.key), ['buddy/kimi-k3-1'])
  assert.equal(internals.filterModels(models, '').length, 2)
})

test('the palette renders channel headings, titles and prices', () => {
  const models = [
    { provider: 'workbuddy', providerLabel: 'WorkBuddy (国际版)', model: 'grok', key: 'workbuddy/grok', name: 'Grok-4.7 · x1.90', contextWindow: 1000000 },
    { provider: 'workbuddy', providerLabel: 'WorkBuddy (国际版)', model: 'glm', key: 'workbuddy/glm', name: 'GLM-5.3-Flash · x0.06', contextWindow: 1000000 },
    { provider: 'lobsterai', providerLabel: 'LobsterAI (有道)', model: 'flash', key: 'lobsterai/flash', name: 'DeepSeek-V4.1-Flash · x0.05', contextWindow: 1000000 },
  ]
  // hooks, in call order: chains, models, cooldowns, history, query, busy, error,
  // expanded, drag, collapsed, sort, picked, paletteFolded, candidatesFolded,
  // selected, renaming, confirmingDelete, editing, conflictNotice. The palette is
  // gated behind 编辑 (m06970), so the seed has to open a chain to reach the table.
  const chain = internals.createChain('workbuddy/glm')
  React.__stateSeed = [[chain], models, [], [], '', false, null, null, null, null, { key: 'price', direction: 'asc' }, null, null, null, null, null, internals.chainId(chain), null]
  let tree
  try {
    tree = internals.FallbackSettingsPage()
  } finally {
    React.__stateSeed = undefined
  }

  const text = textOf(tree)
  assert.ok(text.includes('WorkBuddy (国际版)'), 'the channel is a heading, not a prefix')
  assert.ok(text.includes('LobsterAI (有道)'))
  assert.ok(text.includes('Grok-4.7'), 'the row shows the display name, not the key')
  assert.ok(text.includes('x1.90'), 'the billing multiplier is visible')
  assert.ok(text.includes('x0.05'))
  // The row leads with the display name; the `provider/model` key stays visible
  // as dim trailing text, because that is what lands in chains.json.
  assert.ok(text.indexOf('Grok-4.7') < text.indexOf('workbuddy/grok'), 'the title leads, the key trails')
  // Cheapest first inside the channel: the free/cheap GLM must precede Grok.
  assert.ok(text.indexOf('GLM-5.3-Flash') < text.indexOf('Grok-4.7'), 'cheap models come first')
})

test('the catalogue is a labelled table whose columns carry the unit and the sort', () => {
  const models = [
    { provider: 'buddy', providerLabel: 'Buddy', model: 'glm-5.3', key: 'buddy/glm-5.3', name: 'GLM-5.3 · x0.79', contextWindow: 1000000 },
  ]
  // hooks: chains, models, cooldowns, history, query, busy, error, expanded, drag,
  // collapsed, sort, picked, paletteFolded, candidatesFolded, selected, renaming,
  // confirmingDelete, editing, conflictNotice
  const chain = internals.createChain('buddy/glm-5.3')
  React.__stateSeed = [[chain], models, [], [], '', false, null, null, null, null, { key: 'window', direction: 'desc' }, null, null, null, null, null, internals.chainId(chain), null]
  let tree
  try {
    tree = internals.FallbackSettingsPage()
  } finally {
    React.__stateSeed = undefined
  }

  const text = textOf(tree).join(' | ')
  for (const heading of ['模型名称', '计费倍率', '上下文窗口', '来源']) {
    assert.ok(text.includes(heading), `the table must label the ${heading} column`)
  }
  // The unit is not spelled out anywhere on the page (m05197): every reader of a
  // context-window column already knows it is tokens, and each row carries the
  // value in its `title` tooltip, so a standing sentence would be pure noise.
  assert.equal(text.split('tokens').length - 1, 0, `the unit is never written out: ${text}`)
  assert.ok(!text.includes('上下文窗口 / tokens'), 'the heading is split, not a single wide label')
  // The selection column is self-explanatory (one radio per row), so it carries no
  // heading — a two-character label only ever wrapped onto two lines in 26px.
  assert.ok(!text.includes('选择'), 'the selection column has no heading')
  // The row holds the bare number and never repeats "tokens" on every line.
  assert.ok(text.includes('1,000,000'), text)
  assert.ok(!text.includes('1,000,000 tokens'), 'the row must not repeat the unit (task 4.1)')
  // The active column shows its direction; the inactive one stays neutral.
  assert.ok(text.includes('↓'), 'the sorted column shows its direction')
  assert.ok(text.includes('↕'), 'the other column stays neutral')
})

test('the table is painted, content-sized and tabular', () => {
  // A sticky header needs an opaque background painted on the header element
  // itself. `inherit` resolved to transparent (no ancestor paints one), which let
  // the rows scroll through the header.
  assert.equal(internals.styles.th.background, internals.styles.panel.background)
  assert.notEqual(internals.styles.th.background, 'inherit')

  // The numeric columns size to their content. Fixed widths wider than the content
  // (96px / 132px) left a large gap on the left of every number, which is exactly
  // the "空挡" the reader noticed; the trailing 来源 column absorbs the slack.
  const columns = internals.styles.grid.gridTemplateColumns
  assert.ok(columns.includes('max-content'), `columns size to their content, saw: ${columns}`)
  for (const pinned of ['96px', '132px', '1.4fr']) {
    assert.ok(!columns.includes(pinned), `column template must not pin ${pinned}`)
  }

  // One shared typographic register across the whole table: the reader asked for
  // "右边这三栏的字体改为统一使用左边模型名称的字体", so the price / window / source
  // cells carry the page's UI font, and only `tabular-nums` keeps the digits aligned.
  assert.match(internals.styles.numeric.fontVariantNumeric, /tabular-nums/)
  assert.equal(internals.styles.numeric.fontFamily, undefined)
  assert.equal(internals.styles.sourceTag.fontFamily, undefined)
  assert.equal(internals.styles.price, undefined)

  // The search box fills its row instead of stopping at a fixed 220px.
  assert.match(internals.styles.input.flex, /1 1 auto/)
})

test('every heading cell is one line tall so the sticky border cannot step', () => {
  // Two shapes of this bug have been measured. First the numeric headings were a line
  // taller than the text ones (32px against 50/51px), which broke the sticky bottom
  // border into steps. Then, with a fixed height on every cell, the *labels* still sat
  // at different heights because a two-line heading put its label on the first line
  // while a one-line heading was centred. The heading is now a single line in every
  // column, which settles both: same cell height, same label baseline, no reserved
  // second line.
  assert.equal(internals.styles.th.height, '26px')
  assert.equal(internals.styles.th.display, 'flex')
  assert.equal(internals.styles.th.flexDirection, undefined, 'a column stack is what pushed the caret down')
  assert.equal(internals.styles.th.minHeight, undefined, 'minHeight let the cells differ')
  // A single line has to stay single even if the shell hands down a looser line-height.
  assert.equal(internals.styles.th.lineHeight, '1.3')

  // The unit a column measures in is not part of the heading, and it is no longer
  // spelled out above the table either (m05197): each row's `title` tooltip carries
  // "… tokens", so a standing sentence would only repeat what a hover already says.
  assert.equal(internals.styles.thStack, undefined, 'the two-line heading is gone')
  assert.equal(internals.styles.thUnit, undefined, 'the unit line is gone')
  const seedChain = internals.createChain('buddy/glm-5.3')
  React.__stateSeed = [[seedChain], [], [], [], '', false, null, null, null, null, { key: 'price', direction: 'asc' }, null, null, null, null, null, internals.chainId(seedChain), null]
  let lines
  try { lines = textOf(internals.FallbackSettingsPage()) } finally { React.__stateSeed = undefined }
  const count = lines.find((line) => line.includes('匹配 '))
  assert.ok(count, 'the count line is rendered')
  assert.doesNotMatch(count, /tokens/, 'the count line no longer explains the unit')
  // The tooltip is where the unit lives now.
  assert.match(internals.windowTitle(1000000), /tokens/)

  // The sort control is a bare caret. A boxed button (padding + border) made the
  // heading the widest cell of a `max-content` numeric column, which is what put a
  // gap in front of every number in that column.
  assert.equal(internals.styles.sortButton.padding, '0')
  assert.equal(internals.styles.sortButton.border, 'none')
  assert.equal(internals.styles.sortButton.width, undefined)
  // The label and its caret share the one line.
  assert.equal(internals.styles.th.gap, '3px')
})
