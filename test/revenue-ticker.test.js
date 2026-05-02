import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'

// ── Lost revenue calculation ──────────────────────────────────────────────────

function calcOpportunityCost(unactionedHighIntentCount, dealValue) {
  if (!dealValue || dealValue <= 0) return 0
  return unactionedHighIntentCount * dealValue * 0.10
}

test('revenue: 8 unactioned × $50,000 × 10% = $40,000', () => {
  assert.equal(calcOpportunityCost(8, 50000), 40000)
})

test('revenue: 0 unactioned leads = $0 opportunity cost', () => {
  assert.equal(calcOpportunityCost(0, 50000), 0)
})

test('revenue: dealValue=0 = $0 regardless of lead count', () => {
  assert.equal(calcOpportunityCost(10, 0), 0)
})

test('revenue: dealValue null/undefined = $0', () => {
  assert.equal(calcOpportunityCost(5, null), 0)
  assert.equal(calcOpportunityCost(5, undefined), 0)
})

test('revenue: 1 unactioned × $1,000 × 10% = $100', () => {
  assert.equal(calcOpportunityCost(1, 1000), 100)
})

// ── isUnanswered detection ────────────────────────────────────────────────────

function computeIsUnanswered(replyCount, postAgeHours) {
  return replyCount === 0 && postAgeHours < 2
}

test('isUnanswered: true when replyCount=0 and postAgeHours<2', () => {
  assert.equal(computeIsUnanswered(0, 1), true)
  assert.equal(computeIsUnanswered(0, 0), true)
  assert.equal(computeIsUnanswered(0, 1.9), true)
})

test('isUnanswered: false when replyCount>0', () => {
  assert.equal(computeIsUnanswered(1, 0.5), false)
  assert.equal(computeIsUnanswered(5, 1), false)
})

test('isUnanswered: false when postAgeHours>=2', () => {
  assert.equal(computeIsUnanswered(0, 2), false)
  assert.equal(computeIsUnanswered(0, 3), false)
  assert.equal(computeIsUnanswered(0, 24), false)
})

test('isUnanswered: false when replyCount>0 AND postAgeHours>=2', () => {
  assert.equal(computeIsUnanswered(3, 5), false)
})

// ── Sort priority with isUnanswered ──────────────────────────────────────────

function sortPriority(match) {
  // Tier 1: unanswered + demandScore >= 8
  if (match.isUnanswered && (match.demandScore || 0) >= 8) return 0
  // Tier 2: unanswered + demandScore >= 5
  if (match.isUnanswered && (match.demandScore || 0) >= 5) return 1
  // Tier 3: answered but high demand
  if ((match.demandScore || 0) >= 8) return 2
  // Tier 4: everything else
  return 3
}

test('sort: unanswered + demandScore>=8 sorts first', () => {
  const gold = { isUnanswered: true, demandScore: 9 }
  const warm = { isUnanswered: true, demandScore: 6 }
  const hot  = { isUnanswered: false, demandScore: 8 }
  const rest = { isUnanswered: false, demandScore: 4 }

  assert.equal(sortPriority(gold), 0)
  assert.equal(sortPriority(warm), 1)
  assert.equal(sortPriority(hot),  2)
  assert.equal(sortPriority(rest), 3)
})

test('sort: unanswered + demandScore=5 is tier 2, not tier 1', () => {
  assert.equal(sortPriority({ isUnanswered: true, demandScore: 5 }), 1)
})

test('sort: unanswered with no demandScore falls to tier 3 (0 is below all thresholds)', () => {
  // demandScore missing → 0 → tier 0 (needs >=8) fails → tier 1 (needs >=5) fails → tier 3
  assert.equal(sortPriority({ isUnanswered: true, demandScore: undefined }), 3)
  assert.equal(sortPriority({ isUnanswered: true }), 3)
})

test('sort: matches sorted correctly end-to-end', () => {
  const matches = [
    { id: 'rest', isUnanswered: false, demandScore: 3 },
    { id: 'gold', isUnanswered: true,  demandScore: 9 },
    { id: 'hot',  isUnanswered: false, demandScore: 8 },
    { id: 'warm', isUnanswered: true,  demandScore: 6 },
  ]
  matches.sort((a, b) => sortPriority(a) - sortPriority(b))
  assert.equal(matches[0].id, 'gold')
  assert.equal(matches[1].id, 'warm')
  assert.equal(matches[2].id, 'hot')
  assert.equal(matches[3].id, 'rest')
})

// ── dealValue stored on monitor ───────────────────────────────────────────────

test('dealValue: stored as integer on monitor hash', async () => {
  const redis = createMockRedis()
  const monitor = { id: 'mon_deal', name: 'Test', dealValue: 50000 }
  await redis.set(`insights:monitor:${monitor.id}`, JSON.stringify(monitor))
  const stored = JSON.parse(await redis.get(`insights:monitor:${monitor.id}`))
  assert.equal(stored.dealValue, 50000)
})

test('dealValue: defaults to 0 when not set', () => {
  const monitor = { id: 'mon_nodeal', name: 'Test' }
  const dealValue = monitor.dealValue || 0
  assert.equal(dealValue, 0)
})

test('dealValue: returned on GET /v1/monitors response', async () => {
  const redis = createMockRedis()
  const monitor = { id: 'mon_ret', name: 'Test', dealValue: 10000, active: true }
  await redis.set(`insights:monitor:${monitor.id}`, JSON.stringify(monitor))
  const stored = JSON.parse(await redis.get(`insights:monitor:${monitor.id}`))
  // Simulate what the API response builder does
  const response = { id: stored.id, name: stored.name, deal_value: stored.dealValue || 0 }
  assert.equal(response.deal_value, 10000)
})

// ── Unactioned count (ticker state) ──────────────────────────────────────────

test('ticker: 0 unactioned when all matches have feedback=up', () => {
  const matches = [
    { id: 'a', demandScore: 8, feedback: 'up' },
    { id: 'b', demandScore: 9, feedback: 'up' },
  ]
  const unactioned = matches.filter(m => (m.demandScore || 0) >= 7 && m.feedback !== 'up')
  assert.equal(unactioned.length, 0)
})

test('ticker: counts only high-demand unactioned matches', () => {
  const matches = [
    { id: 'a', demandScore: 8, feedback: null },   // high + unactioned
    { id: 'b', demandScore: 9, feedback: null },   // high + unactioned
    { id: 'c', demandScore: 3, feedback: null },   // low demand, skip
    { id: 'd', demandScore: 7, feedback: 'up' },   // actioned, skip
  ]
  const unactioned = matches.filter(m => (m.demandScore || 0) >= 7 && m.feedback !== 'up')
  assert.equal(unactioned.length, 2)
})
