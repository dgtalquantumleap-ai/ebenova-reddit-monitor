import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  fetchEngagement,
  computeEngagement,
  isEligibleForCheck,
  runEngagementSweep,
  _internals,
} from '../lib/reply-tracker.js'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

// ── isEligibleForCheck ─────────────────────────────────────────────────────

test('isEligibleForCheck: false when match is null/undefined', () => {
  assert.equal(isEligibleForCheck(null), false)
  assert.equal(isEligibleForCheck(undefined), false)
})

test('isEligibleForCheck: false when no postedAt', () => {
  assert.equal(isEligibleForCheck({ id: 'm', source: 'reddit', url: 'u' }), false)
})

test('isEligibleForCheck: false when already checked', () => {
  const m = {
    id: 'm', source: 'reddit', url: 'u',
    postedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    engagement: { checkedAt: new Date().toISOString() },
  }
  assert.equal(isEligibleForCheck(m), false)
})

test('isEligibleForCheck: false when posted < 24h ago', () => {
  const m = {
    id: 'm', source: 'reddit', url: 'u',
    postedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),  // 5h ago
  }
  assert.equal(isEligibleForCheck(m), false)
})

test('isEligibleForCheck: true at exactly 24h', () => {
  const now = Date.now()
  const m = {
    id: 'm', source: 'reddit', url: 'u',
    postedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
  }
  assert.equal(isEligibleForCheck(m, now), true)
})

test('isEligibleForCheck: true when posted > 24h ago and never checked', () => {
  const m = {
    id: 'm', source: 'reddit', url: 'u',
    postedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  }
  assert.equal(isEligibleForCheck(m), true)
})

test('isEligibleForCheck: false when postedAt is malformed', () => {
  const m = { id: 'm', source: 'reddit', url: 'u', postedAt: 'never' }
  assert.equal(isEligibleForCheck(m), false)
})

// ── computeEngagement ──────────────────────────────────────────────────────

test('computeEngagement: positive delta marks gotEngagement=true', () => {
  const baseline = { score: 5, comments: 3 }
  const current = { ok: true, score: 12, comments: 7 }
  const r = computeEngagement(baseline, current, new Date('2026-04-29T10:00:00Z'))
  assert.equal(r.commentsDelta, 4)
  assert.equal(r.scoreDelta,    7)
  assert.equal(r.gotEngagement, true)
  assert.equal(r.checkedAt, '2026-04-29T10:00:00.000Z')
  assert.equal(r.error, null)
})

test('computeEngagement: zero delta → gotEngagement=false', () => {
  const r = computeEngagement({ score: 5, comments: 3 }, { ok: true, score: 5, comments: 3 })
  assert.equal(r.commentsDelta, 0)
  assert.equal(r.gotEngagement, false)
})

test('computeEngagement: missing baseline values default to 0', () => {
  const r = computeEngagement({}, { ok: true, score: 5, comments: 2 })
  assert.equal(r.commentsDelta, 2)
  assert.equal(r.scoreDelta,    5)
  assert.equal(r.gotEngagement, true)
})

test('computeEngagement: failed fetch returns error record', () => {
  const r = computeEngagement({ score: 5, comments: 3 }, { ok: false, error: 'post-deleted' })
  assert.equal(r.commentsDelta, 0)
  assert.equal(r.scoreDelta, 0)
  assert.equal(r.gotEngagement, false)
  assert.equal(r.error, 'post-deleted')
  assert.ok(r.checkedAt) // still records when we tried
})

test('computeEngagement: null current also produces error record', () => {
  const r = computeEngagement({ score: 1, comments: 1 }, null)
  assert.equal(r.gotEngagement, false)
  assert.equal(r.error, 'unknown')
})

// ── fetchEngagement (mocked global.fetch) ──────────────────────────────────

function mockFetch(impl) {
  const orig = global.fetch
  global.fetch = impl
  return () => { global.fetch = orig }
}

test('fetchEngagement: unsupported platform → error', async () => {
  const r = await fetchEngagement({ source: 'medium', url: 'https://medium.com/@a/foo' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'unsupported')
})

test('fetchEngagement: reddit URL parses + returns counts', async () => {
  const restore = mockFetch(async (url) => {
    assert.match(url, /reddit\.com\/r\/SaaS\/comments\/abc123\.json$/)
    return {
      ok: true, status: 200,
      json: async () => [{ data: { children: [{ data: { num_comments: 12, score: 47 } }] } }],
    }
  })
  try {
    const r = await fetchEngagement({ source: 'reddit', url: 'https://reddit.com/r/SaaS/comments/abc123/some-title/' })
    assert.equal(r.ok, true)
    assert.equal(r.comments, 12)
    assert.equal(r.score, 47)
  } finally { restore() }
})

test('fetchEngagement: reddit 404 → post-deleted', async () => {
  const restore = mockFetch(async () => ({ ok: false, status: 404 }))
  try {
    const r = await fetchEngagement({ source: 'reddit', url: 'https://reddit.com/r/SaaS/comments/abc123/' })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'post-deleted')
  } finally { restore() }
})

test('fetchEngagement: reddit malformed URL → url-parse-failed', async () => {
  const r = await fetchEngagement({ source: 'reddit', url: 'https://example.com/not-a-reddit-link' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'url-parse-failed')
})

test('fetchEngagement: hackernews URL parses + counts descendants', async () => {
  const restore = mockFetch(async (url) => {
    assert.match(url, /hn\.algolia\.com\/api\/v1\/items\/12345$/)
    return {
      ok: true, status: 200,
      json: async () => ({
        id: 12345, points: 28,
        children: [
          { id: 1, children: [{ id: 2 }, { id: 3, children: [{ id: 4 }] }] },
          { id: 5 },
        ],
      }),
    }
  })
  try {
    const r = await fetchEngagement({ source: 'hackernews', url: 'https://news.ycombinator.com/item?id=12345' })
    assert.equal(r.ok, true)
    assert.equal(r.score, 28)
    // Descendants: 1, 2, 3, 4, 5  → 5
    assert.equal(r.comments, 5)
  } finally { restore() }
})

test('fetchEngagement: github URL works for both /issues/ and /pull/', async () => {
  const seen = []
  const restore = mockFetch(async (url) => {
    seen.push(url)
    return {
      ok: true, status: 200,
      json: async () => ({ comments: 4, reactions: { total_count: 7 } }),
    }
  })
  try {
    const r1 = await fetchEngagement({ source: 'github', url: 'https://github.com/owner/repo/issues/12' })
    assert.equal(r1.ok, true)
    assert.equal(r1.comments, 4)
    assert.equal(r1.score, 7)
    const r2 = await fetchEngagement({ source: 'github', url: 'https://github.com/owner/repo/pull/99' })
    assert.equal(r2.ok, true)
    assert.match(seen[0], /\/repos\/owner\/repo\/issues\/12$/)
    assert.match(seen[1], /\/repos\/owner\/repo\/issues\/99$/)
  } finally { restore() }
})

test('fetchEngagement: network errors caught + returned as error', async () => {
  const restore = mockFetch(async () => { throw new Error('boom') })
  try {
    const r = await fetchEngagement({ source: 'reddit', url: 'https://reddit.com/r/x/comments/y/' })
    assert.equal(r.ok, false)
    assert.match(r.error, /reddit-/)
  } finally { restore() }
})

// ── runEngagementSweep ─────────────────────────────────────────────────────

function mockRedis(state = {}) {
  const writes = []
  return {
    writes,
    async smembers(key) {
      if (key === 'insights:active_monitors') return state.activeIds || []
      return []
    },
    async lrange(key, start, end) {
      const m = key.match(/^insights:matches:(.+)$/)
      if (!m) return []
      const arr = state.matchLists?.[m[1]] || []
      return arr.slice(start, end + 1)
    },
    async get(key) {
      const m = key.match(/^insights:match:(.+):(.+)$/)
      if (!m) return null
      const r = state.matches?.[`${m[1]}:${m[2]}`]
      return r ? JSON.stringify(r) : null
    },
    async set(key, value) {
      writes.push({ key, value })
      return 'OK'
    },
  }
}

test('runEngagementSweep: empty active set → zeroed counters', async () => {
  const r = await runEngagementSweep({ redis: mockRedis() })
  assert.deepEqual(r, { scanned: 0, eligible: 0, ok: 0, error: 0, byError: {} })
})

test('runEngagementSweep: skips ineligible matches', async () => {
  const recent = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()  // 5h ago
  const checked = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  const redis = mockRedis({
    activeIds: ['m'],
    matchLists: { m: ['a', 'b', 'c'] },
    matches: {
      'm:a': { id: 'a', source: 'reddit', url: 'u', score: 1, comments: 1 },                          // no postedAt
      'm:b': { id: 'b', source: 'reddit', url: 'u', score: 1, comments: 1, postedAt: recent },        // <24h
      'm:c': { id: 'c', source: 'reddit', url: 'u', score: 1, comments: 1, postedAt: checked,
               engagement: { checkedAt: '2026-04-29T10:00:00Z' } },                                    // already checked
    },
  })
  const r = await runEngagementSweep({ redis, delayBetweenMs: 0 })
  assert.equal(r.scanned, 3)
  assert.equal(r.eligible, 0)
  assert.equal(redis.writes.length, 0)
})

test('runEngagementSweep: writes engagement record on eligible match', async () => {
  const postedLongAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const redis = mockRedis({
    activeIds: ['m'],
    matchLists: { m: ['a'] },
    matches: {
      'm:a': {
        id: 'a', source: 'reddit',
        url: 'https://reddit.com/r/SaaS/comments/abc123/title',
        score: 5, comments: 3,
        postedAt: postedLongAgo,
      },
    },
  })
  const restore = mockFetch(async () => ({
    ok: true, status: 200,
    json: async () => [{ data: { children: [{ data: { num_comments: 8, score: 12 } }] } }],
  }))
  try {
    const r = await runEngagementSweep({ redis, delayBetweenMs: 0 })
    assert.equal(r.eligible, 1)
    assert.equal(r.ok, 1)
    assert.equal(r.error, 0)
    assert.equal(redis.writes.length, 1)
    const stored = JSON.parse(redis.writes[0].value)
    assert.equal(stored.engagement.commentsDelta, 5)
    assert.equal(stored.engagement.scoreDelta,    7)
    assert.equal(stored.engagement.gotEngagement, true)
    assert.equal(stored.engagement.error, null)
  } finally { restore() }
})

test('runEngagementSweep: records error reason when fetch fails', async () => {
  const postedLongAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const redis = mockRedis({
    activeIds: ['m'],
    matchLists: { m: ['a'] },
    matches: {
      'm:a': {
        id: 'a', source: 'reddit',
        url: 'https://reddit.com/r/x/comments/y/',
        score: 1, comments: 1,
        postedAt: postedLongAgo,
      },
    },
  })
  const restore = mockFetch(async () => ({ ok: false, status: 404 }))
  try {
    const r = await runEngagementSweep({ redis, delayBetweenMs: 0 })
    assert.equal(r.error, 1)
    assert.equal(r.ok, 0)
    assert.equal(r.byError['post-deleted'], 1)
    const stored = JSON.parse(redis.writes[0].value)
    assert.equal(stored.engagement.error, 'post-deleted')
    assert.equal(stored.engagement.gotEngagement, false)
  } finally { restore() }
})

test('runEngagementSweep: marks unsupported platforms as error so they\'re not retried', async () => {
  const postedLongAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const redis = mockRedis({
    activeIds: ['m'],
    matchLists: { m: ['a'] },
    matches: {
      'm:a': {
        id: 'a', source: 'medium',
        url: 'https://medium.com/@a/post',
        score: 0, comments: 0,
        postedAt: postedLongAgo,
      },
    },
  })
  // No need to mock fetch — fetchEngagement short-circuits before fetch call.
  const r = await runEngagementSweep({ redis, delayBetweenMs: 0 })
  assert.equal(r.eligible, 1)
  assert.equal(r.error, 1)
  assert.equal(r.byError.unsupported, 1)
  const stored = JSON.parse(redis.writes[0].value)
  // engagement is recorded so we don't keep re-checking; checkedAt is set
  assert.equal(stored.engagement.error, 'unsupported')
  assert.ok(stored.engagement.checkedAt)
})

// ── _internals ────────────────────────────────────────────────────────────

test('_internals: TWENTY_FOUR_HOURS_MS = 24 * 3600 * 1000', () => {
  assert.equal(_internals.TWENTY_FOUR_HOURS_MS, ONE_DAY_MS)
})

test('_internals.SUPPORTED_PLATFORMS: locked-in', () => {
  // Locked-in: extending requires a new fetcher implementation. Twitter,
  // Substack, Medium, etc. are intentionally NOT here yet.
  const expected = new Set(['reddit', 'hackernews', 'github'])
  assert.equal(_internals.SUPPORTED_PLATFORMS.size, expected.size)
  for (const p of expected) assert.ok(_internals.SUPPORTED_PLATFORMS.has(p), `missing ${p}`)
})

test('_internals.countDescendants: handles deep trees', () => {
  const tree = [
    { id: 1, children: [{ id: 2, children: [{ id: 3, children: [{ id: 4 }] }] }] },
    { id: 5 },
  ]
  assert.equal(_internals.countDescendants(tree), 5)
})
