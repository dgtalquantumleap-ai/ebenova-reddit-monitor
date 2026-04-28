import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'
import { makeCostCap } from '../lib/cost-cap.js'

test('allows up to dailyMax', async () => {
  const redis = createMockRedis()
  const cap = makeCostCap(redis, { resource: 'test1', dailyMax: 3 })
  const r1 = await cap()
  const r2 = await cap()
  const r3 = await cap()
  assert.equal(r1.allowed, true)
  assert.equal(r2.allowed, true)
  assert.equal(r3.allowed, true)
  assert.equal(r3.used, 3)
  assert.equal(r3.max, 3)
})

test('blocks at dailyMax + 1', async () => {
  const redis = createMockRedis()
  const cap = makeCostCap(redis, { resource: 'test2', dailyMax: 2 })
  await cap()
  await cap()
  const r3 = await cap()
  assert.equal(r3.allowed, false)
  assert.equal(r3.used, 3)
})

test('separate resources counted independently', async () => {
  const redis = createMockRedis()
  const a = makeCostCap(redis, { resource: 'a', dailyMax: 1 })
  const b = makeCostCap(redis, { resource: 'b', dailyMax: 1 })
  await a()
  const ra = await a()
  const rb = await b()
  assert.equal(ra.allowed, false)
  assert.equal(rb.allowed, true)
})
