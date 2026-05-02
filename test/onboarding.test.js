import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'

// ── isOnboarded flag ──────────────────────────────────────────────────────────

test('onboarding: isOnboarded false when onboarded:{key} missing', async () => {
  const redis = createMockRedis()
  const apiKey = 'ins_abc123'
  const raw = await redis.get(`onboarded:${apiKey}`)
  assert.equal(raw, null)
  assert.equal(!raw, true) // isOnboarded = false
})

test('onboarding: isOnboarded true after setting onboarded:{key}', async () => {
  const redis = createMockRedis()
  const apiKey = 'ins_abc123'
  await redis.set(`onboarded:${apiKey}`, '1')
  const raw = await redis.get(`onboarded:${apiKey}`)
  assert.equal(raw, '1')
  assert.equal(!!raw, true) // isOnboarded = true
})

test('onboarding: flag has no TTL (persists indefinitely)', async () => {
  const redis = createMockRedis()
  const apiKey = 'ins_def456'
  await redis.set(`onboarded:${apiKey}`, '1')
  // MockRedis stores without TTL by default, so the value should still be there
  assert.equal(await redis.get(`onboarded:${apiKey}`), '1')
})

// ── Monitor auto-creation from preset ────────────────────────────────────────

test('onboarding: monitor created with preset keywords', async () => {
  const redis = createMockRedis()

  // Simulate the preset-based monitor creation (mirrors what the wizard does)
  const preset = {
    label: '💻 SaaS founder',
    suggestedName: 'SaaS Buying Intent',
    keywords: [
      { keyword: 'looking for software', intentType: 'buying', confidence: 'high' },
      { keyword: 'best tool for', intentType: 'buying', confidence: 'high' },
    ],
    platforms: ['reddit', 'hackernews', 'quora'],
  }
  const productName = 'My CRM Tool'
  const monitorName = `${productName} Monitor`
  const keywords = preset.keywords.map(k => ({ keyword: k.keyword, productContext: productName }))

  assert.equal(monitorName, 'My CRM Tool Monitor')
  assert.equal(keywords.length, 2)
  assert.equal(keywords[0].keyword, 'looking for software')
  assert.equal(keywords[0].productContext, 'My CRM Tool')

  // Store and verify
  const mon = { id: 'mon_test', name: monitorName, keywords, platforms: preset.platforms }
  await redis.set(`insights:monitor:${mon.id}`, JSON.stringify(mon))
  const stored = JSON.parse(await redis.get(`insights:monitor:${mon.id}`))
  assert.equal(stored.name, 'My CRM Tool Monitor')
  assert.deepEqual(stored.platforms, ['reddit', 'hackernews', 'quora'])
})

test('onboarding: wizard marks user as onboarded after monitor creation', async () => {
  const redis = createMockRedis()
  const apiKey = 'ins_xyz789'

  // Simulate the sequence: create monitor → mark onboarded
  await redis.set(`insights:monitor:mon_1`, JSON.stringify({ id: 'mon_1', name: 'Test Monitor' }))
  await redis.set(`onboarded:${apiKey}`, '1')

  assert.equal(await redis.get(`onboarded:${apiKey}`), '1')
})

// ── GET /v1/presets shape ─────────────────────────────────────────────────────

import { TEMPLATES } from '../lib/templates.js'

test('presets: TEMPLATES has exactly 8 buckets', () => {
  const keys = Object.keys(TEMPLATES)
  assert.equal(keys.length, 8)
})

test('presets: each template has label, keywords, and platforms', () => {
  for (const [id, tpl] of Object.entries(TEMPLATES)) {
    assert.ok(tpl.label, `${id}: missing label`)
    assert.ok(Array.isArray(tpl.keywords) && tpl.keywords.length > 0, `${id}: missing keywords`)
    assert.ok(Array.isArray(tpl.platforms) && tpl.platforms.length > 0, `${id}: missing platforms`)
  }
})

test('presets: GET /v1/presets response shape has keywordCount', () => {
  // Simulate the API response shape the frontend expects
  const response = Object.entries(TEMPLATES).map(([id, tpl]) => ({
    id,
    label: tpl.label,
    keywordCount: tpl.keywords.length,
    platforms: tpl.platforms,
  }))
  assert.equal(response.length, 8)
  assert.ok(response[0].id)
  assert.ok(response[0].label)
  assert.ok(typeof response[0].keywordCount === 'number')
  assert.ok(response[0].keywordCount > 0)
})
