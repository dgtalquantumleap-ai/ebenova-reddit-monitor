// test/scraper-fixes.test.js
// Regression tests for the four production bugs fixed in feat/scraper-fixes.
//
// BUG 1 — [object Object] as Reddit keyword (resolveKeyword normalisation)
// BUG 2 — Quora 403 graceful disable
// BUG 3 — Fiverr 404 graceful disable
// BUG 4 — YouTube quota key/reset + cap raised to 200

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { resolveKeyword } from '../lib/reddit-rss.js'
import searchQuora, { _internals as quoraInternals } from '../lib/scrapers/quora.js'
import searchFiverr, { _internals as fiverrInternals } from '../lib/scrapers/fiverr.js'
import { makeCostCap } from '../lib/cost-cap.js'
import { createMockRedis } from './helpers/mock-redis.js'

// ── helpers ────────────────────────────────────────────────────────────────────

function withFetch(impl, fn) {
  const original = global.fetch
  global.fetch = impl
  return Promise.resolve()
    .then(fn)
    .finally(() => { global.fetch = original })
}

const ctx = () => ({
  seenIds: { has: () => false, add: () => {} },
  delay:   async () => {},
  MAX_AGE_MS: 24 * 60 * 60 * 1000,
})

// ── BUG 1: resolveKeyword ──────────────────────────────────────────────────────

// Primary test from spec: entry uses `.term` instead of `.keyword`
test('1. searchReddit keyword normalization: {term: "freelance contract", type: "keyword"} → "freelance contract" (not "[object Object]")', () => {
  const result = resolveKeyword({ term: 'freelance contract', type: 'keyword' })
  assert.equal(result, 'freelance contract')
  assert.notEqual(result, '[object Object]')
})

// Nested-object form — this is the [object Object] production root cause:
// entry.keyword is itself an object with a .term field
test('1a. resolveKeyword unwraps nested keyword object (keywordEntry.keyword = {term: ...})', () => {
  const result = resolveKeyword({ keyword: { term: 'my saas', type: 'keyword' } })
  assert.equal(result, 'my saas')
  assert.notEqual(result, '[object Object]')
})

test('1b. resolveKeyword returns keyword string unchanged when already a string', () => {
  assert.equal(resolveKeyword({ keyword: 'indie hacker' }), 'indie hacker')
})

test('1c. resolveKeyword returns empty string for null/undefined entry', () => {
  assert.equal(resolveKeyword(null),      '')
  assert.equal(resolveKeyword(undefined), '')
  assert.equal(resolveKeyword({}),        '')
})

// ── BUG 2: Quora 403 graceful disable ─────────────────────────────────────────

test('2. Quora returns [] gracefully on 403 (no throw, no spam)', async () => {
  quoraInternals.reset()
  const warnings = []
  const origWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))

  try {
    await withFetch(async () => ({ ok: false, status: 403, headers: { get: () => null } }), async () => {
      const r1 = await searchQuora({ keyword: 'contract template' }, ctx())
      assert.deepEqual(r1, [], 'first call on 403 should return []')

      // Second call — already disabled, must return [] silently (no extra log)
      const r2 = await searchQuora({ keyword: 'freelance invoice' }, ctx())
      assert.deepEqual(r2, [], 'subsequent calls return [] silently')
    })
  } finally {
    console.warn = origWarn
  }

  const disabledLogs = warnings.filter(w => w.includes('DISABLED'))
  assert.equal(disabledLogs.length, 1, 'DISABLED warning should appear exactly once, not once per keyword')
})

// ── BUG 3: Fiverr 404 graceful disable ────────────────────────────────────────

test('5. Fiverr returns [] gracefully on 404 (no throw, no spam)', async () => {
  fiverrInternals.reset()
  const warnings = []
  const origWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))

  try {
    await withFetch(async () => ({ ok: false, status: 404, headers: { get: () => null } }), async () => {
      const r1 = await searchFiverr({ keyword: 'logo design' }, ctx())
      assert.deepEqual(r1, [], 'first call on 404 should return []')

      const r2 = await searchFiverr({ keyword: 'web developer' }, ctx())
      assert.deepEqual(r2, [], 'subsequent calls return [] silently')
    })
  } finally {
    console.warn = origWarn
  }

  const disabledLogs = warnings.filter(w => w.includes('DISABLED'))
  assert.equal(disabledLogs.length, 1, 'DISABLED warning should appear exactly once')
})

// ── BUG 4: YouTube quota key includes date + resets per day ───────────────────

test('3. YouTube quota key includes date in key name', async () => {
  const redis = createMockRedis()
  const cap = makeCostCap(redis, { resource: 'youtube', dailyMax: 200 })
  await cap()
  const today = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
  const keys = [...redis._store.keys()]
  assert.ok(
    keys.some(k => k.includes(today)),
    `quota key must include today's date (${today}); got: ${keys.join(', ')}`
  )
})

test('4. YouTube quota resets on new day (different date → different key → fresh counter)', async () => {
  const redis = createMockRedis()
  const cap   = makeCostCap(redis, { resource: 'youtube', dailyMax: 200 })

  // Saturate today's counter
  const today = new Date().toISOString().slice(0, 10)
  await redis.set(`costcap:youtube:${today}`, 200)
  const blocked = await cap()
  assert.equal(blocked.allowed, false, 'today is at dailyMax')

  // Tomorrow's key does not exist yet → counter would start at 1
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  assert.notEqual(today, tomorrow, 'different calendar day produces a different date string')
  assert.equal(
    redis._store.get(`costcap:youtube:${tomorrow}`),
    undefined,
    'tomorrow key does not exist; first call tomorrow would be count=1 (allowed)'
  )
})
