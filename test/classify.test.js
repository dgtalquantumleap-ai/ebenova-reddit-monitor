// test/classify.test.js — Coverage for lib/classify.js + intent-aware
// behavior elsewhere in the system (sort priority, email subject, HIGH
// PRIORITY rule, intent-summary endpoint shape, draft backfill).
//
// All Groq calls are mocked. No real API calls made.

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  classifyMatch,
  intentPriority,
  isHighPriority,
  INTENT_PRIORITY,
  INTENT_PRIORITY_FALLBACK,
  _resetCache,
  _internals,
} from '../lib/classify.js'
import { createMockRedis } from './helpers/mock-redis.js'

// Helper: mock global.fetch with a static response
function mockGroqResponse({ ok = true, status = 200, content }) {
  const original = global.fetch
  global.fetch = async () => ({
    ok, status,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => String(content || ''),
  })
  return () => { global.fetch = original }
}

function clearGroqEnv() {
  delete process.env.GROQ_API_KEY
}
function setGroqEnv() {
  process.env.GROQ_API_KEY = 'test-key'
}

// ── classifyMatch — happy path ───────────────────────────────────────────────

test('1. classifyMatch returns valid sentiment + intent for a clear buying-intent post', async () => {
  _resetCache()
  setGroqEnv()
  const restore = mockGroqResponse({
    content: '{"sentiment":"questioning","intent":"asking_for_tool","confidence":"high"}',
  })
  try {
    const r = await classifyMatch({
      title: 'What CRM should I use for a 5-person team?',
      body: 'Need something with API access. Currently looking at HubSpot vs Pipedrive.',
      source: 'reddit',
    })
    assert.deepEqual(r, { sentiment: 'questioning', intent: 'asking_for_tool', confidence: 'high', relevanceScore: 0.5, demandScore: 3 })
  } finally { restore(); clearGroqEnv() }
})

test('2. classifyMatch returns valid sentiment + intent for a venting post', async () => {
  _resetCache()
  setGroqEnv()
  const restore = mockGroqResponse({
    content: '{"sentiment":"frustrated","intent":"venting","confidence":"high"}',
  })
  try {
    const r = await classifyMatch({
      title: 'Client is impossible',
      body: 'Just had to end a 6-month engagement. Burnt out.',
      source: 'reddit',
    })
    assert.equal(r.intent, 'venting')
    assert.equal(r.sentiment, 'frustrated')
  } finally { restore(); clearGroqEnv() }
})

// ── classifyMatch — failure modes (must return null, not throw) ─────────────

test('3. classifyMatch returns null when Groq API fails (mock 500)', async () => {
  _resetCache()
  setGroqEnv()
  const restore = mockGroqResponse({ ok: false, status: 500, content: 'server error' })
  try {
    const r = await classifyMatch({ title: 't', body: 'b', source: 'reddit' })
    assert.equal(r, null)
  } finally { restore(); clearGroqEnv() }
})

test('4. classifyMatch returns null when response is not valid JSON', async () => {
  _resetCache()
  setGroqEnv()
  const restore = mockGroqResponse({ content: 'I think the sentiment is positive but I cannot decide on intent.' })
  try {
    const r = await classifyMatch({ title: 't', body: 'b', source: 'reddit' })
    assert.equal(r, null)
  } finally { restore(); clearGroqEnv() }
})

test('5. classifyMatch returns null when response has unexpected field values', async () => {
  _resetCache()
  setGroqEnv()
  const restore = mockGroqResponse({
    content: '{"sentiment":"angry","intent":"shopping","confidence":"high"}',  // both invalid
  })
  try {
    const r = await classifyMatch({ title: 't', body: 'b', source: 'reddit' })
    assert.equal(r, null)
  } finally { restore(); clearGroqEnv() }
})

test('5b. classifyMatch returns null when response is missing fields', async () => {
  _resetCache()
  setGroqEnv()
  const restore = mockGroqResponse({ content: '{"sentiment":"positive"}' })
  try {
    const r = await classifyMatch({ title: 't', body: 'b', source: 'reddit' })
    assert.equal(r, null)
  } finally { restore(); clearGroqEnv() }
})

test('5c. classifyMatch never throws on fetch network error', async () => {
  _resetCache()
  setGroqEnv()
  const original = global.fetch
  global.fetch = async () => { throw new Error('network down') }
  try {
    const r = await classifyMatch({ title: 't', body: 'b', source: 'reddit' })
    assert.equal(r, null)
  } finally { global.fetch = original; clearGroqEnv() }
})

test('5d. classifyMatch returns null when GROQ_API_KEY missing', async () => {
  _resetCache()
  clearGroqEnv()
  const r = await classifyMatch({ title: 't', body: 'b', source: 'reddit' })
  assert.equal(r, null)
})

test('5e. classifyMatch handles confidence omission with medium fallback', async () => {
  _resetCache()
  setGroqEnv()
  // Confidence is missing — spec is lenient: default to 'medium' rather than reject
  const restore = mockGroqResponse({
    content: '{"sentiment":"positive","intent":"recommending"}',
  })
  try {
    const r = await classifyMatch({ title: 't', body: 'b', source: 'reddit' })
    assert.deepEqual(r, { sentiment: 'positive', intent: 'recommending', confidence: 'medium', relevanceScore: 0.5, demandScore: 3 })
  } finally { restore(); clearGroqEnv() }
})

// ── Cache ────────────────────────────────────────────────────────────────────

test('6. classifyMatch uses cache — second call with same content does NOT make a second API call', async () => {
  _resetCache()
  setGroqEnv()
  let calls = 0
  const original = global.fetch
  global.fetch = async () => {
    calls++
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"sentiment":"positive","intent":"recommending","confidence":"high"}' } }] }),
    }
  }
  try {
    const a = await classifyMatch({ title: 'Same title', body: 'Same body', source: 'reddit' })
    const b = await classifyMatch({ title: 'Same title', body: 'Same body', source: 'reddit' })
    assert.deepEqual(a, b)
    assert.equal(calls, 1, 'second call must not re-hit Groq')
  } finally { global.fetch = original; clearGroqEnv() }
})

test('6b. classifyMatch cache distinguishes different post bodies', async () => {
  _resetCache()
  setGroqEnv()
  let calls = 0
  const original = global.fetch
  global.fetch = async () => {
    calls++
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"sentiment":"neutral","intent":"researching","confidence":"medium"}' } }] }),
    }
  }
  try {
    await classifyMatch({ title: 'Same title', body: 'Body A', source: 'reddit' })
    await classifyMatch({ title: 'Same title', body: 'Body B differs entirely from A', source: 'reddit' })
    assert.equal(calls, 2)
  } finally { global.fetch = original; clearGroqEnv() }
})

// ── Cost cap ─────────────────────────────────────────────────────────────────

test('7. classifyMatch skips when Groq cost cap is hit', async () => {
  _resetCache()
  setGroqEnv()
  let fetchCalled = false
  const original = global.fetch
  global.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({}) } }
  try {
    const capCheck = async () => ({ allowed: false, used: 100, max: 100 })
    const r = await classifyMatch({ title: 't', body: 'b', source: 'reddit', costCapCheck: capCheck })
    assert.equal(r, null)
    assert.equal(fetchCalled, false, 'Groq must not be called when cap is hit')
  } finally { global.fetch = original; clearGroqEnv() }
})

test('7b. classifyMatch proceeds normally when cap allows', async () => {
  _resetCache()
  setGroqEnv()
  const restore = mockGroqResponse({
    content: '{"sentiment":"positive","intent":"buying","confidence":"high"}',
  })
  try {
    const capCheck = async () => ({ allowed: true, used: 50, max: 100 })
    const r = await classifyMatch({ title: 't', body: 'b', source: 'reddit', costCapCheck: capCheck })
    assert.equal(r.intent, 'buying')
  } finally { restore(); clearGroqEnv() }
})

// ── Priority sort utilities ──────────────────────────────────────────────────

test('8. Priority sort: asking_for_tool < buying < researching < venting', () => {
  assert.ok(intentPriority('asking_for_tool') < intentPriority('buying'))
  assert.ok(intentPriority('buying') < intentPriority('researching'))
  assert.ok(intentPriority('researching') < intentPriority('venting'))
})

test('8b. Priority sort: full ordering matches spec', () => {
  const matches = [
    { intent: 'venting' },
    { intent: 'asking_for_tool' },
    { intent: 'recommending' },
    { intent: 'buying' },
    { intent: null },
    { intent: 'complaining' },
    { intent: 'researching' },
  ]
  matches.sort((a, b) => intentPriority(a.intent) - intentPriority(b.intent))
  assert.deepEqual(matches.map(m => m.intent), [
    'asking_for_tool', 'buying', 'researching', 'complaining', 'recommending', 'venting', null
  ])
})

test('9. Priority sort uses source rank as tiebreaker within same intent tier', () => {
  // Mirror the sort from monitor-v2.js / api-server.js to verify the tiebreaker
  const SOURCE_RANK = { reddit: 0, hackernews: 1, quora: 2, medium: 3, substack: 4, upwork: 5, fiverr: 6 }
  const matches = [
    { intent: 'buying', source: 'medium', createdAt: '2026-04-28T00:00:00Z' },
    { intent: 'buying', source: 'reddit', createdAt: '2026-04-27T00:00:00Z' },  // older but Reddit
    { intent: 'asking_for_tool', source: 'fiverr', createdAt: '2026-04-29T00:00:00Z' },  // highest intent
  ]
  matches.sort((a, b) => {
    const ia = intentPriority(a.intent)
    const ib = intentPriority(b.intent)
    if (ia !== ib) return ia - ib
    const ra = SOURCE_RANK[a.source] ?? 99
    const rb = SOURCE_RANK[b.source] ?? 99
    if (ra !== rb) return ra - rb
    return new Date(b.createdAt) - new Date(a.createdAt)
  })
  assert.equal(matches[0].intent, 'asking_for_tool')
  assert.equal(matches[1].source, 'reddit')   // Reddit beats Medium within 'buying'
  assert.equal(matches[2].source, 'medium')
})

// ── Email subject line ──────────────────────────────────────────────────────

// Mirror the subject-line slice from sendMonitorAlert
function buildSubject(matches, keywords) {
  const highValueCount = matches.filter(m => m.intent === 'asking_for_tool' || m.intent === 'buying').length
  const prefix = highValueCount > 0 ? '🎯 ' : ''
  const intentNote = highValueCount > 0 ? ` (${highValueCount} buying intent)` : ''
  return `${prefix}Insights: ${matches.length} new mention${matches.length !== 1 ? 's' : ''}${intentNote} — ${keywords.slice(0, 3).join(', ')}`
}

test('10. Email subject line includes 🎯 when buying/asking_for_tool present', () => {
  const matches = [
    { intent: 'venting' },
    { intent: 'asking_for_tool' },
    { intent: 'buying' },
  ]
  const subj = buildSubject(matches, ['scope creep'])
  assert.ok(subj.startsWith('🎯 '))
  assert.ok(subj.includes('(2 buying intent)'))
})

test('11. Email subject line is plain when only venting/complaining present', () => {
  const matches = [
    { intent: 'venting' },
    { intent: 'complaining' },
    { intent: 'venting' },
  ]
  const subj = buildSubject(matches, ['scope creep'])
  assert.ok(!subj.startsWith('🎯'))
  assert.ok(!subj.includes('buying intent'))
})

// ── HIGH PRIORITY badge ──────────────────────────────────────────────────────

test('12. HIGH PRIORITY badge appears for asking_for_tool with non-venting sentiment', () => {
  assert.equal(isHighPriority({ intent: 'asking_for_tool', sentiment: 'questioning' }), true)
  assert.equal(isHighPriority({ intent: 'buying', sentiment: 'positive' }), true)
})

test('13. HIGH PRIORITY badge does NOT appear for venting even with high source rank', () => {
  // The spec says non-venting sentiment is required even for buying/asking_for_tool
  assert.equal(isHighPriority({ intent: 'asking_for_tool', sentiment: 'venting' }), false)
  assert.equal(isHighPriority({ intent: 'venting', sentiment: 'frustrated' }), false)
  assert.equal(isHighPriority({ intent: 'complaining', sentiment: 'negative' }), false)
})

test('13c. HIGH PRIORITY: buying + venting → no flag (sentiment guard)', () => {
  // Explicit coverage of the spec's sentiment guard for the buying intent.
  // A user can have buying intent in the ABSTRACT ("I need a CRM") while
  // venting in tone ("I HATE every CRM I've tried"). Don't flag those as
  // high priority — they're not engagement-ready.
  assert.equal(isHighPriority({ intent: 'buying', sentiment: 'venting' }), false)
})

test('13b. HIGH PRIORITY badge handles missing intent/sentiment gracefully', () => {
  assert.equal(isHighPriority({}), false)
  assert.equal(isHighPriority(null), false)
  assert.equal(isHighPriority({ intent: 'asking_for_tool' }), true)  // sentiment missing → treat as not-venting
})

// ── GET /v1/matches/intent-summary ───────────────────────────────────────────

// Mirror the intent-summary slice from api-server.js so we can test it
// against the mock redis without spinning up Express.
async function buildIntentSummary(redis, monitor_id, owner) {
  const monRaw = await redis.get(`insights:monitor:${monitor_id}`)
  if (!monRaw) return { status: 404 }
  const m = typeof monRaw === 'string' ? JSON.parse(monRaw) : monRaw
  if (m.owner !== owner) return { status: 403 }
  const ids = await redis.lrange(`insights:matches:${monitor_id}`, 0, 499) || []
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  const by_intent = {
    asking_for_tool: 0, buying: 0, complaining: 0, researching: 0,
    venting: 0, recommending: 0, unclassified: 0,
  }
  const by_sentiment = { positive: 0, negative: 0, neutral: 0, frustrated: 0, questioning: 0 }
  let total = 0
  for (const matchId of ids) {
    const mr = await redis.get(`insights:match:${monitor_id}:${matchId}`)
    if (!mr) continue
    const match = typeof mr === 'string' ? JSON.parse(mr) : mr
    const ts = new Date(match.createdAt || match.storedAt || 0).getTime()
    if (!Number.isFinite(ts) || ts < cutoff) continue
    total++
    if (match.intent && Object.prototype.hasOwnProperty.call(by_intent, match.intent)) {
      by_intent[match.intent]++
    } else {
      by_intent.unclassified++
    }
    if (match.sentiment && Object.prototype.hasOwnProperty.call(by_sentiment, match.sentiment)) {
      by_sentiment[match.sentiment]++
    }
  }
  return {
    status: 200,
    body: {
      summary: {
        total, by_intent, by_sentiment,
        high_value_count: by_intent.asking_for_tool + by_intent.buying,
      },
    },
  }
}

test('14. GET /v1/matches/intent-summary returns correct counts from Redis', async () => {
  const redis = createMockRedis()
  await redis.set('insights:monitor:mon_a', JSON.stringify({ id: 'mon_a', owner: 'o@x.com' }))
  const fresh = new Date().toISOString()
  const matches = [
    { id: 'p1', intent: 'asking_for_tool', sentiment: 'questioning', createdAt: fresh },
    { id: 'p2', intent: 'asking_for_tool', sentiment: 'questioning', createdAt: fresh },
    { id: 'p3', intent: 'buying',          sentiment: 'positive',    createdAt: fresh },
    { id: 'p4', intent: 'venting',         sentiment: 'frustrated',  createdAt: fresh },
    { id: 'p5', intent: 'complaining',     sentiment: 'negative',    createdAt: fresh },
    { id: 'p6',                                                       createdAt: fresh },  // unclassified
  ]
  for (const m of matches) {
    await redis.set(`insights:match:mon_a:${m.id}`, JSON.stringify(m))
    await redis.lpush('insights:matches:mon_a', m.id)
  }
  const r = await buildIntentSummary(redis, 'mon_a', 'o@x.com')
  assert.equal(r.status, 200)
  assert.equal(r.body.summary.total, 6)
  assert.equal(r.body.summary.by_intent.asking_for_tool, 2)
  assert.equal(r.body.summary.by_intent.buying, 1)
  assert.equal(r.body.summary.by_intent.venting, 1)
  assert.equal(r.body.summary.by_intent.complaining, 1)
  assert.equal(r.body.summary.by_intent.unclassified, 1)
  assert.equal(r.body.summary.high_value_count, 3)  // asking_for_tool + buying
  assert.equal(r.body.summary.by_sentiment.questioning, 2)
})

test('14b. Intent summary excludes matches older than 7 days', async () => {
  const redis = createMockRedis()
  await redis.set('insights:monitor:mon_b', JSON.stringify({ id: 'mon_b', owner: 'o@x.com' }))
  const fresh = new Date().toISOString()
  const stale = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
  const matches = [
    { id: 'fresh1', intent: 'buying', createdAt: fresh },
    { id: 'old1',   intent: 'buying', createdAt: stale },
  ]
  for (const m of matches) {
    await redis.set(`insights:match:mon_b:${m.id}`, JSON.stringify(m))
    await redis.lpush('insights:matches:mon_b', m.id)
  }
  const r = await buildIntentSummary(redis, 'mon_b', 'o@x.com')
  assert.equal(r.body.summary.total, 1)
  assert.equal(r.body.summary.by_intent.buying, 1)
})

test('15. GET /v1/matches/intent-summary returns 404 for unknown monitor', async () => {
  const redis = createMockRedis()
  const r = await buildIntentSummary(redis, 'mon_does_not_exist', 'o@x.com')
  assert.equal(r.status, 404)
})

test('15b. Intent summary returns 403 when caller does not own the monitor', async () => {
  const redis = createMockRedis()
  await redis.set('insights:monitor:mon_x', JSON.stringify({ id: 'mon_x', owner: 'real@x.com' }))
  const r = await buildIntentSummary(redis, 'mon_x', 'attacker@x.com')
  assert.equal(r.status, 403)
})

// ── POST /v1/matches/draft backfill ──────────────────────────────────────────

test('16. POST /v1/matches/draft backfills classification when intent is null', async () => {
  // Simulates the slice of the draft endpoint that backfills classification
  // for legacy matches. Mocks the Groq classify call.
  _resetCache()
  setGroqEnv()
  const original = global.fetch
  let classifyCalls = 0
  global.fetch = async (url) => {
    classifyCalls++
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"sentiment":"questioning","intent":"asking_for_tool","confidence":"high"}' } }] }),
    }
  }
  try {
    const legacyMatch = { title: 'What CRM should I use?', body: 'help', source: 'reddit' }
    // Simulate the backfill check from the route
    let backfill = {}
    if (!legacyMatch.intent || !legacyMatch.sentiment) {
      const r = await classifyMatch({ title: legacyMatch.title, body: legacyMatch.body, source: legacyMatch.source })
      if (r) backfill = { sentiment: r.sentiment, intent: r.intent, intentConfidence: r.confidence }
    }
    assert.equal(backfill.intent, 'asking_for_tool')
    assert.equal(backfill.sentiment, 'questioning')
    assert.equal(classifyCalls, 1)
  } finally { global.fetch = original; clearGroqEnv() }
})

test('16b. POST /v1/matches/draft does NOT re-classify when fields already present', async () => {
  _resetCache()
  setGroqEnv()
  let classifyCalls = 0
  const original = global.fetch
  global.fetch = async () => {
    classifyCalls++
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }
  }
  try {
    const populatedMatch = {
      title: 'X', body: 'y', source: 'reddit',
      intent: 'buying', sentiment: 'positive', intentConfidence: 'high',
    }
    let backfill = {}
    if (!populatedMatch.intent || !populatedMatch.sentiment) {
      const r = await classifyMatch({ title: populatedMatch.title, body: populatedMatch.body, source: populatedMatch.source })
      if (r) backfill = { sentiment: r.sentiment, intent: r.intent }
    }
    assert.deepEqual(backfill, {})
    assert.equal(classifyCalls, 0, 'classify must not be called when fields exist')
  } finally { global.fetch = original; clearGroqEnv() }
})

// ── INTENT_PRIORITY exports sanity ───────────────────────────────────────────

test('INTENT_PRIORITY constant matches spec ordering', () => {
  assert.equal(INTENT_PRIORITY.asking_for_tool, 0)
  assert.equal(INTENT_PRIORITY.buying, 1)
  assert.equal(INTENT_PRIORITY.researching, 2)
  assert.equal(INTENT_PRIORITY.complaining, 3)
  assert.equal(INTENT_PRIORITY.recommending, 4)
  assert.equal(INTENT_PRIORITY.venting, 5)
  assert.equal(INTENT_PRIORITY_FALLBACK, 6)
})

test('Internal validateClassification rejects invalid sentiment', () => {
  const v = _internals.validateClassification({ sentiment: 'angry', intent: 'buying', confidence: 'high' })
  assert.equal(v, null)
})

test('Internal validateClassification rejects invalid intent', () => {
  const v = _internals.validateClassification({ sentiment: 'positive', intent: 'shopping', confidence: 'high' })
  assert.equal(v, null)
})
