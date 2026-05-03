import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import searchTwitter  from '../lib/scrapers/twitter.js'
import searchLinkedIn from '../lib/scrapers/linkedin.js'
import { VALID_PLATFORMS, PLATFORM_LABELS, validatePlatforms } from '../lib/platforms.js'

const REQUIRED_FIELDS = ['id','title','url','subreddit','author','score','comments','body','createdAt','keyword','source','approved']

// ── Twitter scraper ────────────────────────────────────────────────────────
// The scraper uses agent-twitter-client. TWITTER_USERNAME / TWITTER_PASSWORD required.
// See test/platform-audit.test.js for unit tests 6-8.

test('twitter: result items have required shape fields when credentials are valid', { skip: true }, async () => {
  // Manual verification only — requires live TWITTER_USERNAME / TWITTER_PASSWORD.
  const r = await searchTwitter({ keyword: 'javascript' }, { seenIds: new Set(), delay: null, MAX_AGE_MS: null })
  assert.ok(Array.isArray(r))
  if (r.length === 0) return
  for (const item of r) {
    for (const f of REQUIRED_FIELDS) assert.ok(f in item, `missing field ${f}`)
    assert.equal(item.source, 'twitter')
    assert.ok(item.id.startsWith('twitter_'), `id should start with twitter_: ${item.id}`)
    assert.ok(item.url.includes('x.com'), `url should include x.com: ${item.url}`)
    assert.equal(item.approved, true)
  }
})

// ── LinkedIn scraper ───────────────────────────────────────────────────────

test('linkedin: returns array (possibly empty) for any keyword', async () => {
  const r = await searchLinkedIn({ keyword: 'software engineer' }, { seenIds: new Set(), delay: null, MAX_AGE_MS: null })
  assert.ok(Array.isArray(r))
})

test('linkedin: result items have required shape fields when present', async () => {
  const r = await searchLinkedIn({ keyword: 'product launch' }, { seenIds: new Set(), delay: null, MAX_AGE_MS: null })
  assert.ok(Array.isArray(r))
  if (r.length === 0) return // Google may have blocked in this test env
  for (const item of r) {
    for (const f of REQUIRED_FIELDS) assert.ok(f in item, `missing field ${f}`)
    assert.equal(item.source, 'linkedin')
    assert.ok(item.id.startsWith('linkedin_'))
    assert.ok(item.url.includes('linkedin.com/posts/'))
    assert.equal(item.approved, true)
  }
})

// ── Platform registry includes Twitter (LinkedIn intentionally parked) ────

test('platforms: VALID_PLATFORMS includes twitter', () => {
  assert.ok(VALID_PLATFORMS.includes('twitter'))
})

test('platforms: VALID_PLATFORMS does NOT include linkedin (parked)', () => {
  assert.equal(VALID_PLATFORMS.includes('linkedin'), false)
})

test('platforms: PLATFORM_LABELS has entry for twitter', () => {
  assert.equal(PLATFORM_LABELS.twitter, 'Twitter/X')
})

test('platforms: validatePlatforms accepts twitter, rejects linkedin', () => {
  assert.equal(validatePlatforms(['twitter']).ok, true)
  assert.equal(validatePlatforms(['linkedin']).ok, false)
  assert.equal(validatePlatforms(['reddit', 'twitter']).ok, true)
})
