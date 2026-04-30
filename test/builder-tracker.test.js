// Builder Tracker (Roadmap PR #31) — full coverage of the spec'd API surface.
// Steven Musielski's $50/month engagement is what these guarantees underwrite,
// so the tests are explicit about edge cases (placeholder authors, empty
// topics, consistency thresholds, CSV escaping).

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'
import {
  isBuilderPost, scoreConsistency,
  recordBuilderProfile, getBuilderProfiles,
  buildersToCSV, BUILDER_CSV_COLUMNS,
  PLATFORMS_WITH_REAL_USERNAMES,
  renderBuilderDigest, sendBuilderDigest,
  _internals,
} from '../lib/builder-tracker.js'

// ─── 1. isBuilderPost — positive signals ────────────────────────────────────

test('isBuilderPost: detects "building" / "shipped" / "launched" signals', () => {
  assert.equal(isBuilderPost({ title: 'Just shipped my SaaS for indie devs', body: '' }), true)
  assert.equal(isBuilderPost({ title: 'Launched my MVP today!', body: '' }), true)
  assert.equal(isBuilderPost({ title: 'Building a tool for builders', body: '' }), true)
  assert.equal(isBuilderPost({ title: '', body: 'I just released my newsletter platform' }), true)
})

test('isBuilderPost: detects "day N of building/launching" pattern', () => {
  assert.equal(isBuilderPost({ title: 'Day 14 of building my SaaS', body: '' }), true)
  assert.equal(isBuilderPost({ title: 'Week 3 of shipping daily', body: '' }), true)
  assert.equal(isBuilderPost({ title: 'Month 2 of building in public', body: '' }), true)
})

// ─── 2. isBuilderPost — anti-signals ────────────────────────────────────────

test('isBuilderPost: rejects help/complaint posts when no positive signal', () => {
  assert.equal(isBuilderPost({ title: 'Anyone know a good ORM for Postgres?', body: '' }), false)
  assert.equal(isBuilderPost({ title: 'Help! My deploy keeps failing', body: 'getting an error' }), false)
  assert.equal(isBuilderPost({ title: 'Looking for recommendations on a CRM', body: '' }), false)
})

test('isBuilderPost: builder signal beats anti-signal in a tie (inclusive filter)', () => {
  // "shipped" is a positive — even though "problem" appears, prefer the build
  // interpretation per spec. Better to extract topics on a borderline post
  // than miss a real builder.
  assert.equal(isBuilderPost({ title: 'Shipped a fix for a problem I had', body: '' }), true)
})

test('isBuilderPost: ambiguous (no positive, no anti-signal) returns true', () => {
  // Per spec: "If ambiguous, returns true" — try rather than skip.
  assert.equal(isBuilderPost({ title: 'Some random title', body: 'some random body' }), true)
})

test('isBuilderPost: rejects empty / null / no-text posts', () => {
  assert.equal(isBuilderPost(null), false)
  assert.equal(isBuilderPost({}), false)
  assert.equal(isBuilderPost({ title: '', body: '' }), false)
  assert.equal(isBuilderPost({ title: '   ', body: '' }), false)
})

// ─── 3. scoreConsistency thresholds ─────────────────────────────────────────

test('scoreConsistency: "daily" requires >=5 posts within 7 days', () => {
  assert.equal(scoreConsistency(5, 7), 'daily')
  assert.equal(scoreConsistency(10, 3), 'daily')
  assert.equal(scoreConsistency(5, 8), 'weekly')   // 8 days — bumps down
  assert.equal(scoreConsistency(4, 7), 'weekly')   // 4 posts — bumps down
})

test('scoreConsistency: "weekly" requires >=2 posts within 14 days', () => {
  assert.equal(scoreConsistency(2, 0), 'weekly')
  assert.equal(scoreConsistency(2, 14), 'weekly')
  assert.equal(scoreConsistency(3, 10), 'weekly')
  assert.equal(scoreConsistency(2, 15), 'occasional')  // 15 days bumps down
})

test('scoreConsistency: "occasional" is the default fallback', () => {
  assert.equal(scoreConsistency(0, 0), 'occasional')
  assert.equal(scoreConsistency(1, 0), 'occasional')
  assert.equal(scoreConsistency(1, 100), 'occasional')
})

test('scoreConsistency: handles non-numeric / NaN inputs as 0', () => {
  assert.equal(scoreConsistency(undefined, undefined), 'occasional')
  assert.equal(scoreConsistency('abc', 'def'), 'occasional')
})

// ─── 4. PLATFORMS_WITH_REAL_USERNAMES — locked list ─────────────────────────

test('PLATFORMS_WITH_REAL_USERNAMES is the spec-locked set of 6', () => {
  // The Builder Tracker only writes profiles for platforms whose author field
  // is a real human handle. quora/upwork/fiverr/medium hardcode the platform
  // name as `author`, which would corrupt the dataset.
  assert.deepEqual(
    [...PLATFORMS_WITH_REAL_USERNAMES].sort(),
    ['github', 'hackernews', 'producthunt', 'reddit', 'substack', 'twitter'],
  )
})

// ─── 5. recordBuilderProfile — happy path ───────────────────────────────────

test('recordBuilderProfile: writes hash + adds to index set on first sighting', async () => {
  const redis = createMockRedis()
  const r = await recordBuilderProfile({
    redis, monitorId: 'm1',
    match: {
      source: 'reddit', author: 'alex_indie',
      title: 'Just launched my SaaS', body: 'tldr; built it in 2 weeks',
      url: 'https://reddit.com/r/sideproject/comments/x',
      createdAt: '2026-04-01T00:00:00.000Z',
    },
    topics: ['SaaS tool', 'developer tool'],
  })
  assert.equal(r.recorded, true)
  assert.equal(r.isNew, true)
  assert.equal(r.postCount, 1)

  const hash = await redis.hgetall('builder:m1:reddit:alex_indie')
  assert.equal(hash.username, 'alex_indie')
  assert.equal(hash.platform, 'reddit')
  assert.equal(hash.postCount, '1')
  assert.equal(hash.profileUrl, 'https://reddit.com/u/alex_indie')
  assert.deepEqual(JSON.parse(hash.topics), ['SaaS tool', 'developer tool'])

  const idx = await redis.smembers('builder:list:m1')
  assert.deepEqual(idx, ['reddit:alex_indie'])
})

// ─── 6. recordBuilderProfile — second sighting increments + merges ──────────

test('recordBuilderProfile: second sighting increments postCount, merges topics, recomputes consistency', async () => {
  const redis = createMockRedis()
  const base = {
    source: 'github', author: 'octobuilder',
    url: 'https://github.com/octobuilder/tool',
  }
  await recordBuilderProfile({
    redis, monitorId: 'm1',
    match: { ...base, title: 'Building a CLI tool', createdAt: '2026-04-01T00:00:00.000Z' },
    topics: ['CLI tool'],
  })
  const r2 = await recordBuilderProfile({
    redis, monitorId: 'm1',
    match: { ...base, title: 'Shipped a v2', createdAt: '2026-04-05T00:00:00.000Z' },
    topics: ['developer tool', 'CLI tool'],   // overlapping topic — should dedupe
  })
  assert.equal(r2.isNew, false)
  assert.equal(r2.postCount, 2)

  const hash = await redis.hgetall('builder:m1:github:octobuilder')
  assert.equal(hash.postCount, '2')
  assert.equal(hash.firstSeen, '2026-04-01T00:00:00.000Z')
  assert.equal(hash.lastSeen,  '2026-04-05T00:00:00.000Z')
  assert.equal(hash.consistency, 'weekly')   // 2 posts, 4-day span
  assert.equal(hash.latestPostTitle, 'Shipped a v2')

  const merged = JSON.parse(hash.topics)
  assert.deepEqual([...merged].sort(), ['CLI tool', 'developer tool'])
})

// ─── 7. recordBuilderProfile — placeholder author / unsupported platform ────

test('recordBuilderProfile: skips platforms whose `author` is hardcoded (quora/upwork/etc)', async () => {
  const redis = createMockRedis()
  for (const p of ['quora', 'upwork', 'fiverr', 'medium']) {
    const r = await recordBuilderProfile({
      redis, monitorId: 'm1',
      match: { source: p, author: p, title: 'Building', createdAt: '2026-04-01T00:00:00.000Z' },
      topics: [],
    })
    assert.equal(r.recorded, false)
    assert.equal(r.reason, 'platform-not-supported')
  }
  const idx = await redis.smembers('builder:list:m1')
  assert.deepEqual(idx, [])
})

test('recordBuilderProfile: skips when author is missing', async () => {
  const redis = createMockRedis()
  const r = await recordBuilderProfile({
    redis, monitorId: 'm1',
    match: { source: 'reddit', author: '', title: 'Building', createdAt: '2026-04-01T00:00:00.000Z' },
  })
  assert.equal(r.recorded, false)
  assert.equal(r.reason, 'no-author')
})

// ─── 8. getBuilderProfiles — sort + cap ─────────────────────────────────────

test('getBuilderProfiles: returns profiles sorted by postCount desc, capped at limit', async () => {
  const redis = createMockRedis()
  const make = async (username, postCount, platform = 'reddit') => {
    for (let i = 0; i < postCount; i++) {
      await recordBuilderProfile({
        redis, monitorId: 'm1',
        match: {
          source: platform, author: username,
          title: `post ${i}`, body: '',
          url: `https://example.com/${i}`,
          createdAt: new Date(Date.UTC(2026, 3, i + 1)).toISOString(),
        },
        topics: [],
      })
    }
  }
  await make('alice',  3)
  await make('bob',    7)
  await make('carol',  1)

  const profiles = await getBuilderProfiles({ redis, monitorId: 'm1' })
  assert.equal(profiles.length, 3)
  assert.deepEqual(profiles.map(p => p.username), ['bob', 'alice', 'carol'])
  assert.equal(profiles[0].postCount, 7)

  const capped = await getBuilderProfiles({ redis, monitorId: 'm1', limit: 2 })
  assert.equal(capped.length, 2)
  assert.deepEqual(capped.map(p => p.username), ['bob', 'alice'])
})

test('getBuilderProfiles: empty / missing monitor returns []', async () => {
  const redis = createMockRedis()
  assert.deepEqual(await getBuilderProfiles({ redis, monitorId: 'never-existed' }), [])
  assert.deepEqual(await getBuilderProfiles({}), [])
})

// ─── 9. profileUrl per platform (via internals) ─────────────────────────────

test('profile URL is generated per platform with the right pattern', () => {
  const { profileUrl } = _internals
  assert.equal(profileUrl('reddit',      'alex'),    'https://reddit.com/u/alex')
  assert.equal(profileUrl('hackernews',  'pg'),      'https://news.ycombinator.com/user?id=pg')
  assert.equal(profileUrl('github',      'octocat'), 'https://github.com/octocat')
  assert.equal(profileUrl('producthunt', 'rich'),    'https://www.producthunt.com/@rich')
  assert.equal(profileUrl('twitter',     'naval'),   'https://x.com/naval')
  assert.equal(profileUrl('substack',    'anyone'),  '')   // no canonical URL pattern
  assert.equal(profileUrl('unknown',     'x'),       '')
})

// ─── 10. CSV export ─────────────────────────────────────────────────────────

test('BUILDER_CSV_COLUMNS is the spec-locked column order', () => {
  assert.deepEqual(BUILDER_CSV_COLUMNS, [
    'platform', 'username', 'profileUrl', 'firstSeen', 'lastSeen',
    'postCount', 'consistency', 'topics',
    'latestPostTitle', 'latestPostUrl',
  ])
})

test('buildersToCSV: empty list → header-only CSV', () => {
  const csv = buildersToCSV([])
  const lines = csv.split('\r\n').filter(Boolean)
  assert.equal(lines.length, 1)
  assert.equal(lines[0], BUILDER_CSV_COLUMNS.join(','))
})

test('buildersToCSV: serializes profiles with topics joined by " | "', () => {
  const csv = buildersToCSV([
    {
      platform: 'reddit', username: 'alex', profileUrl: 'https://reddit.com/u/alex',
      firstSeen: '2026-04-01T00:00:00.000Z', lastSeen: '2026-04-05T00:00:00.000Z',
      postCount: 3, consistency: 'weekly',
      topics: ['SaaS tool', 'developer tool'],
      latestPostTitle: 'Just shipped v2',
      latestPostUrl: 'https://reddit.com/r/sideproject/comments/x',
    },
  ])
  const lines = csv.split('\r\n').filter(Boolean)
  assert.equal(lines.length, 2)
  assert.match(lines[1], /^reddit,alex,/)
  assert.match(lines[1], /SaaS tool \| developer tool/)
  assert.match(lines[1], /Just shipped v2/)
})

test('buildersToCSV: RFC 4180 escapes commas, quotes, and newlines in cell values', () => {
  const csv = buildersToCSV([
    {
      platform: 'reddit', username: 'al,ex', profileUrl: '',
      firstSeen: '', lastSeen: '', postCount: 1, consistency: 'occasional',
      topics: ['has, comma', 'has "quote"'],
      latestPostTitle: 'has\nnewline',
      latestPostUrl: '',
    },
  ])
  // Username with a comma must be quoted.
  assert.match(csv, /"al,ex"/)
  // Quote escaping: " becomes ""
  assert.match(csv, /""quote""/)
  // Newline in title forces quoting of that cell.
  assert.match(csv, /"has\nnewline"/)
})

// ─── 11. renderBuilderDigest pure renderer ──────────────────────────────────

test('renderBuilderDigest: returns subject + html, includes monitor name and counts', () => {
  const out = renderBuilderDigest({
    monitor: { id: 'm1', name: 'My Tracker', unsubscribeToken: 'unsub-tok' },
    newProfiles: [
      { username: 'alex', platform: 'reddit', postCount: 1, consistency: 'occasional', latestPostTitle: 'Shipped', latestPostUrl: 'https://r/x', profileUrl: 'https://reddit.com/u/alex' },
    ],
    topProfiles: [
      { username: 'bob', platform: 'github', postCount: 7, consistency: 'daily' },
    ],
    appUrl: 'https://example.test',
  })
  assert.match(out.subject, /1 new builder/)
  assert.match(out.subject, /My Tracker/)
  assert.match(out.html, /alex/)
  assert.match(out.html, /Shipped/)
  assert.match(out.html, /bob/)
  assert.match(out.html, /unsub-tok/)
  assert.match(out.html, /example\.test/)
})

test('renderBuilderDigest: pluralizes correctly for 0 / 1 / many builders', () => {
  const base = { monitor: { id: 'm1', name: 'X' }, topProfiles: [], appUrl: 'https://x' }
  assert.match(renderBuilderDigest({ ...base, newProfiles: [] }).subject,    /0 new builders/)
  assert.match(
    renderBuilderDigest({ ...base, newProfiles: [{ username: 'a', platform: 'reddit', postCount: 1 }] }).subject,
    /1 new builder /,
  )
  assert.match(
    renderBuilderDigest({ ...base, newProfiles: [
      { username: 'a', platform: 'reddit', postCount: 1 },
      { username: 'b', platform: 'github', postCount: 2 },
    ] }).subject,
    /2 new builders/,
  )
})

// ─── 12. sendBuilderDigest — guards ─────────────────────────────────────────

test('sendBuilderDigest: refuses to send when emailEnabled is false', async () => {
  const sent = []
  const fakeResend = { emails: { send: async (args) => { sent.push(args); return { id: 'x' } } } }
  const r = await sendBuilderDigest({
    monitor: { id: 'm1', name: 'X', alertEmail: 'me@x.test', emailEnabled: false },
    newProfiles: [{ username: 'a', platform: 'reddit', postCount: 1 }],
    topProfiles: [],
    resend: fakeResend, fromEmail: 'noreply@x.test',
  })
  assert.equal(r.sent, false)
  assert.equal(r.reason, 'email-disabled')
  assert.equal(sent.length, 0)
})

test('sendBuilderDigest: refuses to send when no new builders', async () => {
  const fakeResend = { emails: { send: async () => { throw new Error('should not be called') } } }
  const r = await sendBuilderDigest({
    monitor: { id: 'm1', name: 'X', alertEmail: 'me@x.test' },
    newProfiles: [],
    topProfiles: [],
    resend: fakeResend, fromEmail: 'noreply@x.test',
  })
  assert.equal(r.sent, false)
  assert.equal(r.reason, 'no-new-builders')
})

test('sendBuilderDigest: sends via resend when conditions are met', async () => {
  const sent = []
  const fakeResend = { emails: { send: async (args) => { sent.push(args); return { id: 'msg-id' } } } }
  const r = await sendBuilderDigest({
    monitor: { id: 'm1', name: 'My Tracker', alertEmail: 'me@x.test' },
    newProfiles: [{ username: 'alex', platform: 'reddit', postCount: 1 }],
    topProfiles: [],
    resend: fakeResend, fromEmail: 'noreply@x.test',
  })
  assert.equal(r.sent, true)
  assert.equal(r.count, 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].to, 'me@x.test')
  assert.match(sent[0].subject, /1 new builder/)
})
