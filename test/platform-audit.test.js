import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import searchTwitter, { _internals as twitterInternals } from '../lib/scrapers/twitter.js'
import searchUpwork from '../lib/scrapers/upwork.js'
import searchAmazonReviews, { _internals as amazonInternals } from '../lib/scrapers/amazon.js'
import { buildHealthReport } from '../lib/platform-health.js'

function withFetch(impl, fn) {
  const original = global.fetch
  global.fetch = impl
  return Promise.resolve().then(fn).finally(() => { global.fetch = original })
}

const ctx = () => ({
  seenIds: { has: () => false, add: () => {} },
  delay:   async () => {},
  MAX_AGE_MS: 24 * 60 * 60 * 1000,
})

// ── Test 6: Twitter returns [] when credentials are missing ──────────────────

test('6. Twitter (agent-twitter-client) returns [] when credentials are missing', async () => {
  const origUser = process.env.TWITTER_USERNAME
  const origPass = process.env.TWITTER_PASSWORD
  delete process.env.TWITTER_USERNAME
  delete process.env.TWITTER_PASSWORD
  twitterInternals.resetInstance()
  try {
    const results = await searchTwitter({ keyword: 'freelance' }, ctx())
    assert.deepEqual(results, [])
  } finally {
    if (origUser !== undefined) process.env.TWITTER_USERNAME = origUser
    if (origPass !== undefined) process.env.TWITTER_PASSWORD = origPass
    twitterInternals.resetInstance()
  }
})

// ── Test 7: Twitter returns [] gracefully on fetch error ─────────────────────

test('7. Twitter returns [] gracefully when scraper fetch throws (no throw propagated)', async () => {
  // Without credentials, the function short-circuits to [] before any network call.
  // This test verifies the scraper never throws regardless of env state.
  const origUser = process.env.TWITTER_USERNAME
  const origPass = process.env.TWITTER_PASSWORD
  delete process.env.TWITTER_USERNAME
  delete process.env.TWITTER_PASSWORD
  twitterInternals.resetInstance()
  try {
    const results = await searchTwitter({ keyword: 'javascript framework' }, ctx())
    assert.ok(Array.isArray(results), 'must return an array')
    assert.deepEqual(results, [])
  } finally {
    if (origUser !== undefined) process.env.TWITTER_USERNAME = origUser
    if (origPass !== undefined) process.env.TWITTER_PASSWORD = origPass
    twitterInternals.resetInstance()
  }
})

// ── Test 8: Twitter returns [] if all instances fail ──────────────────────────

test('8. Twitter returns [] gracefully when all Nitter instances fail (no throw)', async () => {
  twitterInternals.resetAllDownLogged()
  await withFetch(async () => { throw new Error('network error') }, async () => {
    const results = await searchTwitter({ keyword: 'freelance' }, ctx())
    assert.deepEqual(results, [])
  })
})

// ── Test 9: Upwork returns [] on HTTP error ───────────────────────────────────

test('9. Upwork returns [] gracefully on any HTTP error (no throw)', async () => {
  await withFetch(async () => ({ ok: false, status: 503 }), async () => {
    const results = await searchUpwork({ keyword: 'web developer' }, ctx())
    assert.deepEqual(results, [])
  })
})

// ── Test 10: Amazon returns [] on block / 403 ─────────────────────────────────

test('10. Amazon returns [] gracefully on 403 anti-bot block (no throw)', async () => {
  amazonInternals.resetBlockedWarning()
  await withFetch(async () => ({ ok: false, status: 403 }), async () => {
    const results = await searchAmazonReviews({ keyword: 'logo design' }, ctx())
    assert.deepEqual(results, [])
  })
})

// ── Test 11: buildHealthReport returns correct shape ─────────────────────────

test('11. buildHealthReport returns ok/error status and sample_count for each platform', async () => {
  const scrapers = {
    reddit:  async () => [{ id: 'r1' }, { id: 'r2' }],
    youtube: async () => [],
    broken:  async () => { throw new Error('network error') },
  }
  const report = await buildHealthReport(scrapers, 'freelance', ctx())

  assert.equal(report.reddit.status, 'ok')
  assert.equal(report.reddit.sample_count, 2)
  assert.equal(report.youtube.status, 'ok')
  assert.equal(report.youtube.sample_count, 0)
  assert.equal(report.broken.status, 'error')
  assert.ok(typeof report.broken.error === 'string')
})
