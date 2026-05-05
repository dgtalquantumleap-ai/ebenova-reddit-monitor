import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import searchHackerNews from '../lib/scrapers/hackernews.js'

const ctx = () => ({
  seenIds: { has: () => false, add: () => {} },
  delay: async () => {},
  MAX_AGE_MS: 24 * 60 * 60 * 1000,
})

test('searchHackerNews returns [] when both API calls fail', async () => {
  const original = global.fetch
  global.fetch = async () => { throw new Error('network error') }
  try {
    const r = await searchHackerNews({ keyword: 'test' }, ctx())
    assert.deepEqual(r, [])
  } finally { global.fetch = original }
})

test('searchHackerNews returns [] when API returns non-2xx', async () => {
  const original = global.fetch
  global.fetch = async () => ({ ok: false, status: 429 })
  try {
    const r = await searchHackerNews({ keyword: 'test' }, ctx())
    assert.deepEqual(r, [])
  } finally { global.fetch = original }
})

test('searchHackerNews returns story results with type=story', async () => {
  const original = global.fetch
  let callCount = 0
  global.fetch = async (url) => {
    callCount++
    if (url.includes('ask_hn')) return { ok: true, json: async () => ({ hits: [] }) }
    return {
      ok: true,
      json: async () => ({
        hits: [{
          objectID: '12345',
          title: 'Show HN: test',
          created_at_i: Math.floor(Date.now() / 1000) - 3600,
          author: 'testuser',
          points: 42,
          num_comments: 5,
        }],
      }),
    }
  }
  try {
    const r = await searchHackerNews({ keyword: 'test' }, ctx())
    assert.equal(r.length, 1)
    assert.equal(r[0].type, 'story')
    assert.equal(r[0].source, 'hackernews')
    assert.equal(callCount, 2)  // story + ask_hn calls
  } finally { global.fetch = original }
})

test('searchHackerNews deduplicates across story and ask_hn results', async () => {
  const original = global.fetch
  const sameHit = { objectID: 'same123', title: 'Same post', created_at_i: Math.floor(Date.now() / 1000) - 1000, author: 'u', points: 1, num_comments: 0 }
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ hits: [sameHit] }),
  })
  try {
    const r = await searchHackerNews({ keyword: 'test' }, ctx())
    // Same objectID from both calls should be deduplicated
    assert.equal(r.length, 1)
  } finally { global.fetch = original }
})
