import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import searchStackOverflow, { _internals } from '../lib/scrapers/stackoverflow.js'
import { VALID_PLATFORMS, PLATFORM_LABELS, PLATFORM_EMOJIS, validatePlatforms } from '../lib/platforms.js'

function withFetch(impl, fn) {
  const original = global.fetch
  global.fetch = impl
  return Promise.resolve().then(fn).finally(() => { global.fetch = original })
}

const ctx = () => ({
  seenIds: { has: () => false, add: () => {} },
  delay:   null,
  MAX_AGE_MS: 24 * 60 * 60 * 1000,
})

const makeResponse = (items = [], extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({ items, quota_remaining: 299, ...extra }),
})

const fakeItem = (overrides = {}) => ({
  question_id:  12345,
  title:        'How do I monitor Reddit mentions for my SaaS?',
  link:         'https://stackoverflow.com/questions/12345',
  body:         '<p>I need a tool that monitors Reddit for keyword mentions.</p>',
  score:        7,
  answer_count: 3,
  creation_date: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
  owner:        { display_name: 'dev_user' },
  ...overrides,
})

// ── Shape ─────────────────────────────────────────────────────────────────────

test('stackoverflow: result items have correct shape', async () => {
  await withFetch(async () => makeResponse([fakeItem()]), async () => {
    const results = await searchStackOverflow({ keyword: 'reddit monitor' }, ctx())
    assert.ok(Array.isArray(results))
    assert.equal(results.length, 1)

    const r = results[0]
    assert.equal(r.id,        'stackoverflow_12345')
    assert.equal(r.url,       'https://stackoverflow.com/questions/12345')
    assert.equal(r.subreddit, 'Stack Overflow')
    assert.equal(r.author,    'dev_user')
    assert.equal(r.score,     7)
    assert.equal(r.comments,  3)
    assert.equal(r.source,    'stackoverflow')
    assert.equal(r.approved,  true)
    assert.equal(r.keyword,   'reddit monitor')
    assert.ok(r.title.length > 0)
    assert.ok(r.body.length > 0)
    assert.ok(!r.body.includes('<p>'), 'body should have HTML stripped')
  })
})

// ── Graceful failure ──────────────────────────────────────────────────────────

test('stackoverflow: returns [] on HTTP error (no throw)', async () => {
  await withFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }), async () => {
    const results = await searchStackOverflow({ keyword: 'saas tool' }, ctx())
    assert.deepEqual(results, [])
  })
})

test('stackoverflow: returns [] on network error (no throw)', async () => {
  await withFetch(async () => { throw new Error('ECONNREFUSED') }, async () => {
    const results = await searchStackOverflow({ keyword: 'saas tool' }, ctx())
    assert.deepEqual(results, [])
  })
})

test('stackoverflow: returns [] when keyword is empty', async () => {
  const results = await searchStackOverflow({ keyword: '' }, ctx())
  assert.deepEqual(results, [])
})

// ── Filtering ─────────────────────────────────────────────────────────────────

test('stackoverflow: filters out items older than MAX_AGE_MS', async () => {
  const oldItem  = fakeItem({ question_id: 1, creation_date: Math.floor(Date.now() / 1000) - 90000 }) // 25h ago
  const newItem  = fakeItem({ question_id: 2, creation_date: Math.floor(Date.now() / 1000) - 3600  }) // 1h ago

  await withFetch(async () => makeResponse([oldItem, newItem]), async () => {
    const results = await searchStackOverflow({ keyword: 'saas' }, ctx())
    assert.equal(results.length, 1)
    assert.equal(results[0].id, 'stackoverflow_2')
  })
})

test('stackoverflow: deduplicates via seenIds', async () => {
  const seenIds = { has: (id) => id === 'stackoverflow_12345', add: () => {} }
  await withFetch(async () => makeResponse([fakeItem()]), async () => {
    const results = await searchStackOverflow({ keyword: 'saas' }, { seenIds, delay: null, MAX_AGE_MS: null })
    assert.deepEqual(results, [])
  })
})

// ── Platform registry ─────────────────────────────────────────────────────────

test('stackoverflow: in VALID_PLATFORMS', () => {
  assert.ok(VALID_PLATFORMS.includes('stackoverflow'))
})

test('stackoverflow: has label and emoji', () => {
  assert.equal(PLATFORM_LABELS.stackoverflow,  'Stack Overflow')
  assert.ok(PLATFORM_EMOJIS.stackoverflow)
})

test('stackoverflow: validatePlatforms accepts it', () => {
  assert.equal(validatePlatforms(['stackoverflow']).ok, true)
  assert.equal(validatePlatforms(['reddit', 'stackoverflow']).ok, true)
})
