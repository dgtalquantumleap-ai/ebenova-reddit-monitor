import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'
import { makeFindCache } from '../lib/find-cache.js'

test('cache.set then cache.get returns the value', async () => {
  const redis = createMockRedis()
  const cache = makeFindCache(redis)
  await cache.set('Looking for SEO Agency', { count: 31, samples: [] })
  const r = await cache.get('Looking for SEO Agency')
  assert.equal(r.count, 31)
})

test('cache key is normalized to lowercase + trimmed', async () => {
  const redis = createMockRedis()
  const cache = makeFindCache(redis)
  await cache.set('  Looking For SEO Agency  ', { count: 31, samples: [] })
  const r = await cache.get('looking for seo agency')
  assert.equal(r.count, 31)
})

test('cache.get returns null for missing key', async () => {
  const redis = createMockRedis()
  const cache = makeFindCache(redis)
  assert.equal(await cache.get('not-cached'), null)
})

test('cache.getMany returns map of all keywords', async () => {
  const redis = createMockRedis()
  const cache = makeFindCache(redis)
  await cache.set('one', { count: 1, samples: [] })
  await cache.set('two', { count: 2, samples: [] })
  const map = await cache.getMany(['one', 'two', 'three'])
  assert.equal(map.one.count, 1)
  assert.equal(map.two.count, 2)
  assert.equal(map.three, null)
})
