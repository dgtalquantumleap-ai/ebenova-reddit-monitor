import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { validatePlatforms, VALID_PLATFORMS, PLATFORM_LABELS } from '../lib/platforms.js'
import searchTwitter  from '../lib/scrapers/twitter.js'
import searchLinkedIn from '../lib/scrapers/linkedin.js'

// ── Platforms ────────────────────────────────────────────────────────────────

test('VALID_PLATFORMS includes twitter', () => {
  assert.ok(VALID_PLATFORMS.includes('twitter'))
})

test('VALID_PLATFORMS includes linkedin', () => {
  assert.ok(VALID_PLATFORMS.includes('linkedin'))
})

test('PLATFORM_LABELS.twitter is Twitter/X', () => {
  assert.equal(PLATFORM_LABELS.twitter, 'Twitter/X')
})

test('PLATFORM_LABELS.linkedin is LinkedIn', () => {
  assert.equal(PLATFORM_LABELS.linkedin, 'LinkedIn')
})

test('validatePlatforms accepts twitter', () => {
  const r = validatePlatforms(['twitter'])
  assert.equal(r.ok, true)
})

test('validatePlatforms accepts linkedin', () => {
  const r = validatePlatforms(['linkedin'])
  assert.equal(r.ok, true)
})

// ── Twitter — missing credentials ────────────────────────────────────────────

test('searchTwitter returns [] when TWITTER_USERNAME is undefined', async () => {
  const saved = process.env.TWITTER_USERNAME
  delete process.env.TWITTER_USERNAME
  try {
    const results = await searchTwitter({ keyword: 'test' }, { seenIds: new Set(), delay: null, MAX_AGE_MS: null })
    assert.ok(Array.isArray(results))
    assert.equal(results.length, 0)
  } finally {
    if (saved !== undefined) process.env.TWITTER_USERNAME = saved
  }
})

test('searchTwitter returns [] when TWITTER_PASSWORD is undefined', async () => {
  const savedU = process.env.TWITTER_USERNAME
  const savedP = process.env.TWITTER_PASSWORD
  process.env.TWITTER_USERNAME = 'someuser'
  delete process.env.TWITTER_PASSWORD
  try {
    const results = await searchTwitter({ keyword: 'test' }, { seenIds: new Set(), delay: null, MAX_AGE_MS: null })
    assert.ok(Array.isArray(results))
    assert.equal(results.length, 0)
  } finally {
    if (savedU !== undefined) process.env.TWITTER_USERNAME = savedU
    else delete process.env.TWITTER_USERNAME
    if (savedP !== undefined) process.env.TWITTER_PASSWORD = savedP
  }
})

// ── Twitter — result shape (only when credentials are set) ──────────────────

const REQUIRED_FIELDS = ['id', 'title', 'url', 'subreddit', 'author', 'score', 'comments', 'body', 'createdAt', 'keyword', 'source', 'approved']

if (process.env.TWITTER_USERNAME && process.env.TWITTER_PASSWORD) {
  test('searchTwitter result shape', async () => {
    const results = await searchTwitter(
      { keyword: 'freelance software' },
      { seenIds: new Set(), delay: null, MAX_AGE_MS: null }
    )
    assert.ok(Array.isArray(results))
    for (const r of results) {
      for (const f of REQUIRED_FIELDS) {
        assert.ok(Object.prototype.hasOwnProperty.call(r, f), `missing field: ${f}`)
      }
      assert.ok(r.id.startsWith('twitter_'), `id should start with twitter_: ${r.id}`)
      assert.equal(r.source, 'twitter')
      assert.ok(r.url.includes('x.com'), `url should include x.com: ${r.url}`)
      assert.equal(r.approved, true)
    }
  })
}

// ── LinkedIn — always runs (graceful empty is acceptable) ────────────────────

test('searchLinkedIn returns array without throwing', async () => {
  const results = await searchLinkedIn(
    { keyword: 'software freelancer' },
    { seenIds: new Set(), delay: null, MAX_AGE_MS: null }
  )
  assert.ok(Array.isArray(results))
})

test('searchLinkedIn result shape when results present', async () => {
  const results = await searchLinkedIn(
    { keyword: 'software freelancer' },
    { seenIds: new Set(), delay: null, MAX_AGE_MS: null }
  )
  for (const r of results) {
    for (const f of REQUIRED_FIELDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(r, f), `missing field: ${f}`)
    }
    assert.ok(r.id.startsWith('linkedin_'), `id should start with linkedin_: ${r.id}`)
    assert.equal(r.source, 'linkedin')
    assert.ok(r.url.includes('linkedin.com/posts/'), `url should include linkedin.com/posts/: ${r.url}`)
    assert.equal(r.approved, true)
  }
})
