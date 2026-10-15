/**
 * Render the settings page's real markup to a static HTML file.
 *
 * Why this exists: the page is a React component that only ever runs inside DSH's
 * web shell, so the only way to look at its layout without a browser session is to
 * run the bundle's *real* render function against the same tiny React stub the
 * render smoke test uses, then serialise the resulting tree to HTML with the real
 * style objects. Nothing here is hand-copied — the styles come straight from
 * `lib/client.js`, so a screenshot of this file shows what the page really lays out.
 *
 *   node scratch/preview.mjs [outFile]
 *
 * Then: msedge --headless --screenshot=out.png --window-size=640,900 file:///...
 */

import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const out = process.argv[2] ?? 'scratch/preview.html'
const redHeader = process.argv.includes('--header-red')
// Counterfactual switch: drop the sticky heading's stacking level to see whether the
// rows win the paint order without it (i.e. whether z-index is what buys occlusion).
const noZIndex = process.argv.includes('--no-zindex')
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

// --- the same minimal React the smoke test installs -------------------------

let seed = null
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true) }
  },
  useState: (initial) => [Array.isArray(seed) && seed.length > 0 ? seed.shift() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  // The page keeps a ref to the picker and measures it on interaction; a static
  // render never interacts, so an empty box is faithful.
  useRef: (initial) => ({ current: initial ?? null }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}
let factory
globalThis.window = { __ModuleLoader__: { load(spec) { factory = spec.factory } } }
globalThis.document = { baseURI: 'http://127.0.0.1:19387/' }

await import(pathToFileURL(path.join(here, '..', 'lib', 'client.js')).href)

const requireStub = (spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected client require: ${spec}`)
}
const internals = factory(requireStub)._internals

// --- a catalogue that exercises every cell shape ----------------------------

const M = (provider, providerLabel, model, name, contextWindow) => ({
  provider, providerLabel, model, key: `${provider}/${model}`, name, contextWindow,
})
const models = [
  M('buddy', 'CodeBuddy（腾讯）', 'hy3', 'Hy3 · x0.00 免费', 192000),
  M('buddy', 'CodeBuddy（腾讯）', 'step-5-preview', 'Step-5-Preview · x0.00 免费', 1000000),
  M('buddy', 'CodeBuddy（腾讯）', 'glm-5.3-flash', 'GLM-5.3-Flash · x0.06', 1000000),
  M('buddy', 'CodeBuddy（腾讯）', 'deepseek-v4.1-flash', 'Deepseek-V4.1-Flash · x0.05', 1000000),
  M('buddy', 'CodeBuddy（腾讯）', 'kimi-k2.6', 'Kimi-K2.6 · x0.51', 256000),
  M('buddy', 'CodeBuddy（腾讯）', 'no-price-model', 'No Price Model', undefined),
  M('deepseek-official', 'DeepSeek（官方）', 'deepseek-flash', 'DeepSeek-V41-Flash', 1000000),
  M('our-free-model', '免费模型（our-free-model）', 'jev-1.13-free', 'Jev 1.13 Free · x0.00 免费', 32768),
  M('workbuddy', 'WorkBuddy', 'grok-4.7', 'Grok-4.7 · x1.90', 2000000),
]

const chains = [
  {
    // Named, enabled, and with the id distinct from the name: the roster shows the
    // name as the title and the key beside it, so the fixture must exercise both.
    name: '主力回退',
    enabled: true,
    primary: 'workbuddy/deepseek-v4.1-flash',
    candidates: ['buddy/glm-5.3-flash', 'buddy/hy3'],
    triggers: { rate_limit: true, server_error: true, timeout_network: false },
    maxAttempts: 3,
  },
  {
    // A second, disabled chain with no name: the roster must fall back to the key for
    // the title and dim the row, so the fixture covers that case too.
    name: '',
    enabled: false,
    primary: 'raccoon/sn-deepseek-v4-1-flash',
    candidates: ['buddy/glm-5.3-flash'],
    triggers: { rate_limit: true, server_error: true, timeout_network: true },
    maxAttempts: 2,
  },
]
// The chain's own primary is not in the catalogue above, which is realistic: the
// editor renders a chain whose model the channel no longer advertises.
models.push(M('workbuddy', 'WorkBuddy', 'deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash · x0.11', 1000000))

const cooldowns = [{ key: 'buddy/hy3', until: Date.now() + 45000, startedAt: Date.now(), reason: 'rate_limit', remainingMs: 45000 }]
const history = [{ turn: 3, step: 2, from: 'workbuddy/deepseek-v4.1-flash', to: 'buddy/glm-5.3-flash', trigger: 'rate_limit', reason: 'failover' }]

// hooks, in call order: chains, models, cooldowns, history, query, busy, error,
// expanded, drag, collapsed, sort, picked, paletteFolded, candidatesFolded,
// foldedChains, renaming, confirmingDelete
const editingId = chains[0].id ?? chains[0].primary
seed = [chains, models, cooldowns, history, '', false, null, null, null, null,
  { key: 'price', direction: 'asc' }, null, false, null, editingId, null, null, editingId, null]
const tree = internals.FallbackSettingsPage()
seed = null

// --- tree -> HTML -----------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const UNITLESS = new Set(['fontWeight', 'opacity', 'flexGrow', 'flexShrink', 'lineHeight', 'zIndex', 'order', 'flex'])
const css = (style = {}) => Object.entries(style)
  .filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => {
    const prop = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
    const val = typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : String(v)
    return `${prop}:${val}`
  })
  .join(';')

const ATTRS = { type: 'type', checked: 'checked', disabled: 'disabled', placeholder: 'placeholder', value: 'value', name: 'name', title: 'title' }

function toHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  const { type, props, children } = node
  const attrs = []
  if (props.style) attrs.push(`style="${css(props.style)}"`)
  for (const [key, attr] of Object.entries(ATTRS)) {
    if (props[key] !== undefined && props[key] !== null && props[key] !== false) attrs.push(`${attr}="${esc(props[key])}"`)
  }
  if (type === 'input') return `<input ${attrs.join(' ')}>`
  return `<${type} ${attrs.join(' ')}>${(children ?? []).map(toHtml).join('')}</${type}>`
}

// DSH's design tokens, so the screenshot shows the same surfaces the shell paints.
const tokens = `
:root{color-scheme:dark;--dsw-alias-bg-base:#1b1b1e;--dsw-alias-bg-layer-1:#232327;--dsw-alias-bg-layer-2:#2a2a2f;--dsw-alias-bg-layer-3:#313138;
--dsw-alias-label-primary:#e8e8ea;--dsw-alias-label-secondary:#a9a9b2;--dsw-alias-label-tertiary:#7c7c86;
--dsw-alias-border-l1:#2f2f36;--dsw-alias-border-l2:#3a3a42;--dsw-alias-border-l4:#4a4a54;
--dsw-alias-state-success-primary:#37c07a;--dsw-alias-state-error-primary:#e5605c;--dsw-alias-state-warn-primary:#e0a04a;
--dsw-font-xxxs-11:11px;--dsw-font-xxs-12:12px;--dsw-font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;}
*{box-sizing:border-box}body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
input{color:inherit}button{font:inherit}
`

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>model-fallback settings preview</title><style>${tokens}</style></head>
<body><div style="width:600px">${toHtml(tree)}</div>
<script>
// Scroll the catalogue box so the sticky heading overlaps real rows: that is the
// only way a screenshot can show whether the heading is opaque or see-through.
const list = [...document.querySelectorAll('div')].find((d) => d.style.overflowY === 'auto')
if (list !== undefined) list.scrollTop = 160

// Measure the columns so alignment can be checked without eyeballing pixels. The
// header wrapper uses display:contents, so its children line up with the row
// wrappers' children only if the shared grid template really applies to both.
const out = []
if (list !== undefined) {
  const kids = [...list.children]
  const head = kids.find((k) => k.style.display === 'contents')
  const rows = kids.filter((k) => k.style.display === 'contents' && k !== head)
  const box = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.left) + '..' + Math.round(r.right) }
  const box2 = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.left) + '..' + Math.round(r.right) + '×' + Math.round(r.top) + '..' + Math.round(r.bottom) }
  if (head !== undefined) out.push('header  ' + [...head.children].map(box).join('  '))
  for (const row of rows.slice(0, 3)) out.push('row     ' + [...row.children].map(box).join('  '))
  // Vertical geometry matters as much as horizontal: every heading cell must be the
  // same height, otherwise the bottom border breaks into steps as it scrolls.
  if (head !== undefined) {
    out.push('headV   ' + [...head.children].map(box2).join('  '))
    for (const row of rows.slice(0, 2)) out.push('rowV    ' + [...row.children].map(box2).join('  '))
    for (let i = 0; i < head.children.length; i++) {
      const cell = head.children[i]
      if (cell.children.length > 1) {
        out.push('headCh' + i + ' ' + [...cell.children].map(box2).join('  '))
      }
    }
  }
  // Paint the sticky heading red on demand: with an opaque heading the red band
  // hides the row scrolling underneath it, which is the property under test.
  if (${redHeader} && head !== undefined) {
    for (const cell of head.children) cell.style.background = 'red'
  }
  // Counterfactual: drop the heading's stacking level to see whether the rows win
  // the paint order without it (i.e. whether z-index is what buys the occlusion).
  if (${noZIndex} && head !== undefined) {
    for (const cell of head.children) cell.style.zIndex = 'auto'
  }
  // Prove occlusion numerically instead of by eye: find a data row that actually
  // intersects the sticky heading, then ask the document what is on top there.
  if (head !== undefined && rows.length > 0) {
    const h = head.children[0].getBoundingClientRect()
    const style = getComputedStyle(head.children[0])
    let probe = null
    for (const row of rows) {
      const r = row.children[0].getBoundingClientRect()
      if (Math.min(r.bottom, h.bottom) - Math.max(r.top, h.top) > 4) { probe = r; break }
    }
    if (probe === null) {
      out.push('no row intersects the heading band — nothing to occlude')
    } else {
      const midY = Math.round((Math.max(h.top, probe.top) + Math.min(h.bottom, probe.bottom)) / 2)
      const probeX = Math.round(probe.left + 45)
      const top = document.elementFromPoint(probeX, midY)
      out.push('overlap=' + Math.round(Math.min(h.bottom, probe.bottom) - Math.max(h.top, probe.top)) + 'px  rowTop=' + Math.round(probe.top) + '  headBand=' + Math.round(h.top) + '..' + Math.round(h.bottom))
      out.push('elementFromPoint(' + probeX + ',' + midY + ') = "' + (top === null ? 'none' : top.textContent.slice(0, 12)) + '"')
    }
    out.push('headBg=' + style.backgroundColor + '  zIndex=' + style.zIndex + '  position=' + style.position)
    out.push('scrollTop=' + Math.round(list.scrollTop) + ' scrollHeight=' + list.scrollHeight + ' clientHeight=' + list.clientHeight)
  }
}
const pre = document.createElement('pre')
pre.id = 'measure'
pre.textContent = out.join('\\n')
document.body.appendChild(pre)
</script>
</body></html>`

writeFileSync(path.join(here, '..', out), html, 'utf8')
console.log(`wrote ${out} (${html.length} bytes)`)
