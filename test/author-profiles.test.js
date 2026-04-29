import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { isPlaceholderAuthor, recordAuthor } from '../lib/author-profiles.js'

// ── isPlaceholderAuthor ────────────────────────────────────────────────────

test('isPlaceholderAuthor: rejects empty / null / undefined', () => {
  assert.equal(isPlaceholderAuthor(null,      'reddit'), true)
  assert.equal(isPlaceholderAuthor(undefined, 'reddit'), true)
  assert.equal(isPlaceholderAuthor('',        'reddit'), true)
  assert.equal(isPlaceholderAuthor('   ',     'reddit'), true)
})

test('isPlaceholderAuthor: rejects "unknown" (HN/Twitter fallback)', () => {
  assert.equal(isPlaceholderAuthor('unknown',   'hackernews'), true)
  assert.equal(isPlaceholderAuthor('UNKNOWN',   'twitter'),    true)
  assert.equal(isPlaceholderAuthor(' unknown ', 'reddit'),     true)
})

test('isPlaceholderAuthor: rejects platform-name fallbacks (fiverr/quora/upwork/medium/substack)', () => {
  assert.equal(isPlaceholderAuthor('fiverr',   'fiverr'),   true)
  assert.equal(isPlaceholderAuthor('quora',    'quora'),    true)
  assert.equal(isPlaceholderAuthor('upwork',   'upwork'),   true)
  assert.equal(isPlaceholderAuthor('medium',   'medium'),   true)
  assert.equal(isPlaceholderAuthor('substack', 'substack'), true)
})

test('isPlaceholderAuthor: rejects single-character usernames', () => {
  assert.equal(isPlaceholderAuthor('a', 'reddit'), true)
})

test('isPlaceholderAuthor: rejects when author equals source even if not in list', () => {
  // Defensive: a future scraper might fall back to source name and we'd want
  // to skip it without explicitly adding it to PLACEHOLDER_AUTHORS.
  assert.equal(isPlaceholderAuthor('newplatform', 'newplatform'), true)
})

test('isPlaceholderAuthor: accepts a real username', () => {
  assert.equal(isPlaceholderAuthor('alex_indie',     'reddit'),  false)
  assert.equal(isPlaceholderAuthor('paul_graham',    'twitter'), false)
  assert.equal(isPlaceholderAuthor('octocat',        'github'),  false)
  assert.equal(isPlaceholderAuthor('founder_rae',    'twitter'), false)
})

test('isPlaceholderAuthor: trims whitespace before judging', () => {
  assert.equal(isPlaceholderAuthor('  alex_indie  ', 'reddit'), false)
})

// ── recordAuthor — mock-Redis happy paths ────────────────────────────────────

function makeMockRedis() {
  const store = new Map()
  return {
    store,
    async hgetall(key) { return store.get(key) ? { ...store.get(key) } : null },
    async hset(key, fields) {
      const cur = store.get(key) || {}
      store.set(key, { ...cur, ...fields })
    },
    async expire() { /* no-op for tests */ },
    async sadd(key, member) {
      const cur = store.get(key) || new Set()
      cur.add(member)
      store.set(key, cur)
    },
  }
}

test('recordAuthor: skips when author is a placeholder', async () => {
  const redis = makeMockRedis()
  const r = await recordAuthor({
    redis, monitorId: 'mon_x',
    match: { author: 'fiverr', source: 'fiverr', title: 't', url: 'u' },
  })
  assert.equal(r.recorded, false)
  assert.equal(r.reason, 'placeholder-author')
  assert.equal(redis.store.size, 0)
})

test('recordAuthor: skips when monitorId or match is missing', async () => {
  const redis = makeMockRedis()
  assert.equal((await recordAuthor({ redis })).recorded, false)
  assert.equal((await recordAuthor({ redis, monitorId: 'mon_x' })).recorded, false)
  assert.equal((await recordAuthor({ redis, match: { author: 'a', source: 's' } })).recorded, false)
})

test('recordAuthor: writes a fresh hash on first sighting', async () => {
  const redis = makeMockRedis()
  const r = await recordAuthor({
    redis, monitorId: 'mon_x',
    match: { author: 'alex_indie', source: 'twitter', title: 'A tweet', url: 'https://x.com/alex_indie/status/1', createdAt: '2026-01-01T00:00:00Z' },
  })
  assert.equal(r.recorded, true)
  assert.equal(r.isNew, true)
  assert.equal(r.postCount, 1)
  const stored = redis.store.get('author:profile:mon_x:twitter:alex_indie')
  assert.equal(stored.author, 'alex_indie')
  assert.equal(stored.platform, 'twitter')
  assert.equal(stored.firstSeen, '2026-01-01T00:00:00Z')
  assert.equal(stored.lastSeen, '2026-01-01T00:00:00Z')
  assert.equal(stored.postCount, '1')
  assert.equal(stored.latestPostTitle, 'A tweet')
  assert.equal(stored.latestPostUrl, 'https://x.com/alex_indie/status/1')
  assert.deepEqual(JSON.parse(stored.platforms), ['twitter'])
  // Index set
  assert.ok(redis.store.get('author:list:mon_x').has('twitter:alex_indie'))
})

test('recordAuthor: increments postCount on second sighting + preserves firstSeen', async () => {
  const redis = makeMockRedis()
  await recordAuthor({
    redis, monitorId: 'mon_x',
    match: { author: 'alex_indie', source: 'twitter', title: 'first', url: 'u1', createdAt: '2026-01-01T00:00:00Z' },
  })
  const r2 = await recordAuthor({
    redis, monitorId: 'mon_x',
    match: { author: 'alex_indie', source: 'twitter', title: 'second', url: 'u2', createdAt: '2026-02-01T00:00:00Z' },
  })
  assert.equal(r2.recorded, true)
  assert.equal(r2.isNew, false)
  assert.equal(r2.postCount, 2)
  const stored = redis.store.get('author:profile:mon_x:twitter:alex_indie')
  assert.equal(stored.firstSeen, '2026-01-01T00:00:00Z')   // preserved
  assert.equal(stored.lastSeen,  '2026-02-01T00:00:00Z')   // updated
  assert.equal(stored.latestPostTitle, 'second')
  assert.equal(stored.latestPostUrl,   'u2')
})

test('recordAuthor: handles two authors on two platforms independently', async () => {
  const redis = makeMockRedis()
  await recordAuthor({ redis, monitorId: 'mon_x', match: { author: 'alex',   source: 'reddit',  title: 't1', url: 'u1' } })
  await recordAuthor({ redis, monitorId: 'mon_x', match: { author: 'octocat',source: 'github',  title: 't2', url: 'u2' } })
  assert.ok(redis.store.has('author:profile:mon_x:reddit:alex'))
  assert.ok(redis.store.has('author:profile:mon_x:github:octocat'))
  const list = redis.store.get('author:list:mon_x')
  assert.ok(list.has('reddit:alex'))
  assert.ok(list.has('github:octocat'))
  assert.equal(list.size, 2)
})

test('recordAuthor: redis errors are caught (no throw, returns reason)', async () => {
  const broken = {
    async hgetall() { throw new Error('redis down') },
    async hset() {}, async expire() {}, async sadd() {},
  }
  const r = await recordAuthor({
    redis: broken, monitorId: 'mon_x',
    match: { author: 'alex', source: 'reddit', title: 't', url: 'u' },
  })
  assert.equal(r.recorded, false)
  assert.equal(r.reason, 'redis-error')
  assert.match(r.error, /redis down/)
})
