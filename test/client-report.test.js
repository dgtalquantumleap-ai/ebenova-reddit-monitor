import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  resolveReportToken,
  gatherReportData,
  buildExecutiveSummary,
  renderReportHtml,
  _internals,
} from '../lib/client-report.js'

// ── Mock redis (mirrors test/weekly-digest.test.js shape) ──────────────────

function mockRedis(state = {}) {
  return {
    async get(key) {
      // report:token:<x> → monitorId
      const tokMatch = key.match(/^report:token:(.+)$/)
      if (tokMatch) return state.tokenToMonitor?.[tokMatch[1]] || null
      // insights:monitor:<id> → monitor record (JSON string)
      const monMatch = key.match(/^insights:monitor:(.+)$/)
      if (monMatch) {
        const r = state.monitors?.[monMatch[1]]
        return r ? JSON.stringify(r) : null
      }
      // insights:match:<mon>:<id> → match record
      const matchMatch = key.match(/^insights:match:(.+):(.+)$/)
      if (matchMatch) {
        const r = state.matches?.[`${matchMatch[1]}:${matchMatch[2]}`]
        return r ? JSON.stringify(r) : null
      }
      return null
    },
    async lrange(key, start, end) {
      const m = key.match(/^insights:matches:(.+)$/)
      if (!m) return []
      const list = state.matchLists?.[m[1]] || []
      return list.slice(start, end + 1)
    },
    async smembers(key) {
      const m = key.match(/^author:list:(.+)$/)
      if (!m) return []
      return state.authorLists?.[m[1]] || []
    },
    async hgetall(key) {
      // author:profile:<mon>:<platform>:<username>
      return state.authorProfiles?.[key] || null
    },
  }
}

// ── resolveReportToken ─────────────────────────────────────────────────────

test('resolveReportToken: rejects empty/invalid input', async () => {
  const r = mockRedis()
  assert.equal(await resolveReportToken(r, null),       null)
  assert.equal(await resolveReportToken(r, ''),         null)
  assert.equal(await resolveReportToken(r, undefined),  null)
  assert.equal(await resolveReportToken(r, 123),        null)
  assert.equal(await resolveReportToken(r, 'short'),    null) // <8 chars
})

test('resolveReportToken: returns null when token has no mapping', async () => {
  const r = mockRedis({ tokenToMonitor: {} })
  assert.equal(await resolveReportToken(r, 'a'.repeat(48)), null)
})

test('resolveReportToken: returns null when monitor record gone', async () => {
  const r = mockRedis({ tokenToMonitor: { 'tok123abcdef': 'mon_x' } })
  // monitor record itself missing
  assert.equal(await resolveReportToken(r, 'tok123abcdef'), null)
})

test('resolveReportToken: returns parsed monitor on valid token', async () => {
  const monitor = { id: 'mon_x', name: 'Acme', owner: 'a@b.co' }
  const r = mockRedis({
    tokenToMonitor: { 'tok123abcdef': 'mon_x' },
    monitors: { mon_x: monitor },
  })
  const got = await resolveReportToken(r, 'tok123abcdef')
  assert.deepEqual(got, monitor)
})

test('resolveReportToken: handles redis throw gracefully', async () => {
  const broken = { get: async () => { throw new Error('redis down') } }
  assert.equal(await resolveReportToken(broken, 'tok123abcdef'), null)
})

// ── gatherReportData ───────────────────────────────────────────────────────

test('gatherReportData: empty state → zeroed stats with 4 trend buckets', async () => {
  const r = mockRedis()
  const stats = await gatherReportData({ id: 'mon_x' }, r, 30)
  assert.equal(stats.total, 0)
  assert.equal(stats.highIntent, 0)
  assert.equal(stats.platformsActive, 0)
  assert.equal(stats.topMatches.length, 0)
  assert.equal(stats.authors.length, 0)
  assert.equal(stats.weeklyTrend.length, 4)
  for (const t of stats.weeklyTrend) assert.equal(t.count, 0)
})

test('gatherReportData: counts by sentiment, intent, platform within window', async () => {
  const now = Date.now()
  const inWindow = days => new Date(now - days * 24 * 3600e3).toISOString()
  const matches = {
    'mon_x:m1': { id: 'm1', title: 'A', url: 'u', source: 'reddit',     sentiment: 'positive',   intent: 'asking_for_tool', createdAt: inWindow(2) },
    'mon_x:m2': { id: 'm2', title: 'B', url: 'u', source: 'hackernews', sentiment: 'frustrated', intent: 'complaining',     createdAt: inWindow(5) },
    'mon_x:m3': { id: 'm3', title: 'C', url: 'u', source: 'reddit',     sentiment: 'neutral',    intent: 'researching',     createdAt: inWindow(40) }, // outside 30d
  }
  const r = mockRedis({ matchLists: { mon_x: ['m1', 'm2', 'm3'] }, matches })
  const stats = await gatherReportData({ id: 'mon_x' }, r, 30)
  assert.equal(stats.total, 2)
  assert.equal(stats.bySentiment.positive,    1)
  assert.equal(stats.bySentiment.frustrated,  1)
  assert.equal(stats.byIntent.asking_for_tool,1)
  assert.equal(stats.byIntent.complaining,    1)
  assert.equal(stats.byPlatform.reddit,     1)
  assert.equal(stats.byPlatform.hackernews, 1)
  assert.equal(stats.platformsActive, 2)
  assert.equal(stats.highIntent, 1)
})

test('gatherReportData: postedThisMonth counts only postedAt within window', async () => {
  const now = Date.now()
  const recent = new Date(now - 5 * 24 * 3600e3).toISOString()
  const old = new Date(now - 60 * 24 * 3600e3).toISOString()
  const matches = {
    'mon_x:a': { id: 'a', source: 'reddit', intent: 'buying',          createdAt: recent, postedAt: recent }, // counts
    'mon_x:b': { id: 'b', source: 'reddit', intent: 'buying',          createdAt: recent, postedAt: old },    // skipped
    'mon_x:c': { id: 'c', source: 'reddit', intent: 'buying',          createdAt: recent },                   // not posted
  }
  const r = mockRedis({ matchLists: { mon_x: ['a', 'b', 'c'] }, matches })
  const stats = await gatherReportData({ id: 'mon_x' }, r, 30)
  assert.equal(stats.total, 3)
  assert.equal(stats.postedThisMonth, 1)
})

test('gatherReportData: topMatches surfaces highest-priority intents first', async () => {
  const recent = new Date(Date.now() - 5 * 24 * 3600e3).toISOString()
  const matches = {
    'mon_x:m1': { id: 'm1', source: 'reddit', intent: 'venting',          createdAt: recent, title: 'venting' },
    'mon_x:m2': { id: 'm2', source: 'reddit', intent: 'asking_for_tool',  createdAt: recent, title: 'tool' },
    'mon_x:m3': { id: 'm3', source: 'reddit', intent: 'buying',           createdAt: recent, title: 'buying' },
    'mon_x:m4': { id: 'm4', source: 'reddit', intent: 'researching',      createdAt: recent, title: 'researching' },
  }
  const r = mockRedis({ matchLists: { mon_x: ['m1', 'm2', 'm3', 'm4'] }, matches })
  const stats = await gatherReportData({ id: 'mon_x' }, r, 30)
  assert.equal(stats.topMatches.length, 4)
  assert.equal(stats.topMatches[0].id, 'm2') // asking_for_tool
  assert.equal(stats.topMatches[1].id, 'm3') // buying
})

test('gatherReportData: weeklyTrend buckets matches into 4 weeks correctly', async () => {
  const now = Date.now()
  const make = (id, ageDays) => ({ id, source: 'reddit', intent: 'researching', createdAt: new Date(now - ageDays * 24 * 3600e3).toISOString() })
  const matches = {
    'mon_x:m1': make('m1', 1),  // this week
    'mon_x:m2': make('m2', 6),  // this week
    'mon_x:m3': make('m3', 10), // 2 wks ago
    'mon_x:m4': make('m4', 17), // 3 wks ago
    'mon_x:m5': make('m5', 25), // 4 wks ago
  }
  const r = mockRedis({ matchLists: { mon_x: ['m1', 'm2', 'm3', 'm4', 'm5'] }, matches })
  const stats = await gatherReportData({ id: 'mon_x' }, r, 30)
  assert.equal(stats.weeklyTrend[0].count, 1) // 4 wks ago (m5)
  assert.equal(stats.weeklyTrend[1].count, 1) // 3 wks ago (m4)
  assert.equal(stats.weeklyTrend[2].count, 1) // 2 wks ago (m3)
  assert.equal(stats.weeklyTrend[3].count, 2) // this week (m1, m2)
})

test('gatherReportData: author highlights pulled from author:profile hashes', async () => {
  const recent = new Date(Date.now() - 5 * 24 * 3600e3).toISOString()
  const matches = {
    'mon_x:m1': { id: 'm1', source: 'reddit', intent: 'researching', createdAt: recent },
  }
  const r = mockRedis({
    matchLists: { mon_x: ['m1'] },
    matches,
    authorLists: { mon_x: ['reddit:alex', 'twitter:rae', 'github:dev'] },
    authorProfiles: {
      'author:profile:mon_x:reddit:alex':  { author: 'alex', platform: 'reddit',  postCount: '12', firstSeen: '2026-01-01', lastSeen: '2026-04-29' },
      'author:profile:mon_x:twitter:rae':  { author: 'rae',  platform: 'twitter', postCount: '4',  firstSeen: '2026-02-01', lastSeen: '2026-04-29' },
      'author:profile:mon_x:github:dev':   { author: 'dev',  platform: 'github',  postCount: '1',  firstSeen: '2026-04-29', lastSeen: '2026-04-29' },
    },
  })
  const stats = await gatherReportData({ id: 'mon_x' }, r, 30)
  assert.equal(stats.authors.length, 3)
  // Sorted by postCount desc
  assert.equal(stats.authors[0].username, 'alex')
  assert.equal(stats.authors[0].postCount, 12)
  assert.equal(stats.authors[0].consistency, 'consistent')
  assert.equal(stats.authors[1].username, 'rae')
  assert.equal(stats.authors[1].consistency, 'occasional')
  assert.equal(stats.authors[2].username, 'dev')
  assert.equal(stats.authors[2].consistency, 'one-off')
})

// ── classifyConsistency ────────────────────────────────────────────────────

test('classifyConsistency: thresholds — 5+/2-4/<2', () => {
  const { classifyConsistency } = _internals
  assert.equal(classifyConsistency(0, '', ''), 'one-off')
  assert.equal(classifyConsistency(1, '', ''), 'one-off')
  assert.equal(classifyConsistency(2, '', ''), 'occasional')
  assert.equal(classifyConsistency(4, '', ''), 'occasional')
  assert.equal(classifyConsistency(5, '', ''), 'consistent')
  assert.equal(classifyConsistency(50, '', ''), 'consistent')
})

// ── buildExecutiveSummary fallback (router unavailable) ────────────────────

test('buildExecutiveSummary: empty stats returns templated zero-match line', async () => {
  // No GROQ/DEEPSEEK/ANTHROPIC keys in test env → router will fail through
  // all providers and our function returns the templated fallback.
  // For empty stats we hit the early-return branch deterministically.
  const summary = await buildExecutiveSummary({
    monitor: { name: 'Acme' },
    stats: { total: 0, days: 30, byPlatform: {}, byIntent: {}, byIntent: {}, highIntent: 0, postedThisMonth: 0, topMatches: [] },
  })
  assert.match(summary, /Acme/)
  assert.match(summary, /no matches/i)
})

// ── renderReportHtml ───────────────────────────────────────────────────────

const sampleStats = {
  monitorId: 'mon_x', days: 30,
  total: 12,
  bySentiment: { positive: 4, negative: 1, neutral: 5, frustrated: 2, questioning: 0 },
  byIntent: { asking_for_tool: 3, buying: 2, complaining: 1, researching: 5, venting: 1, recommending: 0 },
  byPlatform: { reddit: 8, hackernews: 4 },
  highIntent: 5,
  postedThisMonth: 2,
  platformsActive: 2,
  topMatches: [
    { id: 'm1', title: 'Top match title', url: 'https://r/x', source: 'reddit', subreddit: 'SaaS', intent: 'asking_for_tool', sentiment: 'questioning' },
  ],
  authors: [
    { username: 'alex', platform: 'reddit', postCount: 7, consistency: 'consistent' },
  ],
  weeklyTrend: [
    { weekLabel: '4 wks ago', count: 1 },
    { weekLabel: '3 wks ago', count: 3 },
    { weekLabel: '2 wks ago', count: 4 },
    { weekLabel: 'this week', count: 4 },
  ],
}

test('renderReportHtml: substitutes monitor name, range, summary into template', () => {
  const html = renderReportHtml({
    monitor: { name: 'Acme', unsubscribeToken: 'unsub-tok' },
    stats: sampleStats,
    summary: 'A 3-sentence summary about Acme.',
    appUrl: 'https://ebenova.org',
    now: new Date('2026-04-29T00:00:00Z'),
  })
  // Header
  assert.match(html, /<title>Acme — 30-day report<\/title>/)
  assert.match(html, /<h1>Acme<\/h1>/)
  assert.match(html, /A 3-sentence summary about Acme/)
  assert.match(html, /\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}/)
  // KPI tiles
  assert.match(html, />Total mentions</)
  assert.match(html, />12</)            // total
  assert.match(html, />High-intent</)
  assert.match(html, />5</)             // highIntent
  // Bars
  assert.match(html, /Sentiment breakdown/)
  assert.match(html, /Intent breakdown/)
  assert.match(html, /Wants a Tool/)
  // Top match
  assert.match(html, /Top match title/)
  // Author
  assert.match(html, />alex</)
  assert.match(html, /consistent/)
  // Trend
  assert.match(html, /this week/)
  // Footer (Powered by Ebenova)
  assert.match(html, /Powered by/)
  assert.match(html, /ebenova\.org/)
  // Unsub link uses token
  assert.match(html, /unsub-tok/)
})

test('renderReportHtml: HTML-escapes monitor name and match content', () => {
  const evil = { name: '<script>alert(1)</script>' }
  const html = renderReportHtml({
    monitor: evil,
    stats: { ...sampleStats, topMatches: [{ id: 'm', title: '<b>nope</b>', url: 'u', source: 'reddit' }] },
    summary: '<img onerror=alert(2)>',
    appUrl: 'https://ebenova.org',
    now: new Date('2026-04-29T00:00:00Z'),
  })
  assert.equal(html.includes('<script>alert(1)</script>'), false)
  assert.equal(html.includes('<b>nope</b>'), false)
  assert.equal(html.includes('<img onerror=alert(2)>'), false)
  assert.match(html, /&lt;script&gt;/)
})

test('renderReportHtml: empty-state fallbacks render when stats are sparse', () => {
  const empty = {
    monitorId: 'mon_x', days: 30, total: 0,
    bySentiment: { positive: 0, negative: 0, neutral: 0, frustrated: 0, questioning: 0 },
    byIntent: { asking_for_tool: 0, buying: 0, complaining: 0, researching: 0, venting: 0, recommending: 0 },
    byPlatform: {}, highIntent: 0, postedThisMonth: 0, platformsActive: 0,
    topMatches: [], authors: [],
    weeklyTrend: [
      { weekLabel: '4 wks ago', count: 0 }, { weekLabel: '3 wks ago', count: 0 },
      { weekLabel: '2 wks ago', count: 0 }, { weekLabel: 'this week', count: 0 },
    ],
  }
  const html = renderReportHtml({
    monitor: { name: 'Acme' },
    stats: empty, summary: 'Nothing this month.',
    appUrl: 'https://ebenova.org', now: new Date('2026-04-29T00:00:00Z'),
  })
  assert.match(html, /No data in this window\./)         // bars empty state
  assert.match(html, /No matches in the last 30 days\./) // top matches empty
  assert.match(html, /Author tracking populates over time/) // authors empty
})
