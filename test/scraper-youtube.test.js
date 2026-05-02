import { test } from 'node:test'
import { strict as assert } from 'node:assert'

// ── YouTube scraper unit tests ────────────────────────────────────────────────
// We mock globalThis.fetch so no real API calls are made.

function makeFakeItem(videoId, title, channelTitle, description, publishedAt) {
  return {
    id: { kind: 'youtube#video', videoId },
    snippet: { title, channelTitle, description, publishedAt },
  }
}

function makeFakeResponse(items) {
  return { items }
}

async function runScraper(items, { apiKey = 'fake-key', keyword = 'test kw', maxAgeMs } = {}) {
  const originalFetch = globalThis.fetch
  const originalEnv   = process.env.YOUTUBE_API_KEY

  globalThis.fetch = async () => ({
    ok:   true,
    json: async () => makeFakeResponse(items),
  })
  process.env.YOUTUBE_API_KEY = apiKey

  try {
    // Dynamic import so env is set before the module reads it
    const { default: searchYouTube } = await import('../lib/scrapers/youtube.js')
    const seenSet = new Set()
    const seenIds = { has: id => seenSet.has(id), add: id => seenSet.add(id) }
    return await searchYouTube({ keyword }, { seenIds, delay: null, MAX_AGE_MS: maxAgeMs || 86400000 })
  } finally {
    globalThis.fetch = originalFetch
    process.env.YOUTUBE_API_KEY = originalEnv
  }
}

test('youtube: returns [] when YOUTUBE_API_KEY not set', async () => {
  const originalEnv = process.env.YOUTUBE_API_KEY
  delete process.env.YOUTUBE_API_KEY
  try {
    const { default: searchYouTube } = await import('../lib/scrapers/youtube.js')
    const seenIds = { has: () => false, add: () => {} }
    const results = await searchYouTube({ keyword: 'test' }, { seenIds, delay: null, MAX_AGE_MS: 86400000 })
    assert.equal(results.length, 0)
  } finally {
    if (originalEnv !== undefined) process.env.YOUTUBE_API_KEY = originalEnv
  }
})

test('youtube: maps API response to expected result shape', async () => {
  const items = [makeFakeItem('vid1', 'My Video', 'My Channel', 'A description', '2024-01-01T00:00:00Z')]
  const results = await runScraper(items)

  assert.equal(results.length, 1)
  const r = results[0]
  assert.ok(r.id.startsWith('yt_'))
  assert.equal(r.title, 'My Video')
  assert.equal(r.url, 'https://www.youtube.com/watch?v=vid1')
  assert.equal(r.author, 'My Channel')
  assert.equal(r.source, 'youtube')
  assert.equal(r.approved, true)
  assert.equal(r.keyword, 'test kw')
  assert.equal(r.body, 'A description')
})

test('youtube: skips non-video items (kind != youtube#video)', async () => {
  const items = [
    { id: { kind: 'youtube#channel', channelId: 'chan1' }, snippet: { title: 'Channel' } },
    makeFakeItem('vid2', 'Real Video', 'Chan', 'Desc', '2024-01-01T00:00:00Z'),
  ]
  const results = await runScraper(items)
  assert.equal(results.length, 1)
  assert.equal(results[0].url, 'https://www.youtube.com/watch?v=vid2')
})

test('youtube: deduplicates via seenIds', async () => {
  const items = [makeFakeItem('vid3', 'Video', 'Chan', 'Desc', '2024-01-01T00:00:00Z')]
  const originalEnv = process.env.YOUTUBE_API_KEY
  process.env.YOUTUBE_API_KEY = 'fake-key'
  try {
    const { default: searchYouTube } = await import('../lib/scrapers/youtube.js')
    const seenSet = new Set()
    const seenIds = { has: id => seenSet.has(id), add: id => seenSet.add(id) }
    globalThis.fetch = async () => ({ ok: true, json: async () => makeFakeResponse(items) })

    const first  = await searchYouTube({ keyword: 'kw' }, { seenIds, delay: null, MAX_AGE_MS: 86400000 })
    const second = await searchYouTube({ keyword: 'kw' }, { seenIds, delay: null, MAX_AGE_MS: 86400000 })
    assert.equal(first.length, 1)
    assert.equal(second.length, 0)
  } finally {
    process.env.YOUTUBE_API_KEY = originalEnv
    globalThis.fetch = undefined
  }
})

test('youtube: stable ID — same videoId produces same yt_ prefix ID', async () => {
  const items = [makeFakeItem('vid4', 'T', 'C', 'D', '2024-01-01T00:00:00Z')]
  const r1 = await runScraper(items)
  const r2 = await runScraper(items)
  assert.equal(r1[0].id, r2[0].id)
  assert.match(r1[0].id, /^yt_[a-f0-9]{12}$/)
})

test('youtube: returns [] and logs warning on non-ok response', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv   = process.env.YOUTUBE_API_KEY
  process.env.YOUTUBE_API_KEY = 'fake-key'
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => 'quota exceeded' })
  try {
    const { default: searchYouTube } = await import('../lib/scrapers/youtube.js')
    const seenIds = { has: () => false, add: () => {} }
    const results = await searchYouTube({ keyword: 'test' }, { seenIds, delay: null, MAX_AGE_MS: 86400000 })
    assert.equal(results.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    process.env.YOUTUBE_API_KEY = originalEnv
  }
})

test('youtube: caps results at 10', async () => {
  const items = Array.from({ length: 15 }, (_, i) =>
    makeFakeItem(`vid${i}`, `Video ${i}`, 'Chan', 'Desc', '2024-01-01T00:00:00Z')
  )
  const results = await runScraper(items)
  assert.ok(results.length <= 10)
})
