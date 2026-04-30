// YouTube scraper (Roadmap "YouTube" PR).
//
// Pins the same contract every other scraper in lib/scrapers/ pins:
//   - never throws on a fetch error
//   - returns [] when the API key is absent (test envs + early deploys)
//   - both video matches AND comment matches carry source: 'youtube'
//   - older-than-MAX_AGE_MS videos are filtered out before we spend any
//     commentThreads budget on them
//   - platform registry has 'youtube' wired in (Settings list badges, etc)

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import searchYouTube, { _internals } from '../lib/scrapers/youtube.js'
import { VALID_PLATFORMS, PLATFORM_LABELS, PLATFORM_EMOJIS } from '../lib/platforms.js'

function withFetch(impl, fn) {
  const original = global.fetch
  global.fetch = impl
  return Promise.resolve()
    .then(fn)
    .finally(() => { global.fetch = original })
}

function withEnv(vars, fn) {
  const original = {}
  for (const k of Object.keys(vars)) {
    original[k] = process.env[k]
    if (vars[k] === null) delete process.env[k]
    else process.env[k] = vars[k]
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(vars)) {
        if (original[k] === undefined) delete process.env[k]
        else process.env[k] = original[k]
      }
    })
}

const ctx = () => ({
  seenIds: { has: () => false, add: () => {} },
  delay:   async () => {},
  MAX_AGE_MS: 24 * 60 * 60 * 1000,
})

// ── 1. no API key → [] ────────────────────────────────────────────────────

test('1. searchYouTube() returns [] when YOUTUBE_API_KEY is not set', async () => {
  let fetchCalled = false
  await withEnv({ YOUTUBE_API_KEY: null }, async () => {
    _internals.resetNoKeyWarning()
    await withFetch(async () => { fetchCalled = true; return { ok: true, json: async () => ({}) } }, async () => {
      const r = await searchYouTube({ keyword: 'mcp server' }, ctx())
      assert.deepEqual(r, [])
      assert.equal(fetchCalled, false, 'should not hit network without an API key')
    })
  })
})

// ── 2. fetch error → [] (never throws) ────────────────────────────────────

test('2. searchYouTube() returns [] on fetch error (never throws)', async () => {
  await withEnv({ YOUTUBE_API_KEY: 'test-key' }, async () => {
    await withFetch(async () => { throw new Error('ECONNREFUSED') }, async () => {
      const r = await searchYouTube({ keyword: 'mcp server' }, ctx())
      assert.deepEqual(r, [])
    })
  })
})

test('2b. searchYouTube() returns [] on non-2xx /search response', async () => {
  await withEnv({ YOUTUBE_API_KEY: 'test-key' }, async () => {
    await withFetch(async () => ({ ok: false, status: 403, json: async () => ({}) }), async () => {
      const r = await searchYouTube({ keyword: 'mcp server' }, ctx())
      assert.deepEqual(r, [])
    })
  })
})

// ── 3. video matches have source: 'youtube' ───────────────────────────────

test('3. video matches have source: "youtube" and subreddit: "youtube:video"', async () => {
  // Stub fetch: first call (/search) returns a video; subsequent calls
  // (/commentThreads) return empty so we don't have to script per-video.
  let callCount = 0
  await withEnv({ YOUTUBE_API_KEY: 'test-key' }, async () => {
    await withFetch(async (url) => {
      callCount++
      if (String(url).includes('/search')) {
        return { ok: true, status: 200, json: async () => ({
          items: [{
            id: { videoId: 'abc123' },
            snippet: {
              title: 'Building an MCP server',
              channelTitle: 'Demo Channel',
              description: 'A walkthrough of setting up an MCP server.',
              publishedAt: new Date().toISOString(),
            },
          }],
        }) }
      }
      // /commentThreads — return no items so we just get the video match.
      return { ok: true, status: 200, json: async () => ({ items: [] }) }
    }, async () => {
      const r = await searchYouTube({ keyword: 'mcp server' }, ctx())
      assert.ok(r.length >= 1, 'expected at least one video match')
      const video = r.find(m => m.subreddit === 'youtube:video')
      assert.ok(video, 'expected a youtube:video match')
      assert.equal(video.source, 'youtube')
      assert.equal(video.url, 'https://www.youtube.com/watch?v=abc123')
      assert.equal(video.author, 'Demo Channel')
      assert.equal(video.approved, true)
    })
  })
  assert.ok(callCount >= 1)
})

// ── 4. comment matches have source: 'youtube' ─────────────────────────────

test('4. comment matches have source: "youtube" and subreddit: "youtube:comment"', async () => {
  await withEnv({ YOUTUBE_API_KEY: 'test-key' }, async () => {
    await withFetch(async (url) => {
      if (String(url).includes('/search')) {
        return { ok: true, status: 200, json: async () => ({
          items: [{
            id: { videoId: 'vid123' },
            snippet: {
              title:        'Demo title',
              channelTitle: 'Demo Channel',
              description:  '',
              publishedAt:  new Date().toISOString(),
            },
          }],
        }) }
      }
      // /commentThreads — return one comment.
      return { ok: true, status: 200, json: async () => ({
        items: [{
          id: 'comment-id-xyz',
          snippet: {
            totalReplyCount: 2,
            topLevelComment: {
              snippet: {
                authorDisplayName: 'Alex',
                textDisplay:       'Great walkthrough on MCP servers!',
                likeCount:         5,
                publishedAt:       new Date().toISOString(),
              },
            },
          },
        }],
      }) }
    }, async () => {
      const r = await searchYouTube({ keyword: 'mcp server' }, ctx())
      const comment = r.find(m => m.subreddit === 'youtube:comment')
      assert.ok(comment, 'expected a youtube:comment match')
      assert.equal(comment.source,   'youtube')
      assert.equal(comment.author,   'Alex')
      assert.equal(comment.score,    5)
      assert.equal(comment.comments, 2)
      assert.equal(comment.url, 'https://www.youtube.com/watch?v=vid123&lc=comment-id-xyz')
      assert.match(comment.title,    /\[comment\]$/)
      assert.equal(comment.approved, true)
    })
  })
})

// ── 5. videos older than MAX_AGE_MS are filtered out ──────────────────────

test('5. searchYouTube() filters videos older than MAX_AGE_MS', async () => {
  // One fresh video + one too-old video. Only the fresh one should be
  // returned, and the old one should never trigger a /commentThreads call.
  let commentCalls = 0
  await withEnv({ YOUTUBE_API_KEY: 'test-key' }, async () => {
    const tooOld = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()  // 5 days
    const fresh  = new Date().toISOString()
    await withFetch(async (url) => {
      if (String(url).includes('/search')) {
        return { ok: true, status: 200, json: async () => ({
          items: [
            { id: { videoId: 'old1' },   snippet: { title: 'Old vid',   channelTitle: 'X', description: '', publishedAt: tooOld } },
            { id: { videoId: 'fresh1' }, snippet: { title: 'Fresh vid', channelTitle: 'X', description: '', publishedAt: fresh  } },
          ],
        }) }
      }
      commentCalls++
      // Whichever videoId got here will determine whether we leaked the old one.
      assert.match(String(url), /videoId=fresh1/, 'commentThreads should ONLY be hit for fresh videos')
      return { ok: true, status: 200, json: async () => ({ items: [] }) }
    }, async () => {
      // 24h cap by default — the 5-day-old video should be skipped.
      const r = await searchYouTube({ keyword: 'x' }, ctx())
      const videos = r.filter(m => m.subreddit === 'youtube:video')
      assert.equal(videos.length, 1, 'only the fresh video should make it through')
      assert.match(videos[0].url, /v=fresh1/)
    })
  })
  assert.equal(commentCalls, 1, 'commentThreads should be called once (for fresh1 only)')
})

// ── 6. platform-registry wiring ───────────────────────────────────────────

test('6. youtube is registered in VALID_PLATFORMS with label + emoji', () => {
  assert.ok(VALID_PLATFORMS.includes('youtube'),  'youtube must be in VALID_PLATFORMS')
  assert.equal(PLATFORM_LABELS.youtube, 'YouTube')
  assert.equal(PLATFORM_EMOJIS.youtube, '▶️')
  // Adding YouTube bumps the count from 11 → 12.
  assert.equal(VALID_PLATFORMS.length, 12)
})

// ── Internals pinned ──────────────────────────────────────────────────────

test('internals match spec — VIDEO_LIMIT=3, COMMENTS_PER_VIDEO=20, COMMENT_DELAY_MS=1000', () => {
  assert.equal(_internals.VIDEO_LIMIT,         3)
  assert.equal(_internals.COMMENTS_PER_VIDEO,  20)
  assert.equal(_internals.COMMENT_DELAY_MS,    1000)
  assert.equal(_internals.API_BASE,            'https://www.googleapis.com/youtube/v3')
})
