import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import searchHackerNews from '../lib/scrapers/hackernews.js'

function ctx() {
  return {
    seenIds: { has: () => false, add: () => {} },
    delay:   async () => {},
    MAX_AGE_MS: 24 * 60 * 60 * 1000,
  }
}

function mockFetch(storyHits = [], askHits = []) {
  let callCount = 0
  return async (url) => {
    const hits = url.includes('ask_hn') ? askHits : storyHits
    callCount++
    return {
      ok: true,
      json: async () => ({ hits }),
    }
  }
}

function makeHit(id, title = 'Test post') {
  return {
    objectID:     String(id),
    title,
    author:       'user1',
    points:       5,
    num_comments: 2,
    story_text:   '',
    created_at_i: Math.floor(Date.now() / 1000) - 3600,
  }
}

test('returns story and ask_hn results combined', async () => {
  const orig = global.fetch
  global.fetch = mockFetch([makeHit(1, 'Story post')], [makeHit(2, 'Ask HN post')])
  try {
    const results = await searchHackerNews({ keyword: 'saas tool' }, ctx())
    assert.equal(results.length, 2)
    const types = results.map(r => r.type).sort()
    assert.deepEqual(types, ['ask_hn', 'story'])
  } finally { global.fetch = orig }
})

test('deduplicates by objectID across both calls', async () => {
  const orig = global.fetch
  const hit = makeHit(42, 'Shared post')
  global.fetch = mockFetch([hit], [hit])
  try {
    const results = await searchHackerNews({ keyword: 'saas' }, ctx())
    assert.equal(results.length, 1)
  } finally { global.fetch = orig }
})

test('returns [] gracefully on fetch error', async () => {
  const orig = global.fetch
  global.fetch = async () => { throw new Error('network error') }
  try {
    const results = await searchHackerNews({ keyword: 'saas' }, ctx())
    assert.deepEqual(results, [])
  } finally { global.fetch = orig }
})

test('result ids are prefixed with hn_', async () => {
  const orig = global.fetch
  global.fetch = mockFetch([makeHit(99)], [])
  try {
    const results = await searchHackerNews({ keyword: 'saas' }, ctx())
    assert.ok(results[0].id.startsWith('hn_'))
  } finally { global.fetch = orig }
})
