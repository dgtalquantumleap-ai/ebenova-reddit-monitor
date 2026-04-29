import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { buildPayload, sendOutboundWebhook, fireWebhook } from '../lib/outbound-webhook.js'

// ── buildPayload ───────────────────────────────────────────────────────────

test('buildPayload: throws when monitorId is missing', () => {
  assert.throws(() => buildPayload({ event: 'new_match', match: {} }), /monitorId required/)
})

test('buildPayload: includes only documented match fields, no internals', () => {
  const match = {
    id: 'm1', title: 'T', url: 'https://x.com/a/status/1', subreddit: 'SaaS',
    author: 'alex', score: 10, comments: 2,
    body: 'b', createdAt: '2026-04-29T10:00:00Z',
    keyword: 'kw', source: 'reddit',
    sentiment: 'positive', intent: 'asking_for_tool', intentConfidence: 0.91,
    draft: 'sample reply', approved: true,
    // Internals that must NOT leak:
    productContext: 'secret context', storedAt: '...', monitorId: 'leak', draftedBy: 'groq',
  }
  const p = buildPayload({ event: 'new_match', monitorId: 'mon_xyz', match, sentAt: '2026-04-29T10:05:00Z' })
  assert.equal(p.event, 'new_match')
  assert.equal(p.monitorId, 'mon_xyz')
  assert.equal(p.sentAt, '2026-04-29T10:05:00Z')
  // Match fields present
  assert.equal(p.match.id, 'm1')
  assert.equal(p.match.sentiment, 'positive')
  assert.equal(p.match.intent, 'asking_for_tool')
  assert.equal(p.match.draft, 'sample reply')
  assert.equal(p.match.approved, true)
  // Computed
  assert.equal(typeof p.match.postAgeHours, 'number')
  // Internals must NOT be in payload
  assert.equal('productContext' in p.match, false)
  assert.equal('storedAt' in p.match, false)
  assert.equal('draftedBy' in p.match, false)
})

test('buildPayload: defaults sentAt to now when omitted', () => {
  const before = Date.now()
  const p = buildPayload({ event: 'test', monitorId: 'mon_xyz', match: null })
  const sent = new Date(p.sentAt).getTime()
  assert.ok(sent >= before && sent <= Date.now() + 50)
  assert.equal(p.match, null)
})

test('buildPayload: nulls sentiment/intent/draft when match lacks them', () => {
  const p = buildPayload({
    event: 'new_match', monitorId: 'mon_xyz',
    match: { id: 'm', title: 't', url: 'u', subreddit: 's', author: 'a', score: 0, comments: 0, body: 'b', createdAt: new Date().toISOString(), keyword: 'k', source: 'reddit', approved: true },
  })
  assert.equal(p.match.sentiment, null)
  assert.equal(p.match.intent, null)
  assert.equal(p.match.intentConfidence, null)
  assert.equal(p.match.draft, null)
})

// ── sendOutboundWebhook validation paths ───────────────────────────────────

test('sendOutboundWebhook: rejects empty url', async () => {
  assert.deepEqual(await sendOutboundWebhook('', {}), { delivered: false, reason: 'no-url' })
  assert.deepEqual(await sendOutboundWebhook(null, {}), { delivered: false, reason: 'no-url' })
})

test('sendOutboundWebhook: rejects unparseable url', async () => {
  assert.deepEqual(await sendOutboundWebhook('not a url', {}), { delivered: false, reason: 'invalid-url' })
})

test('sendOutboundWebhook: rejects http:// (https only)', async () => {
  assert.deepEqual(await sendOutboundWebhook('http://example.com/hook', {}), { delivered: false, reason: 'not-https' })
})

// ── sendOutboundWebhook against a local HTTPS-rejecting target ─────────────
// We can't easily spin up an HTTPS server in a test, but we can verify the
// timeout + network-error paths by pointing at a definitely-blackholed URL.

test('sendOutboundWebhook: respects timeout', async () => {
  // Use TEST-NET-1 (RFC 5737) — guaranteed not to route, so the request hangs
  // until our timeout aborts it. 200ms is plenty.
  const r = await sendOutboundWebhook('https://192.0.2.1/', {}, { timeoutMs: 200 })
  assert.equal(r.delivered, false)
  assert.equal(r.reason, 'network')
  assert.match(r.error, /timeout|abort|aborted/i)
})

// ── fireWebhook is fire-and-forget ─────────────────────────────────────────

test('fireWebhook: returns synchronously (does not throw, does not return a Promise we need)', () => {
  // Intentional: pass an https URL that will fail. fireWebhook should not throw.
  const r = fireWebhook('https://192.0.2.1/', { event: 'test', monitorId: 'm', match: null }, 'm')
  // Spec says fire-and-forget — return value isn't part of the contract.
  // Critical assertion: the call itself doesn't throw synchronously.
  assert.equal(r, undefined)
})

test('fireWebhook: invalid url does not throw, just logs', () => {
  const r = fireWebhook(null, { event: 'test', monitorId: 'm', match: null }, 'm')
  assert.equal(r, undefined)
})
