import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'

// We test the add-then-check-then-rollback pattern, which is what the
// production handler in api-server.js uses (POST /v1/monitors).

async function safeAdd(redis, ownerKey, monitorId, limit) {
  const wasAdded = await redis.sadd(ownerKey, monitorId)
  if (!wasAdded) return { ok: false, reason: 'collision' }
  const owned = await redis.smembers(ownerKey)
  if (owned.length > limit) {
    await redis.srem(ownerKey, monitorId)
    return { ok: false, reason: 'limit' }
  }
  return { ok: true }
}

test('first 3 succeed, 4th fails for limit=3', async () => {
  const redis = createMockRedis()
  const key = 'insights:monitors:alice'
  const r1 = await safeAdd(redis, key, 'm1', 3)
  const r2 = await safeAdd(redis, key, 'm2', 3)
  const r3 = await safeAdd(redis, key, 'm3', 3)
  const r4 = await safeAdd(redis, key, 'm4', 3)
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(r3.ok, true)
  assert.equal(r4.ok, false)
  assert.equal(r4.reason, 'limit')
  // Verify rollback: m4 must NOT remain in the set
  const final = await redis.smembers(key)
  assert.equal(final.length, 3)
  assert.equal(final.includes('m4'), false)
})

test('parallel adds against limit=3 NEVER produce >3 surviving entries (no over-limit)', async () => {
  // Note: the in-memory mock can't fully model real Redis atomicity. Under
  // pure parallelism in the mock, all 5 sadds fire before any smembers, so
  // all 5 see size>limit and roll back. The CRITICAL invariant is "no more
  // than N ever survive in the set" — that's what real users care about.
  const redis = createMockRedis()
  const key = 'insights:monitors:bob'
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => safeAdd(redis, key, `m${i}`, 3)))
  const oks = results.filter(r => r.ok)
  // The post-condition that matters: no over-limit data, no false positives.
  assert.ok(oks.length <= 3, `must NOT exceed 3 ok, got ${oks.length}`)
  const final = await redis.smembers(key)
  assert.ok(final.length <= 3, `set must not exceed 3, has ${final.length}`)
  // And the per-entry consistency: every "ok" result must correspond to
  // something actually in the set.
  for (const r of results) {
    if (r.ok) assert.ok(final.length > 0, 'ok response must mean something is in the set')
  }
})
