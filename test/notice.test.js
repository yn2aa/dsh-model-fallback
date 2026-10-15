/**
 * Tests for the in-session failover notice (task 5.6).
 *
 * The notice is what makes a redirect visible to the user in the conversation
 * itself, not only in the plugin's settings page. Its runtime shape has to
 * satisfy the session's `assertMessageEventShape`: a string id, role `user`, a
 * non-empty string `source.kind`, and a `content` array.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  boundSummary, triggerLabel, noticeMessage, createNotices, SUMMARY_LIMIT, PENDING_LIMIT,
} from '../lib/notice.js'

const record = (over = {}) => ({
  turn: 3, step: 1,
  from: 'raccoon/sn-deepseek-v4-1-flash',
  to: 'workbuddy/deepseek-v4.1-flash',
  trigger: 'rate_limit',
  reason: 'failover',
  skipped: [],
  failure: { code: 'RATE_LIMIT', message: 'rate limit reached for TPM' },
  ...over,
})

test('a notice names the original model, the substitute, and the original failure', () => {
  const message = noticeMessage(record())
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'model-fallback')
  assert.equal(message.source.form, 'notice')
  const text = message.content.map((part) => part.text).join('')
  assert.ok(text.includes('raccoon/sn-deepseek-v4-1-flash'), text)
  assert.ok(text.includes('workbuddy/deepseek-v4.1-flash'), text)
  // The ORIGINAL failure must survive: the user needs to know why the primary
  // was abandoned, not just that it was.
  assert.ok(text.includes('rate limit reached for TPM'), text)
})

test('the notice text labels each trigger kind in the user-facing language', () => {
  assert.equal(triggerLabel('rate_limit'), '限流')
  assert.equal(triggerLabel('server_error'), '服务端错误')
  assert.equal(triggerLabel('timeout_network'), '超时或网络错误')
  assert.equal(triggerLabel('anything'), '请求失败')
  assert.equal(triggerLabel(null), '请求失败')
})

test('the notice satisfies the session message shape the kernel asserts', () => {
  const message = noticeMessage(record())
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
  assert.equal(typeof message.source.kind, 'string')
  assert.ok(message.source.kind.length > 0)
  assert.ok(Array.isArray(message.content))
  assert.equal(message.content[0].type, 'text')
  // The whole message must be JSON-serialisable: the session rejects non-JSON data.
  assert.doesNotThrow(() => JSON.stringify(message))
})

test('a notice with no usable route is refused rather than emitted half-formed', () => {
  assert.equal(noticeMessage(null), null)
  assert.equal(noticeMessage(undefined), null)
  assert.equal(noticeMessage({}), null)
  assert.equal(noticeMessage(record({ from: '' })), null)
  assert.equal(noticeMessage(record({ to: null })), null)
})

test('a notice still stands when the failure carried no message', () => {
  const message = noticeMessage(record({ trigger: 'server_error', failure: { code: 'SERVER' } }))
  assert.notEqual(message, null)
  const text = message.content.map((part) => part.text).join('')
  // The label still names the failure class; only the raw reason is omitted.
  assert.ok(text.includes('服务端错误'), text)
  assert.ok(!text.includes('原始失败原因'), text)
})

test('the summary is bounded the way the kernel bounds its own', () => {
  assert.equal(boundSummary('short'), 'short')
  const long = 'x'.repeat(500)
  const bounded = boundSummary(long)
  assert.equal(bounded.length, SUMMARY_LIMIT)
  assert.ok(bounded.endsWith('…'))
})

test('a notice is emitted exactly once per failover', () => {
  const notices = createNotices()
  assert.equal(notices.mark('s1', record()), true)
  assert.equal(notices.has('s1'), true)
  const first = notices.take('s1')
  assert.notEqual(first, null)
  assert.equal(notices.has('s1'), false)
  // Taking again must not repeat the notice.
  assert.equal(notices.take('s1'), null)
})

test('a second failover replaces the first pending notice for the same session', () => {
  const notices = createNotices()
  notices.mark('s1', record({ to: 'buddy/deepseek-v4-flash' }))
  notices.mark('s1', record({ to: 'buddy/deepseek-v4-pro' }))
  assert.equal(notices.size(), 1)
  const message = notices.take('s1')
  assert.ok(message.content.map((p) => p.text).join('').includes('buddy/deepseek-v4-pro'))
})

test('notices for different sessions are independent', () => {
  const notices = createNotices()
  notices.mark('s1', record())
  notices.mark('s2', record())
  assert.equal(notices.size(), 2)
  assert.notEqual(notices.take('s1'), null)
  assert.equal(notices.has('s2'), true)
})

test('a notice cannot be queued without a session or a describable record', () => {
  const notices = createNotices()
  assert.equal(notices.mark('', record()), false)
  assert.equal(notices.mark(undefined, record()), false)
  assert.equal(notices.mark('s1', {}), false)
  assert.equal(notices.size(), 0)
  assert.equal(notices.take(''), null)
  assert.equal(notices.take(undefined), null)
})

test('the pending queue stays bounded over a long session', () => {
  const notices = createNotices({ limit: 8 })
  for (let i = 0; i < 50; i += 1) notices.mark(`s${i}`, record())
  assert.ok(notices.size() <= 8)
  // The newest survive; the oldest are the ones dropped.
  assert.equal(notices.has('s49'), true)
  assert.equal(notices.has('s0'), false)
})

test('the default pending limit is the documented one', () => {
  assert.equal(PENDING_LIMIT, 64)
})
