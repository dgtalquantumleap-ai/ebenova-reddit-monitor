import { test } from 'node:test'
import { strict as assert } from 'node:assert'

// Mirror the validation functions that will be added to api-server.js.
// These are tested inline here so they can run without starting the server.

function validateRssFeeds(value) {
  if (!Array.isArray(value)) return { ok: false, error: '`rssFeeds` must be an array' }
  if (value.length > 5)     return { ok: false, error: '`rssFeeds` cannot exceed 5 items' }
  for (const url of value) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return { ok: false, error: `invalid URL in rssFeeds: "${url}"` }
    }
  }
  return { ok: true, value: value.map(u => u.trim()) }
}

function validateTelegramChannels(value) {
  if (!Array.isArray(value)) return { ok: false, error: '`telegramChannels` must be an array' }
  if (value.length > 5)     return { ok: false, error: '`telegramChannels` cannot exceed 5 items' }
  for (const ch of value) {
    const handle = (typeof ch === 'string') ? ch.replace(/^@/, '') : ''
    if (!/^[a-zA-Z0-9_]{5,32}$/.test(handle)) {
      return { ok: false, error: `invalid Telegram handle: "${ch}"` }
    }
  }
  return { ok: true, value: value.map(c => (typeof c === 'string' ? c.replace(/^@/, '') : c)) }
}

// ── rssFeeds validation ──────────────────────────────────────────────────────

test('api: rssFeeds accepts valid https URL array', () => {
  const r = validateRssFeeds(['https://example.com/feed', 'https://blog.io/rss'])
  assert.equal(r.ok, true)
  assert.equal(r.value.length, 2)
})

test('api: rssFeeds accepts http URLs', () => {
  const r = validateRssFeeds(['http://example.com/feed'])
  assert.equal(r.ok, true)
})

test('api: rssFeeds rejects non-array', () => {
  assert.equal(validateRssFeeds('https://example.com').ok, false)
})

test('api: rssFeeds rejects more than 5 items', () => {
  const r = validateRssFeeds(['https://a.com','https://b.com','https://c.com','https://d.com','https://e.com','https://f.com'])
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('5'))
})

test('api: rssFeeds rejects non-URL strings', () => {
  assert.equal(validateRssFeeds(['not-a-url']).ok, false)
})

// ── telegramChannels validation ──────────────────────────────────────────────

test('api: telegramChannels accepts valid handles', () => {
  const r = validateTelegramChannels(['startups', '@techfounder', 'saas_founders'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.value, ['startups', 'techfounder', 'saas_founders'])
})

test('api: telegramChannels strips leading @', () => {
  const r = validateTelegramChannels(['@startups'])
  assert.equal(r.ok, true)
  assert.equal(r.value[0], 'startups')
})

test('api: telegramChannels rejects non-array', () => {
  assert.equal(validateTelegramChannels('startups').ok, false)
})

test('api: telegramChannels rejects more than 5 items', () => {
  const r = validateTelegramChannels(['aaaaa','bbbbb','ccccc','ddddd','eeeee','fffff'])
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('5'))
})

test('api: telegramChannels rejects handles shorter than 5 chars', () => {
  assert.equal(validateTelegramChannels(['abc']).ok, false)
})

test('api: telegramChannels rejects handles with invalid characters', () => {
  assert.equal(validateTelegramChannels(['hello world']).ok, false)
  assert.equal(validateTelegramChannels(['hello-world']).ok, false)
})
