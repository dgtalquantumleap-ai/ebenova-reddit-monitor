import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'
import {
  generateUnsubscribeToken,
  resolveUnsubscribeToken,
  setMonitorEmailEnabled,
  deleteMonitorAndData,
  logDeletion,
  removeResendContact,
  buildEmailFooter,
} from '../lib/account-deletion.js'

// Helper: fully-shaped monitor fixture
function fakeMonitor({ id = 'mon_test1', owner = 'user@example.com', token, ...overrides } = {}) {
  return {
    id, owner, name: 'Test monitor',
    keywords: [{ keyword: 'crm', subreddits: [], productContext: '' }],
    productContext: 'I run a CRM',
    alertEmail: owner,
    emailEnabled: true,
    unsubscribeToken: token || 'a'.repeat(64),
    active: true, plan: 'starter',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

async function seedMonitor(redis, mon) {
  await redis.set(`insights:monitor:${mon.id}`, JSON.stringify(mon))
  await redis.set(`unsubscribe:${mon.unsubscribeToken}`, mon.id)
  await redis.sadd('insights:active_monitors', mon.id)
  await redis.sadd(`insights:monitors:${mon.owner}`, mon.id)
}

// ── generateUnsubscribeToken ─────────────────────────────────────────────────

test('generateUnsubscribeToken: returns 64-char hex', () => {
  const t = generateUnsubscribeToken()
  assert.match(t, /^[a-f0-9]{64}$/)
})

test('generateUnsubscribeToken: each call returns a unique value', () => {
  const a = generateUnsubscribeToken()
  const b = generateUnsubscribeToken()
  const c = generateUnsubscribeToken()
  assert.notEqual(a, b)
  assert.notEqual(b, c)
  assert.notEqual(a, c)
})

// ── resolveUnsubscribeToken ──────────────────────────────────────────────────

test('resolveUnsubscribeToken: returns null for missing token', async () => {
  const redis = createMockRedis()
  assert.equal(await resolveUnsubscribeToken(redis, ''), null)
  assert.equal(await resolveUnsubscribeToken(redis, null), null)
  assert.equal(await resolveUnsubscribeToken(redis, undefined), null)
})

test('resolveUnsubscribeToken: rejects malformed tokens (not 64-hex)', async () => {
  const redis = createMockRedis()
  assert.equal(await resolveUnsubscribeToken(redis, 'short'), null)
  assert.equal(await resolveUnsubscribeToken(redis, 'g'.repeat(64)), null) // not hex
  assert.equal(await resolveUnsubscribeToken(redis, 'a'.repeat(63)), null) // wrong length
})

test('resolveUnsubscribeToken: returns null when token has no monitor mapping', async () => {
  const redis = createMockRedis()
  assert.equal(await resolveUnsubscribeToken(redis, 'a'.repeat(64)), null)
})

test('resolveUnsubscribeToken: returns monitor for valid token', async () => {
  const redis = createMockRedis()
  const mon = fakeMonitor()
  await seedMonitor(redis, mon)
  const r = await resolveUnsubscribeToken(redis, mon.unsubscribeToken)
  assert.equal(r.monitorId, 'mon_test1')
  assert.equal(r.monitor.name, 'Test monitor')
})

// ── setMonitorEmailEnabled ──────────────────────────────────────────────────

test('setMonitorEmailEnabled: flips emailEnabled and persists', async () => {
  const redis = createMockRedis()
  const mon = fakeMonitor()
  await seedMonitor(redis, mon)
  await setMonitorEmailEnabled(redis, mon.id, false)
  const after = JSON.parse(await redis.get(`insights:monitor:${mon.id}`))
  assert.equal(after.emailEnabled, false)
  await setMonitorEmailEnabled(redis, mon.id, true)
  const reverted = JSON.parse(await redis.get(`insights:monitor:${mon.id}`))
  assert.equal(reverted.emailEnabled, true)
})

test('setMonitorEmailEnabled: returns null for unknown monitor', async () => {
  const redis = createMockRedis()
  const r = await setMonitorEmailEnabled(redis, 'mon_nope', false)
  assert.equal(r, null)
})

// ── deleteMonitorAndData ─────────────────────────────────────────────────────

test('deleteMonitorAndData: removes monitor record + sets', async () => {
  const redis = createMockRedis()
  const mon = fakeMonitor()
  await seedMonitor(redis, mon)
  // Seed some matches too
  await redis.lpush(`insights:matches:${mon.id}`, 'post1', 'post2', 'post3')
  await redis.set(`insights:match:${mon.id}:post1`, JSON.stringify({ id: 'post1' }))
  await redis.set(`insights:match:${mon.id}:post2`, JSON.stringify({ id: 'post2' }))
  await redis.set(`insights:match:${mon.id}:post3`, JSON.stringify({ id: 'post3' }))

  const result = await deleteMonitorAndData(redis, mon.id)

  // Monitor record gone
  assert.equal(await redis.get(`insights:monitor:${mon.id}`), null)
  // Match list gone
  assert.deepEqual(await redis.lrange(`insights:matches:${mon.id}`, 0, -1), [])
  // Individual match records gone
  assert.equal(await redis.get(`insights:match:${mon.id}:post1`), null)
  assert.equal(await redis.get(`insights:match:${mon.id}:post2`), null)
  // Token reverse-index gone
  assert.equal(await redis.get(`unsubscribe:${mon.unsubscribeToken}`), null)
  // Active set no longer contains the id
  assert.equal((await redis.smembers('insights:active_monitors')).includes(mon.id), false)
  // Owner set no longer contains the id
  assert.equal((await redis.smembers(`insights:monitors:${mon.owner}`)).includes(mon.id), false)

  assert.ok(result.deleted.includes('monitor_record'))
  assert.ok(result.deleted.includes('unsubscribe_token'))
})

test('deleteMonitorAndData: full account wipe when owner has no other monitors', async () => {
  const redis = createMockRedis()
  const mon = fakeMonitor({ owner: 'solo@example.com' })
  await seedMonitor(redis, mon)
  // Seed apikey + signup records
  await redis.set('insights:signup:solo@example.com', JSON.stringify({ key: 'ins_solokey', email: 'solo@example.com' }))
  await redis.set('apikey:ins_solokey', JSON.stringify({ owner: 'solo@example.com', insights: true }))

  const result = await deleteMonitorAndData(redis, mon.id)

  assert.equal(result.accountAlsoDeleted, true)
  assert.equal(await redis.get('apikey:ins_solokey'), null)
  assert.equal(await redis.get('insights:signup:solo@example.com'), null)
  assert.ok(result.deleted.includes('apikey_record'))
  assert.ok(result.deleted.includes('signup_record'))
})

test('deleteMonitorAndData: keeps account when owner has other monitors', async () => {
  const redis = createMockRedis()
  const mon1 = fakeMonitor({ id: 'mon_a', owner: 'multi@example.com' })
  const mon2 = fakeMonitor({ id: 'mon_b', owner: 'multi@example.com', token: 'b'.repeat(64) })
  await seedMonitor(redis, mon1)
  await seedMonitor(redis, mon2)
  await redis.set('insights:signup:multi@example.com', JSON.stringify({ key: 'ins_multikey' }))
  await redis.set('apikey:ins_multikey', JSON.stringify({ owner: 'multi@example.com' }))

  const result = await deleteMonitorAndData(redis, mon1.id)

  assert.equal(result.accountAlsoDeleted, false)
  // apikey + signup still present
  assert.notEqual(await redis.get('apikey:ins_multikey'), null)
  assert.notEqual(await redis.get('insights:signup:multi@example.com'), null)
  // mon_b still present
  assert.notEqual(await redis.get(`insights:monitor:${mon2.id}`), null)
})

test('deleteMonitorAndData: returns errors[] when monitor missing, no throw', async () => {
  const redis = createMockRedis()
  const result = await deleteMonitorAndData(redis, 'mon_does_not_exist')
  assert.equal(result.deleted.length, 0)
  assert.ok(result.errors.some(e => e.includes('not found')))
})

// ── logDeletion ─────────────────────────────────────────────────────────────

test('logDeletion: writes a record with no PII', async () => {
  const redis = createMockRedis()
  const r = await logDeletion(redis, { monitorId: 'mon_xyz789abc', reason: 'user_request' })
  assert.equal(r.logged, true)
  const log = JSON.parse(await redis.get(r.key))
  assert.equal(log.monitorId, 'mon_xyz789abc')
  assert.equal(log.reason, 'user_request')
  assert.ok(log.deletedAt)
  // No email or other PII
  assert.equal(log.email, undefined)
  assert.equal(log.owner, undefined)
})

test('logDeletion: defaults reason to user_request', async () => {
  const redis = createMockRedis()
  const r = await logDeletion(redis, { monitorId: 'mon_x' })
  const log = JSON.parse(await redis.get(r.key))
  assert.equal(log.reason, 'user_request')
})

// ── removeResendContact ─────────────────────────────────────────────────────

test('removeResendContact: returns no_resend_key when key missing', async () => {
  delete process.env.RESEND_API_KEY
  const r = await removeResendContact({ email: 'a@x.com' })
  assert.equal(r.removed, false)
  assert.equal(r.reason, 'no_resend_key')
})

test('removeResendContact: returns no_audience_configured when audience id missing', async () => {
  process.env.RESEND_API_KEY = 'test'
  delete process.env.RESEND_AUDIENCE_ID
  const r = await removeResendContact({ email: 'a@x.com' })
  assert.equal(r.removed, false)
  assert.equal(r.reason, 'no_audience_configured')
  delete process.env.RESEND_API_KEY
})

test('removeResendContact: hits Resend DELETE when both configured', async () => {
  process.env.RESEND_API_KEY = 'test'
  process.env.RESEND_AUDIENCE_ID = 'aud_123'
  const originalFetch = global.fetch
  let captured
  global.fetch = async (url, opts) => {
    captured = { url, method: opts.method }
    return { ok: true, status: 200 }
  }
  try {
    const r = await removeResendContact({ email: 'a@x.com' })
    assert.equal(r.removed, true)
    assert.equal(captured.method, 'DELETE')
    assert.ok(captured.url.includes('aud_123'))
    assert.ok(captured.url.includes(encodeURIComponent('a@x.com')))
  } finally {
    global.fetch = originalFetch
    delete process.env.RESEND_API_KEY
    delete process.env.RESEND_AUDIENCE_ID
  }
})

test('removeResendContact: handles 404 gracefully', async () => {
  process.env.RESEND_API_KEY = 'test'
  process.env.RESEND_AUDIENCE_ID = 'aud_123'
  const originalFetch = global.fetch
  global.fetch = async () => ({ ok: false, status: 404 })
  try {
    const r = await removeResendContact({ email: 'a@x.com' })
    assert.equal(r.removed, false)
    assert.equal(r.reason, 'contact_not_in_audience')
  } finally {
    global.fetch = originalFetch
    delete process.env.RESEND_API_KEY
    delete process.env.RESEND_AUDIENCE_ID
  }
})

test('removeResendContact: never throws on network error', async () => {
  process.env.RESEND_API_KEY = 'test'
  process.env.RESEND_AUDIENCE_ID = 'aud_123'
  const originalFetch = global.fetch
  global.fetch = async () => { throw new Error('network') }
  try {
    const r = await removeResendContact({ email: 'a@x.com' })
    assert.equal(r.removed, false)
    assert.equal(r.reason, 'network_error')
  } finally {
    global.fetch = originalFetch
    delete process.env.RESEND_API_KEY
    delete process.env.RESEND_AUDIENCE_ID
  }
})

// ── buildEmailFooter ─────────────────────────────────────────────────────────

test('buildEmailFooter: includes both unsubscribe and delete-account links when token present', () => {
  const html = buildEmailFooter('a'.repeat(64))
  assert.ok(html.includes('/unsubscribe?token='))
  assert.ok(html.includes('/delete-account?token='))
  assert.ok(html.includes('Unsubscribe from these alerts'))
  assert.ok(html.includes('Delete my account'))
})

test('buildEmailFooter: includes CASL/NDPR compliance line', () => {
  const html = buildEmailFooter('a'.repeat(64))
  assert.ok(html.includes('CASL'))
  assert.ok(html.includes('NDPR'))
})

test('buildEmailFooter: degrades gracefully when token missing', () => {
  const html = buildEmailFooter(null)
  assert.ok(!html.includes('/unsubscribe?token='))
  assert.ok(html.includes('CASL'))  // compliance line still present
  assert.ok(html.includes('sign in to your dashboard'))
})

test('buildEmailFooter: respects APP_URL env override', () => {
  process.env.APP_URL = 'https://example.com'
  try {
    const html = buildEmailFooter('a'.repeat(64))
    assert.ok(html.includes('https://example.com/unsubscribe?token='))
    assert.ok(html.includes('https://example.com/delete-account?token='))
  } finally {
    delete process.env.APP_URL
  }
})
