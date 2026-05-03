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

// ── Test 6: Twitter Nitter RSS parser ─────────────────────────────────────────

test('6. Twitter (Nitter RSS) parseNitterRSS extracts tweet fields correctly', () => {
  const { parseNitterRSS } = twitterInternals
  const seenIds = { has: () => false, add: () => {} }
  const xml = `<rss><channel>
    <item>
      <title><![CDATA[@testuser: freelance contract template needed]]></title>
      <link>https://nitter.poast.org/testuser/status/9876543210#m</link>
      <pubDate>Sat, 03 May 2026 10:00:00 GMT</pubDate>
      <dc:creator>@testuser</dc:creator>
      <description><![CDATA[freelance contract template needed — any recommendations?]]></description>
    </item>
  </channel></rss>`
  const results = parseNitterRSS(xml, 'freelance contract', seenIds, 24 * 60 * 60 * 1000)
  assert.equal(results.length, 1)
  assert.equal(results[0].url, 'https://x.com/testuser/status/9876543210')
  assert.equal(results[0].author, 'testuser')
  assert.equal(results[0].source, 'twitter')
  assert.equal(results[0].subreddit, 'Twitter')
  assert.ok(!results[0].title.startsWith('@testuser:'), 'title should not start with @username:')
  assert.equal(results[0].approved, true)
})

// ── Test 7: Twitter falls back to second instance on first failure ─────────────

test('7. Twitter falls back to second Nitter instance when first returns non-2xx', async () => {
  twitterInternals.resetAllDownLogged()
  let callCount = 0
  const fakeXml = `<rss><channel>
    <item>
      <title><![CDATA[@u: freelance dev]]></title>
      <link>https://nitter.privacydev.net/u/status/111222333444#m</link>
      <pubDate>Sat, 03 May 2026 09:00:00 GMT</pubDate>
      <dc:creator>@u</dc:creator>
      <description><![CDATA[freelance dev]]></description>
    </item>
  </channel></rss>`

  await withFetch(async () => {
    callCount++
    if (callCount === 1) return { ok: false, status: 503 }
    return { ok: true, text: async () => fakeXml }
  }, async () => {
    const results = await searchTwitter({ keyword: 'freelance dev' }, ctx())
    assert.ok(results.length > 0, 'should return results from second instance')
    assert.equal(callCount, 2, 'should have tried exactly 2 instances')
  })
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
