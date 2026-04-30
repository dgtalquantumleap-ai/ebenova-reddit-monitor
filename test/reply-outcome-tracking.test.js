// Reply Outcome Tracking — the ROI-proof feature.
//
// Pins every guarantee the dashboard's outcomes endpoint and the digest's
// Reply Performance section depend on:
//   - scheduleEngagementCheck adds the right item shape to the right list
//   - processPendingChecks defers items not yet due, processes due ones,
//     gracefully handles a null fetch result, never throws
//   - the outcomes endpoint shape is correct under empty + populated states
//   - the digest's outcomes section appears only when there's something to say

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'
import {
  scheduleEngagementCheck,
  processPendingChecks,
  getRecentOutcomes,
  matchGotEngagement,
  _internals,
} from '../lib/reply-tracker.js'
import { renderOutcomesSection } from '../lib/weekly-digest.js'

const { PENDING_DELAY_MS, pendingKey, FETCHERS } = _internals

// ── 1. scheduleEngagementCheck adds an item to Redis list ──────────────────

test('1. scheduleEngagementCheck() pushes the item with the right shape', async () => {
  const redis = createMockRedis()
  const now = Date.now()
  const r = await scheduleEngagementCheck({
    redis, monitorId: 'm1',
    match: { id: 'match-x', url: 'https://reddit.com/r/x/comments/abc/title', source: 'reddit', subreddit: 'x', score: 5, comments: 1 },
    now,
  })
  assert.equal(r.scheduled, true)
  assert.equal(r.scheduledFor, now + PENDING_DELAY_MS)

  const raws = await redis.lrange(pendingKey('m1'), 0, -1)
  assert.equal(raws.length, 1)
  const item = JSON.parse(raws[0])
  assert.equal(item.matchId,        'match-x')
  assert.equal(item.url,            'https://reddit.com/r/x/comments/abc/title')
  assert.equal(item.source,         'reddit')
  assert.equal(item.storedScore,    5)
  assert.equal(item.storedComments, 1)
  assert.equal(item.scheduledFor,   now + PENDING_DELAY_MS)
  assert.equal(item.monitorId,      'm1')
})

test('1b. scheduleEngagementCheck() refuses with missing args', async () => {
  const redis = createMockRedis()
  assert.equal((await scheduleEngagementCheck({ redis })).scheduled, false)
  assert.equal((await scheduleEngagementCheck({ redis, monitorId: 'm1' })).scheduled, false)
  assert.equal((await scheduleEngagementCheck({ redis, monitorId: 'm1', match: {} })).scheduled, false)
})

// ── 2. processPendingChecks skips not-yet-due items ────────────────────────

test('2. processPendingChecks() defers items whose scheduledFor is still in the future', async () => {
  const redis = createMockRedis()
  const now = Date.now()
  await scheduleEngagementCheck({
    redis, monitorId: 'm1',
    match: { id: 'future-match', url: 'https://reddit.com/r/x/comments/abc/title', source: 'reddit', score: 0, comments: 0 },
    now,   // scheduledFor = now + 24h
  })
  // Process at "now" — nothing should be due yet.
  const r = await processPendingChecks({ redis, monitorId: 'm1', now })
  assert.equal(r.scanned,   1)
  assert.equal(r.deferred,  1)
  assert.equal(r.processed, 0)
  // Item is still on the queue (got re-pushed to the tail).
  const remaining = await redis.lrange(pendingKey('m1'), 0, -1)
  assert.equal(remaining.length, 1)
})

// ── 3. processPendingChecks runs items that are due ─────────────────────────

test('3. processPendingChecks() processes items past scheduledFor', async () => {
  const redis = createMockRedis()
  // Seed a match record (the processor reads this to base the writeback on).
  const matchKey = 'insights:match:m1:due-match'
  await redis.set(matchKey, JSON.stringify({
    id: 'due-match', url: 'https://reddit.com/r/x/comments/abc/title',
    source: 'reddit', score: 0, comments: 0,
  }))
  // Schedule from a past time so by "now" the +24h is already in the past.
  const longAgo = Date.now() - 25 * 60 * 60 * 1000
  await scheduleEngagementCheck({
    redis, monitorId: 'm1',
    match: { id: 'due-match', url: 'https://reddit.com/r/x/comments/abc/title', source: 'reddit', score: 0, comments: 0 },
    now: longAgo,
  })
  // Mock the Reddit fetcher with a reasonable engagement bump.
  const original = FETCHERS.reddit
  FETCHERS.reddit = async () => ({ ok: true, score: 7, comments: 4 })
  try {
    const r = await processPendingChecks({ redis, monitorId: 'm1' })
    assert.equal(r.scanned,   1)
    assert.equal(r.processed, 1)
    assert.equal(r.ok,        1)
    // Queue is empty after processing.
    const remaining = await redis.lrange(pendingKey('m1'), 0, -1)
    assert.equal(remaining.length, 0)
  } finally {
    FETCHERS.reddit = original
  }
})

// ── 4. processPendingChecks stores engagementDelta on the match ────────────

test('4. processPendingChecks() writes match.engagementDelta with the right shape', async () => {
  const redis = createMockRedis()
  const matchKey = 'insights:match:m1:due-match'
  await redis.set(matchKey, JSON.stringify({
    id: 'due-match', url: 'https://reddit.com/r/x/comments/abc/title',
    source: 'reddit', score: 0, comments: 0,
  }))
  const longAgo = Date.now() - 25 * 60 * 60 * 1000
  await scheduleEngagementCheck({
    redis, monitorId: 'm1',
    match: { id: 'due-match', url: 'https://reddit.com/r/x/comments/abc/title', source: 'reddit', score: 0, comments: 0 },
    now: longAgo,
  })
  const original = FETCHERS.reddit
  FETCHERS.reddit = async () => ({ ok: true, score: 12, comments: 3 })
  try {
    await processPendingChecks({ redis, monitorId: 'm1' })
    const stored = JSON.parse(await redis.get(matchKey))
    assert.ok(stored.engagementDelta, 'engagementDelta must be set')
    assert.equal(stored.engagementDelta.commentsDelta, 3)
    assert.equal(stored.engagementDelta.scoreDelta,    12)
    assert.equal(typeof stored.engagementDelta.checkedAt, 'string')
  } finally {
    FETCHERS.reddit = original
  }
})

// ── 5. gotEngagement is true when commentsDelta > 0 ────────────────────────

test('5. processPendingChecks() sets gotEngagement=true when commentsDelta > 0', async () => {
  const redis = createMockRedis()
  await redis.set('insights:match:m1:c1', JSON.stringify({
    id: 'c1', url: 'https://reddit.com/r/x/comments/c1/title',
    source: 'reddit', score: 0, comments: 0,
  }))
  const longAgo = Date.now() - 25 * 60 * 60 * 1000
  await scheduleEngagementCheck({
    redis, monitorId: 'm1',
    match: { id: 'c1', url: 'https://reddit.com/r/x/comments/c1/title', source: 'reddit', score: 0, comments: 0 },
    now: longAgo,
  })
  const original = FETCHERS.reddit
  FETCHERS.reddit = async () => ({ ok: true, score: 1, comments: 1 })   // +1 comment, +1 score
  try {
    await processPendingChecks({ redis, monitorId: 'm1' })
    const stored = JSON.parse(await redis.get('insights:match:m1:c1'))
    assert.equal(stored.gotEngagement, true, 'commentsDelta=1 should mark gotEngagement=true')
  } finally {
    FETCHERS.reddit = original
  }
})

test('5b. gotEngagement=false when commentsDelta=0 and scoreDelta<=2', async () => {
  const redis = createMockRedis()
  await redis.set('insights:match:m1:c2', JSON.stringify({
    id: 'c2', url: 'https://reddit.com/r/x/comments/c2/title',
    source: 'reddit', score: 0, comments: 0,
  }))
  const longAgo = Date.now() - 25 * 60 * 60 * 1000
  await scheduleEngagementCheck({
    redis, monitorId: 'm1',
    match: { id: 'c2', url: 'https://reddit.com/r/x/comments/c2/title', source: 'reddit', score: 0, comments: 0 },
    now: longAgo,
  })
  const original = FETCHERS.reddit
  FETCHERS.reddit = async () => ({ ok: true, score: 1, comments: 0 })   // 0 comments, +1 score
  try {
    await processPendingChecks({ redis, monitorId: 'm1' })
    const stored = JSON.parse(await redis.get('insights:match:m1:c2'))
    assert.equal(stored.gotEngagement, false)
  } finally {
    FETCHERS.reddit = original
  }
})

// ── 6. graceful null from fetchEngagementDelta ─────────────────────────────

test('6. processPendingChecks() handles fetcher returning null gracefully', async () => {
  const redis = createMockRedis()
  await redis.set('insights:match:m1:dead', JSON.stringify({
    id: 'dead', url: 'https://reddit.com/r/x/comments/dead/title',
    source: 'reddit', score: 0, comments: 0,
  }))
  const longAgo = Date.now() - 25 * 60 * 60 * 1000
  await scheduleEngagementCheck({
    redis, monitorId: 'm1',
    match: { id: 'dead', url: 'https://reddit.com/r/x/comments/dead/title', source: 'reddit', score: 0, comments: 0 },
    now: longAgo,
  })
  const original = FETCHERS.reddit
  FETCHERS.reddit = async () => ({ ok: false, error: 'post-deleted' })
  try {
    const r = await processPendingChecks({ redis, monitorId: 'm1' })
    assert.equal(r.processed, 1)
    assert.equal(r.failed,    1)
    assert.equal(r.ok,        0)
    // Match record must NOT have engagementDelta set when fetch returned null.
    const stored = JSON.parse(await redis.get('insights:match:m1:dead'))
    assert.equal(stored.engagementDelta, undefined)
    // Item dropped from queue (no infinite retry).
    const remaining = await redis.lrange(pendingKey('m1'), 0, -1)
    assert.equal(remaining.length, 0)
  } finally {
    FETCHERS.reddit = original
  }
})

// ── 7. GET /v1/monitors/:id/outcomes returns correct structure ─────────────

test('7. getRecentOutcomes returns the spec\'d shape with sorted topPerforming', async () => {
  const redis = createMockRedis()
  // Seed the matches list + 3 posted matches with varying engagement.
  const now = Date.now()
  await redis.lpush('insights:matches:m1', 'a', 'b', 'c')
  await redis.set('insights:match:m1:a', JSON.stringify({
    id: 'a', title: 'A title', url: 'https://x/a',
    postedAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
    engagementDelta: { commentsDelta: 5, scoreDelta: 10, checkedAt: '2026-04-01' },
    gotEngagement: true,
  }))
  await redis.set('insights:match:m1:b', JSON.stringify({
    id: 'b', title: 'B title', url: 'https://x/b',
    postedAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
    engagementDelta: { commentsDelta: 12, scoreDelta: 3, checkedAt: '2026-04-02' },
    gotEngagement: true,
  }))
  await redis.set('insights:match:m1:c', JSON.stringify({
    id: 'c', title: 'C title', url: 'https://x/c',
    postedAt: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
    // No delta — posted but no engagement record yet.
  }))

  const out = await getRecentOutcomes({ redis, monitorId: 'm1', days: 30, now })
  assert.equal(out.posted,  3)
  assert.equal(out.engaged, 2)
  assert.equal(out.rateLabel, '67%')
  // topPerforming sorted by commentsDelta desc — B (12) before A (5).
  assert.equal(out.topPerforming.length, 2)
  assert.equal(out.topPerforming[0].matchId, 'b')
  assert.equal(out.topPerforming[0].commentsDelta, 12)
  assert.equal(out.topPerforming[1].matchId, 'a')
  // recent newest-first by postedAt — C, B, A.
  assert.deepEqual(out.recent.map(r => r.matchId), ['c', 'b', 'a'])
})

// ── 8. Outcomes endpoint requires auth (handler-shape probe) ───────────────
// (Auth-gating itself is tested in the api-server suite via authenticate().
// Here we just pin the data layer's contract: empty store → empty result.)

test('8. getRecentOutcomes returns zero/empty when monitor has no posted matches', async () => {
  const redis = createMockRedis()
  const out = await getRecentOutcomes({ redis, monitorId: 'never-existed' })
  assert.equal(out.posted, 0)
  assert.equal(out.engaged, 0)
  assert.equal(out.rateLabel, '0%')
  assert.deepEqual(out.recent, [])
  assert.deepEqual(out.topPerforming, [])
})

// ── 9. engagementRate formatted as percentage string ──────────────────────

test('9. engagementRate is a percentage string with no decimals', async () => {
  const redis = createMockRedis()
  // 1 of 3 posted matches engaged → 33%.
  const now = Date.now()
  await redis.lpush('insights:matches:m1', 'p1', 'p2', 'p3')
  for (const id of ['p1', 'p2', 'p3']) {
    await redis.set(`insights:match:m1:${id}`, JSON.stringify({
      id, postedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      gotEngagement: id === 'p1',
      engagementDelta: id === 'p1' ? { commentsDelta: 1, scoreDelta: 0, checkedAt: 'x' } : undefined,
    }))
  }
  const out = await getRecentOutcomes({ redis, monitorId: 'm1', now })
  assert.match(out.rateLabel, /^\d+%$/)
  assert.equal(out.rateLabel, '33%')
})

// ── 10. topPerforming is sorted by commentsDelta descending ───────────────

test('10. topPerforming sorts by commentsDelta desc, ties broken by scoreDelta', async () => {
  const redis = createMockRedis()
  const now = Date.now()
  await redis.lpush('insights:matches:m1', 'a', 'b', 'c', 'd')
  const seed = (id, c, s) => redis.set(`insights:match:m1:${id}`, JSON.stringify({
    id, title: `T-${id}`, url: `https://x/${id}`,
    postedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    engagementDelta: { commentsDelta: c, scoreDelta: s, checkedAt: 'x' },
    gotEngagement: c > 0,
  }))
  await seed('a', 1, 50)
  await seed('b', 5, 0)
  await seed('c', 5, 10)
  await seed('d', 0, 99)
  const out = await getRecentOutcomes({ redis, monitorId: 'm1', now })
  // c(5,10) > b(5,0) > a(1,50). d has no commentsDelta or scoreDelta>0 — wait
  // d HAS scoreDelta=99 but commentsDelta=0. Spec: top = comments-driven.
  // Our impl includes anything with c>0 OR s>0, sorts by c then s.
  // Expected order with c desc, s desc: c(5,10), b(5,0), a(1,50), d(0,99).
  assert.deepEqual(out.topPerforming.map(t => t.matchId), ['c', 'b', 'a'])
})

// ── 11. weekly digest outcomes section appears when posts exist ────────────

test('11. renderOutcomesSection produces HTML when postedCount > 0', () => {
  const html = renderOutcomesSection({
    postedCount: 4,
    engagedCount: 2,
    bestPerformer: { title: 'My great reply', url: 'https://x/y', commentsDelta: 6, scoreDelta: 9 },
  })
  assert.notEqual(html, '')
  assert.match(html, /Reply performance this week/i)
  // The HTML has "Replies posted:</strong> 4" — let the regex skip
  // the closing tag before the number.
  assert.match(html, /Replies posted:[\s\S]*?4/)
  assert.match(html, /Got engagement:[\s\S]*?2/)
  assert.match(html, /50%/)
  assert.match(html, /My great reply/)
  assert.match(html, /\+6 comments/)
})

// ── 12. weekly digest skips outcomes section when nothing posted ───────────

test('12. renderOutcomesSection returns empty string when postedCount is 0', () => {
  assert.equal(renderOutcomesSection({ postedCount: 0, engagedCount: 0 }), '')
  assert.equal(renderOutcomesSection({}), '')
  assert.equal(renderOutcomesSection(null), '')
})

// ── matchGotEngagement honors both writeback shapes ────────────────────────

test('matchGotEngagement reads top-level gotEngagement (new) AND nested engagement.gotEngagement (legacy)', () => {
  assert.equal(matchGotEngagement({ gotEngagement: true }),                          true)
  assert.equal(matchGotEngagement({ engagement: { gotEngagement: true } }),          true)
  assert.equal(matchGotEngagement({ gotEngagement: false }),                         false)
  assert.equal(matchGotEngagement({ engagement: { gotEngagement: false } }),         false)
  assert.equal(matchGotEngagement({}),                                               false)
  assert.equal(matchGotEngagement(null),                                             false)
})
