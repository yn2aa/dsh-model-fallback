/**
 * Tests for the request-size estimator (design D4's input).
 *
 * The estimator is deliberately coarse and must fail OPEN: an unmeasurable
 * request yields `undefined`, and the candidate selector is specified never to
 * drop a candidate because its size is unknown.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateTokens, textLength, CHARS_PER_TOKEN } from '../lib/request-size.js'

test('the estimator uses the customary characters-per-token ratio', () => {
  assert.equal(CHARS_PER_TOKEN, 4)
  assert.equal(estimateTokens([{ content: 'x'.repeat(400) }]), 100)
  assert.equal(estimateTokens([{ content: 'abcde' }]), 2) // rounds up
})

test('the estimate sums every message in the request', () => {
  const messages = [
    { content: 'x'.repeat(40) },
    { content: 'y'.repeat(40) },
    { content: 'z'.repeat(40) },
  ]
  assert.equal(estimateTokens(messages), 30)
})

test('the estimate reads the kernel content-part shape', () => {
  const messages = [{ content: [{ type: 'text', text: 'x'.repeat(80) }] }]
  assert.equal(estimateTokens(messages), 20)
})

test('non-text content parts contribute nothing rather than a bogus count', () => {
  const messages = [{
    content: [
      { type: 'text', text: 'x'.repeat(40) },
      { type: 'image', data: 'z'.repeat(100_000) },
    ],
  }]
  assert.equal(estimateTokens(messages), 10)
})

test('an unmeasurable request yields undefined so no candidate is dropped for it', () => {
  assert.equal(estimateTokens(undefined), undefined)
  assert.equal(estimateTokens(null), undefined)
  assert.equal(estimateTokens('not an array'), undefined)
  assert.equal(estimateTokens([]), undefined)
  assert.equal(estimateTokens([{ content: '' }]), undefined)
  assert.equal(estimateTokens([{ content: [] }]), undefined)
  assert.equal(estimateTokens([null, undefined, 42]), undefined)
})

test('malformed message shapes degrade instead of throwing', () => {
  assert.doesNotThrow(() => estimateTokens([{ content: { text: 'x' } }]))
  assert.equal(estimateTokens([{ content: { text: 'x' } }]), undefined)
  assert.doesNotThrow(() => textLength(undefined))
  assert.equal(textLength(undefined), 0)
  assert.equal(textLength(12345), 0)
  assert.equal(textLength([{ text: 'abc' }, { noText: true }, null]), 3)
})
