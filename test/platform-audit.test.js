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

// ── Test 6: Twitter (agent-twitter-client) result shape ───────────────────────

test('6. Twitter (agent-twitter-client) returns correct item shape from mock scraper', async () => {
  twitterInternals.resetScraper()

  const mockTweet = {
    id:         '9876543210',
    text:       'freelance contract template needed — any recommendations?',
    username:   'testuser',
    likes:      5,
    replies:    2,
    timeParsed: new Date('2026-05-03T10:00:00Z'),
  }
  twitterInternals._setScraperForTest({
    fetchSearchTweets: async () => ({ tweets: [mockTweet] }),
    getCookies:        async () => [],
  })

  const results = await searchTwitter({ keyword: 'freelance contract' }, ctx())

  assert.equal(results.length, 1)
  assert.equal(results[0].id,        'twitter_9876543210')
  assert.equal(results[0].url,       'https://x.com/testuser/status/9876543210')
  assert.equal(results[0].author,    'testuser')
  assert.equal(results[0].source,    'twitter')
  assert.equal(results[0].subreddit, 'Twitter')
  assert.equal(results[0].approved,  true)
  assert.equal(results[0].score,     5)
  assert.equal(results[0].comments,  2)

  twitterInternals.resetScraper()
})

// ── Test 7: Twitter returns [] when credentials not set ───────────────────────

test('7. Twitter returns [] when TWITTER_USERNAME / TWITTER_PASSWORD are not set', async () => {
  twitterInternals.resetScraper()

  const savedUser = process.env.TWITTER_USERNAME
  const savedPass = process.env.TWITTER_PASSWORD
  delete process.env.TWITTER_USERNAME
  delete process.env.TWITTER_PASSWORD

  const results = await searchTwitter({ keyword: 'freelance dev' }, ctx())
  assert.deepEqual(results, [])

  if (savedUser !== undefined) process.env.TWITTER_USERNAME = savedUser
  if (savedPass !== undefined) process.env.TWITTER_PASSWORD = savedPass
  twitterInternals.resetScraper()
})

// ── Test 8: Twitter returns [] gracefully on scraper error ────────────────────

test('8. Twitter returns [] gracefully when scraper throws (no throw propagated)', async () => {
  twitterInternals.resetScraper()
  twitterInternals._setScraperForTest({
    fetchSearchTweets: async () => { throw new Error('network error') },
    getCookies:        async () => [],
  })

  const results = await searchTwitter({ keyword: 'freelance' }, ctx())
  assert.deepEqual(results, [])

  twitterInternals.resetScraper()
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
