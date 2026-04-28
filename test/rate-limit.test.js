import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'
import { makeRateLimiter } from '../lib/rate-limit.js'

test('allows up to N requests within the window', async () => {
  const redis = createMockRedis()
  const limit = makeRateLimiter(redis, { max: 3, windowSeconds: 60 })
  for (let i = 0; i < 3; i++) {
    const r = await limit('ip:1.1.1.1')
    assert.equal(r.allowed, true, `request ${i+1} should be allowed`)
  }
  const r4 = await limit('ip:1.1.1.1')
  assert.equal(r4.allowed, false)
  assert.equal(r4.retryAfterSeconds > 0, true)
})

test('different keys are tracked independently', async () => {
  const redis = createMockRedis()
  const limit = makeRateLimiter(redis, { max: 2, windowSeconds: 60 })
  await limit('ip:1.1.1.1')
  await limit('ip:1.1.1.1')
  const r1 = await limit('ip:1.1.1.1')
  assert.equal(r1.allowed, false)
  const r2 = await limit('ip:2.2.2.2')
  assert.equal(r2.allowed, true)
})
