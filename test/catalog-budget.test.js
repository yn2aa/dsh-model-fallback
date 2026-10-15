/**
 * The window pass must be bounded (task 4.1 / 7.3).
 *
 * The settings page fetches the catalog through the host's `webServer` and is
 * therefore subject to the client's request timeout. Resolving a window for
 * every reachable model one at a time can run past it, so the pass is
 * time-budgeted and batched: whatever it does not reach stays "unknown", which
 * costs precision but never correctness — a model with an unknown window is
 * still eligible as a candidate.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { collectCatalog, WINDOW_CONCURRENCY, WINDOW_BUDGET_MS } from '../lib/catalog.js'

function llmWith(count, { onResolve } = {}) {
  const models = Array.from({ length: count }, (_, index) => ({ id: `m${index}` }))
  return {
    listProviders: async () => [{ provider: 'p' }],
    listModels: async () => models,
    resolveModelInfo: async () => {
      onResolve?.()
      return { context: { contextWindow: 1000 } }
    },
  }
}

test('the window pass stops at its time budget and leaves the rest unknown', async () => {
  let clock = 0
  const out = await collectCatalog(
    llmWith(40, { onResolve: () => { clock += 50 } }),
    { windowConcurrency: 1, windowBudgetMs: 120, now: () => clock },
  )

  const resolved = out.filter((item) => item.contextWindow !== undefined).length
  assert.ok(resolved > 0, 'some windows were resolved before the budget ran out')
  assert.ok(resolved < 40, 'the pass stopped early instead of walking every model')
  assert.equal(out.length, 40, 'the full model list survives the truncation')
  assert.ok(out.every((item) => item.key.startsWith('p/m')), 'every entry keeps its identity')
})

test('a zero budget means no limit, so the whole catalog gets windows', async () => {
  const out = await collectCatalog(llmWith(30), { windowBudgetMs: 0, windowConcurrency: 8 })
  assert.equal(out.length, 30)
  assert.ok(out.every((item) => item.contextWindow === 1000))
})

test('the defaults leave room for the client timeout and bounded parallelism', () => {
  assert.ok(WINDOW_BUDGET_MS > 0 && WINDOW_BUDGET_MS <= 8000, 'budget stays under the fetch timeout')
  assert.ok(WINDOW_CONCURRENCY >= 1 && WINDOW_CONCURRENCY <= 64, 'parallelism stays bounded')
})
