import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'
import { makeRedditCache, searchCacheKey } from '../lib/reddit-cache.js'

const ENTRY = { id: 't3_1', title: 'Hi', url: 'https://r/x/1', subreddit: 'x', author: 'a', body: '', createdAt: '2026-06-18T00:00:00Z' }

test('set then get returns the cached entries', async () => {
  const cache = makeRedditCache(createMockRedis())
  await cache.set({ keyword: 'ai receptionist', subreddit: 'smallbusiness' }, [ENTRY])
  const r = await cache.get({ keyword: 'ai receptionist', subreddit: 'smallbusiness' })
  assert.ok(Array.isArray(r))
  assert.equal(r.length, 1)
  assert.equal(r[0].id, 't3_1')
})

test('get returns null on a miss', async () => {
  const cache = makeRedditCache(createMockRedis())
  assert.equal(await cache.get({ keyword: 'never cached' }), null)
})

test('different subreddit → different key → miss', async () => {
  const cache = makeRedditCache(createMockRedis())
  await cache.set({ keyword: 'kw', subreddit: 'a' }, [ENTRY])
  assert.equal(await cache.get({ keyword: 'kw', subreddit: 'b' }), null)
  assert.ok(await cache.get({ keyword: 'kw', subreddit: 'a' }))
})

test('key is normalized (case + r/ prefix insensitive)', () => {
  assert.equal(
    searchCacheKey({ keyword: '  AI Receptionist ', subreddit: 'r/SmallBusiness', type: 'keyword' }),
    searchCacheKey({ keyword: 'ai receptionist', subreddit: 'smallbusiness', type: 'keyword' })
  )
})

test('keyword type is part of the key', () => {
  assert.notEqual(
    searchCacheKey({ keyword: 'okta', subreddit: 'sub', type: 'keyword' }),
    searchCacheKey({ keyword: 'okta', subreddit: 'sub', type: 'competitor' })
  )
})

test('null redis is safe (get null, set no-op)', async () => {
  const cache = makeRedditCache(null)
  await cache.set({ keyword: 'kw' }, [ENTRY]) // must not throw
  assert.equal(await cache.get({ keyword: 'kw' }), null)
})

test('non-array entries are not stored', async () => {
  const redis = createMockRedis()
  const cache = makeRedditCache(redis)
  await cache.set({ keyword: 'kw' }, null)
  await cache.set({ keyword: 'kw' }, { not: 'an array' })
  assert.equal(await cache.get({ keyword: 'kw' }), null)
})
