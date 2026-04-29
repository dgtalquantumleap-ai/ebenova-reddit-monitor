import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  gatherDigestData, renderDigestEmail, digestSubject,
  runMonitorDigest, runAllDigests,
} from '../lib/weekly-digest.js'

// ── Mock redis: just enough surface for digest reads ───────────────────────

function mockRedis(state = {}) {
  // state shape: {
  //   activeMonitorIds: string[],
  //   monitors: { [id]: monitorRecord },
  //   matchLists: { [monitorId]: matchId[] },
  //   matches: { [`${monitorId}:${matchId}`]: matchRecord },
  // }
  return {
    async smembers(key) {
      if (key === 'insights:active_monitors') return state.activeMonitorIds || []
      return []
    },
    async lrange(key, start, end) {
      const m = key.match(/^insights:matches:(.+)$/)
      if (!m) return []
      const list = state.matchLists?.[m[1]] || []
      return list.slice(start, end + 1)
    },
    async get(key) {
      const monMatch = key.match(/^insights:monitor:(.+)$/)
      if (monMatch) {
        const r = state.monitors?.[monMatch[1]]
        return r ? JSON.stringify(r) : null
      }
      const matchMatch = key.match(/^insights:match:(.+):(.+)$/)
      if (matchMatch) {
        const r = state.matches?.[`${matchMatch[1]}:${matchMatch[2]}`]
        return r ? JSON.stringify(r) : null
      }
      return null
    },
  }
}

// ── gatherDigestData ───────────────────────────────────────────────────────

test('gatherDigestData: empty state returns zeroed stats', async () => {
  const redis = mockRedis()
  const r = await gatherDigestData({ id: 'mon_1' }, redis)
  assert.equal(r.total, 0)
  assert.equal(r.postedCount, 0)
  assert.equal(r.topMatches.length, 0)
  assert.equal(r.bestLead, null)
  assert.deepEqual(Object.keys(r.byPlatform), [])
})

test('gatherDigestData: counts by intent + platform, includes only the last 7 days', async () => {
  const now = Date.now()
  const monitor = { id: 'mon_1' }
  const recent = (offsetDays, extras = {}) => ({
    id: `m${offsetDays}`,
    title: `Match ${offsetDays} days ago`, url: 'u', source: extras.source || 'reddit',
    intent: extras.intent ?? 'researching', sentiment: 'neutral',
    createdAt: new Date(now - offsetDays * 24 * 3600e3).toISOString(),
    ...extras,
  })
  const redis = mockRedis({
    matchLists: { mon_1: ['m1', 'm3', 'm10'] },
    matches: {
      'mon_1:m1':  recent(1,  { intent: 'asking_for_tool', source: 'reddit' }),
      'mon_1:m3':  recent(3,  { intent: 'researching',     source: 'hackernews' }),
      'mon_1:m10': recent(10, { intent: 'venting',         source: 'reddit' }),  // outside 7-day window
    },
  })
  const r = await gatherDigestData(monitor, redis)
  assert.equal(r.total, 2) // m1 + m3, not m10
  assert.equal(r.byIntent.asking_for_tool, 1)
  assert.equal(r.byIntent.researching,    1)
  assert.equal(r.byIntent.venting,        0)
  assert.equal(r.byPlatform.reddit,     1)
  assert.equal(r.byPlatform.hackernews, 1)
})

test('gatherDigestData: counts only postedAt timestamps within the window', async () => {
  const now = Date.now()
  const inWindow = new Date(now - 2 * 24 * 3600e3).toISOString()
  const outside  = new Date(now - 30 * 24 * 3600e3).toISOString()
  const monitor = { id: 'mon_1' }
  const redis = mockRedis({
    matchLists: { mon_1: ['a', 'b', 'c'] },
    matches: {
      'mon_1:a': { id: 'a', title: 'a', url: 'ua', source: 'reddit', intent: 'buying', sentiment: 'positive', createdAt: inWindow, postedAt: inWindow },
      'mon_1:b': { id: 'b', title: 'b', url: 'ub', source: 'reddit', intent: 'buying', sentiment: 'positive', createdAt: inWindow, postedAt: outside },
      'mon_1:c': { id: 'c', title: 'c', url: 'uc', source: 'reddit', intent: 'buying', sentiment: 'positive', createdAt: inWindow },
    },
  })
  const r = await gatherDigestData(monitor, redis)
  assert.equal(r.total, 3)
  assert.equal(r.postedCount, 1) // only a
})

test('gatherDigestData: topMatches surfaces high-priority first, then by intent rank', async () => {
  const inWindow = new Date(Date.now() - 1 * 24 * 3600e3).toISOString()
  const monitor = { id: 'mon_1' }
  const make = (id, intent, sentiment) => ({
    id, title: `T-${id}`, url: 'u', source: 'reddit',
    intent, sentiment, approved: true, createdAt: inWindow,
  })
  const redis = mockRedis({
    matchLists: { mon_1: ['m1', 'm2', 'm3', 'm4'] },
    matches: {
      'mon_1:m1': make('m1', 'venting',         'frustrated'),  // not high priority
      'mon_1:m2': make('m2', 'asking_for_tool', 'questioning'), // high priority
      'mon_1:m3': make('m3', 'recommending',    'positive'),    // not high
      'mon_1:m4': make('m4', 'buying',          'positive'),    // high priority
    },
  })
  const r = await gatherDigestData(monitor, redis)
  assert.equal(r.topMatches.length, 3)
  // High-priority matches first; among them, asking_for_tool ranks above buying
  assert.equal(r.topMatches[0].id, 'm2')
  assert.equal(r.topMatches[1].id, 'm4')
  assert.equal(r.bestLead.id, 'm2')
})

test('gatherDigestData: skips malformed match records gracefully', async () => {
  const inWindow = new Date(Date.now() - 1 * 24 * 3600e3).toISOString()
  const redis = mockRedis({
    matchLists: { mon_1: ['ok', 'gone', 'bad'] },
    matches: {
      'mon_1:ok':  { id: 'ok',  title: 'real', url: 'u', source: 'reddit', intent: 'buying', createdAt: inWindow },
      // 'mon_1:gone' deliberately missing — get() returns null
      'mon_1:bad': { id: 'bad', title: 'no createdAt', url: 'u', source: 'reddit' },
    },
  })
  const r = await gatherDigestData({ id: 'mon_1' }, redis)
  // 'gone' is skipped (null record), 'bad' is skipped (no createdAt)
  assert.equal(r.total, 1)
})

// ── digestSubject ──────────────────────────────────────────────────────────

test('digestSubject: includes monitor name and ISO date range', () => {
  const now = new Date('2026-04-29T08:00:00Z')
  const subj = digestSubject({ name: 'My Monitor' }, now)
  assert.match(subj, /Your week on My Monitor/)
  assert.match(subj, /\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}/)
})

test('digestSubject: handles missing monitor name', () => {
  const subj = digestSubject({}, new Date('2026-04-29T08:00:00Z'))
  assert.match(subj, /Your week on your monitor/)
})

// ── renderDigestEmail ──────────────────────────────────────────────────────

test('renderDigestEmail: includes total, posted count, intent + platform tables', () => {
  const html = renderDigestEmail({
    monitor: { name: 'Acme', unsubscribeToken: 'tok' },
    stats: {
      total: 7,
      byIntent: { asking_for_tool: 2, buying: 1, researching: 4, complaining: 0, venting: 0, recommending: 0, unclassified: 0 },
      byPlatform: { reddit: 3, hackernews: 4 },
      postedCount: 2,
      topMatches: [],
      bestLead: null,
    },
    summary: 'Pattern paragraph here.',
    bestLeadDraft: null,
    now: new Date('2026-04-29T08:00:00Z'),
  })
  assert.match(html, /Pattern paragraph here\./)
  assert.match(html, /Total matches/)
  assert.match(html, />7</)
  assert.match(html, /Replies posted/)
  assert.match(html, /By intent/)
  assert.match(html, /Wants a Tool/)
  assert.match(html, /By platform/)
  assert.match(html, /Reddit/)
  assert.match(html, /Hacker News/)
  // Best-lead section is omitted when bestLeadDraft is null
  assert.equal(/Best lead this week/.test(html), false)
})

test('renderDigestEmail: includes best-lead section only when both bestLead AND bestLeadDraft present', () => {
  const html = renderDigestEmail({
    monitor: { name: 'Acme' },
    stats: {
      total: 1,
      byIntent: { asking_for_tool: 1 },
      byPlatform: { reddit: 1 },
      postedCount: 0,
      topMatches: [],
      bestLead: { id: 'm1', title: 'best title', url: 'https://x/y', source: 'reddit', intent: 'asking_for_tool', sentiment: 'questioning' },
    },
    summary: 'sum',
    bestLeadDraft: 'Here is the redrafted reply.',
    now: new Date('2026-04-29T08:00:00Z'),
  })
  assert.match(html, /Best lead this week/)
  assert.match(html, /best title/)
  assert.match(html, /Here is the redrafted reply\./)
})

test('renderDigestEmail: HTML-escapes monitor and match content', () => {
  const html = renderDigestEmail({
    monitor: { name: '<script>alert(1)</script>' },
    stats: { total: 1, byIntent: {}, byPlatform: {}, postedCount: 0, topMatches: [{ id: 'a', title: '<b>danger</b>', url: 'u', source: 'reddit' }], bestLead: null },
    summary: '<img onerror=alert(2)>',
    bestLeadDraft: null,
    now: new Date('2026-04-29T08:00:00Z'),
  })
  // The dangerous strings should be escaped
  assert.equal(html.includes('<script>alert(1)</script>'), false)
  assert.equal(html.includes('<b>danger</b>'), false)
  assert.equal(html.includes('<img onerror=alert(2)>'), false)
  assert.match(html, /&lt;script&gt;/)
})

// ── runMonitorDigest (orchestration with mocked Resend) ────────────────────

function mockResend(behavior = { ok: true }) {
  const sent = []
  return {
    sent,
    emails: {
      send: async (msg) => {
        sent.push(msg)
        if (behavior.ok) return { id: 'resend_id' }
        throw new Error(behavior.error || 'send failed')
      },
    },
  }
}

test('runMonitorDigest: skips when emailEnabled=false', async () => {
  const r = await runMonitorDigest({
    monitor: { id: 'm', emailEnabled: false, alertEmail: 'a@b.co' },
    redis: mockRedis(), resend: mockResend(), fromEmail: 'f@x.co',
  })
  assert.equal(r.sent, false)
  assert.equal(r.reason, 'email-disabled')
})

test('runMonitorDigest: skips when no alertEmail', async () => {
  const r = await runMonitorDigest({
    monitor: { id: 'm' }, redis: mockRedis(), resend: mockResend(), fromEmail: 'f@x.co',
  })
  assert.equal(r.sent, false)
})

test('runMonitorDigest: skips zero-match weeks (does not send empty email)', async () => {
  const monitor = { id: 'm', alertEmail: 'a@b.co', name: 'M' }
  const resend = mockResend()
  const r = await runMonitorDigest({ monitor, redis: mockRedis(), resend, fromEmail: 'f@x.co' })
  assert.equal(r.sent, false)
  assert.equal(r.reason, 'zero-matches')
  assert.equal(resend.sent.length, 0)
})

test('runMonitorDigest: send fails → returns sent:false with reason', async () => {
  // One match in window so we get past the zero-match early-return
  const inWindow = new Date(Date.now() - 1 * 24 * 3600e3).toISOString()
  const monitor = { id: 'm', alertEmail: 'a@b.co', name: 'M' }
  const redis = mockRedis({
    matchLists: { m: ['x'] },
    matches: { 'm:x': { id: 'x', title: 'T', url: 'u', source: 'reddit', intent: 'researching', createdAt: inWindow } },
  })
  const resend = mockResend({ ok: false, error: 'resend boom' })
  const r = await runMonitorDigest({ monitor, redis, resend, fromEmail: 'f@x.co' })
  assert.equal(r.sent, false)
  assert.equal(r.reason, 'send-failed')
  assert.match(r.error, /resend boom/)
})

// ── runAllDigests (loop + isolation) ───────────────────────────────────────

test('runAllDigests: returns ran/sent/skipped counts with no active monitors', async () => {
  const r = await runAllDigests({ redis: mockRedis(), resend: mockResend(), fromEmail: 'f@x.co' })
  assert.deepEqual(r, { ran: 0, sent: 0, skipped: 0 })
})

test('runAllDigests: skips inactive monitors', async () => {
  const redis = mockRedis({
    activeMonitorIds: ['m1', 'm2'],
    monitors: {
      m1: { id: 'm1', name: 'one', alertEmail: 'a@b', active: false },
      m2: { id: 'm2', name: 'two', alertEmail: 'a@b', active: true },
    },
    matchLists: { m1: [], m2: [] },
  })
  const r = await runAllDigests({ redis, resend: mockResend(), fromEmail: 'f@x.co' })
  assert.equal(r.ran, 2)
  // m1 inactive → skipped; m2 active but zero matches → also skipped
  assert.equal(r.sent, 0)
  assert.equal(r.skipped, 2)
})
