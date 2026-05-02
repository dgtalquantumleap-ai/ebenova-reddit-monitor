import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { updateKeywordHealth, getKeywordHealth, getStaleKeywords } from '../lib/keyword-health.js'

// ── getStaleKeywords (pure function, no Redis needed) ─────────────────────────

test('getStaleKeywords: keyword not in health → never stale', () => {
  assert.deepEqual(getStaleKeywords({}, ['unknown-kw']), [])
})

test('getStaleKeywords: keyword seen but too new (< 30 days) → not stale', () => {
  const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
  const health = { 'scope creep': { firstSeenAt: recent, lastMatchAt: null, totalMatches: 0 } }
  assert.deepEqual(getStaleKeywords(health, ['scope creep']), [])
})

test('getStaleKeywords: keyword seen 40 days ago, zero matches → stale', () => {
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  const health = { 'dead keyword': { firstSeenAt: old, lastMatchAt: null, totalMatches: 0 } }
  assert.deepEqual(getStaleKeywords(health, ['dead keyword']), ['dead keyword'])
})

test('getStaleKeywords: keyword seen 40 days ago, matched 35 days ago → stale', () => {
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  const staleMatch = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString()
  const health = { kw: { firstSeenAt: old, lastMatchAt: staleMatch, totalMatches: 3 } }
  assert.deepEqual(getStaleKeywords(health, ['kw']), ['kw'])
})

test('getStaleKeywords: keyword seen 40 days ago, matched 5 days ago → not stale', () => {
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
  const health = { kw: { firstSeenAt: old, lastMatchAt: recent, totalMatches: 12 } }
  assert.deepEqual(getStaleKeywords(health, ['kw']), [])
})

test('getStaleKeywords: custom staleDays threshold', () => {
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
  const health = { kw: { firstSeenAt: old, lastMatchAt: null, totalMatches: 0 } }
  assert.deepEqual(getStaleKeywords(health, ['kw'], 7), ['kw'])
  assert.deepEqual(getStaleKeywords(health, ['kw'], 14), [])
})

test('getStaleKeywords: only returns keywords in the supplied list', () => {
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  const health = {
    'kw-a': { firstSeenAt: old, lastMatchAt: null, totalMatches: 0 },
    'kw-b': { firstSeenAt: old, lastMatchAt: null, totalMatches: 0 },
  }
  assert.deepEqual(getStaleKeywords(health, ['kw-a']), ['kw-a'])
})

// ── updateKeywordHealth + getKeywordHealth (Redis integration) ─────────────────

function makeFakeRedis() {
  const store = new Map()
  return {
    async get(k)          { return store.get(k) ?? null },
    async set(k, v)       { store.set(k, v) },
    async expire()        {},
  }
}

test('updateKeywordHealth: initialises firstSeenAt on first call', async () => {
  const redis = makeFakeRedis()
  const kws = new Map([['scope creep', 2], ['dead kw', 0]])
  await updateKeywordHealth(redis, 'mon1', kws)
  const h = await getKeywordHealth(redis, 'mon1')
  assert.ok(h['scope creep'].firstSeenAt)
  assert.ok(h['dead kw'].firstSeenAt)
})

test('updateKeywordHealth: sets lastMatchAt only when count > 0', async () => {
  const redis = makeFakeRedis()
  await updateKeywordHealth(redis, 'mon1', new Map([['matched', 3], ['silent', 0]]))
  const h = await getKeywordHealth(redis, 'mon1')
  assert.ok(h['matched'].lastMatchAt)
  assert.equal(h['silent'].lastMatchAt, null)
})

test('updateKeywordHealth: accumulates totalMatches across calls', async () => {
  const redis = makeFakeRedis()
  await updateKeywordHealth(redis, 'mon1', new Map([['kw', 5]]))
  await updateKeywordHealth(redis, 'mon1', new Map([['kw', 3]]))
  const h = await getKeywordHealth(redis, 'mon1')
  assert.equal(h['kw'].totalMatches, 8)
})

test('getKeywordHealth: returns {} when no data exists', async () => {
  const redis = makeFakeRedis()
  const h = await getKeywordHealth(redis, 'nonexistent')
  assert.deepEqual(h, {})
})
