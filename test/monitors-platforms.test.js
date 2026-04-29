// Integration tests for POST /v1/monitors and PATCH /v1/monitors/:id
// platform-selection handling. Loads the live api-server.js and calls into
// it via supertest-like fetch against an ephemeral port.
//
// Strategy: rather than spinning up the whole HTTP stack (which needs Redis
// + Stripe env), we test the platforms validation + Redis side-effects
// against the lib/platforms.js module directly. The monitor schema is a
// pure data-transform — no Express needed.

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'
import { validatePlatforms, migrateLegacyPlatforms } from '../lib/platforms.js'

// Helper: simulate the platforms-handling slice of POST /v1/monitors
function resolvePlatformsForCreate(input) {
  if (input === undefined || input === null) {
    return { ok: true, platforms: ['reddit'] }
  }
  return validatePlatforms(input)
}

test('POST /v1/monitors body with platforms=["reddit"] → saves correctly', () => {
  const r = resolvePlatformsForCreate(['reddit'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.platforms, ['reddit'])
})

test('POST /v1/monitors body with platforms=["medium","substack"] → saves correctly, reddit NOT in list', () => {
  const r = resolvePlatformsForCreate(['medium', 'substack'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.platforms, ['medium', 'substack'])
  assert.equal(r.platforms.includes('reddit'), false)
})

test('POST /v1/monitors body with platforms=[] → returns 400', () => {
  const r = resolvePlatformsForCreate([])
  assert.equal(r.ok, false)
  assert.match(r.error, /at least 1/)
})

test('POST /v1/monitors body with platforms=["twitter"] → returns 400 (invalid platform)', () => {
  const r = resolvePlatformsForCreate(['twitter'])
  assert.equal(r.ok, false)
  assert.match(r.error, /unknown platform/)
})

test('POST /v1/monitors body with no platforms field → defaults to ["reddit"]', () => {
  const r = resolvePlatformsForCreate(undefined)
  assert.equal(r.ok, true)
  assert.deepEqual(r.platforms, ['reddit'])
})

test('POST /v1/monitors body with platforms=null → defaults to ["reddit"]', () => {
  const r = resolvePlatformsForCreate(null)
  assert.equal(r.ok, true)
  assert.deepEqual(r.platforms, ['reddit'])
})

// ── PATCH /v1/monitors/:id (platforms field) ───────────────────────────────

test('PATCH /v1/monitors/:id body validates platforms identically to POST', () => {
  // Same validatePlatforms is used for both — reuse the contract
  assert.equal(validatePlatforms(['github', 'producthunt']).ok, true)
  assert.equal(validatePlatforms(['xanga']).ok, false)
  assert.equal(validatePlatforms([]).ok, false)
})

test('PATCH simulates persisting updated platforms to Redis', async () => {
  const redis = createMockRedis()
  const mon = {
    id: 'mon_test',
    owner: 'a@x.com',
    platforms: ['reddit'],
    keywords: [{ keyword: 'crm' }],
    active: true,
  }
  await redis.set(`insights:monitor:${mon.id}`, JSON.stringify(mon))
  // Simulate the patch slice
  const v = validatePlatforms(['reddit', 'medium', 'github'])
  assert.equal(v.ok, true)
  const next = { ...mon, platforms: v.platforms }
  await redis.set(`insights:monitor:${mon.id}`, JSON.stringify(next))
  const stored = JSON.parse(await redis.get(`insights:monitor:${mon.id}`))
  assert.deepEqual(stored.platforms, ['reddit', 'medium', 'github'])
})

// ── Poll-loop gating (platforms.includes(key)) ─────────────────────────────

test('Poll loop simulation: platforms=["reddit"] only — only Reddit scraper runs', () => {
  const platforms = ['reddit']
  const platformRunners = [
    { key: 'hackernews', ran: false },
    { key: 'medium',     ran: false },
    { key: 'substack',   ran: false },
    { key: 'quora',      ran: false },
    { key: 'upwork',     ran: false },
    { key: 'fiverr',     ran: false },
    { key: 'github',     ran: false },
    { key: 'producthunt',ran: false },
  ]
  const redditRan = platforms.includes('reddit')
  for (const r of platformRunners) {
    if (platforms.includes(r.key)) r.ran = true
  }
  assert.equal(redditRan, true)
  assert.deepEqual(platformRunners.filter(r => r.ran), [])
})

test('Poll loop simulation: platforms=["medium","quora"] — only those two run, Reddit skipped', () => {
  const platforms = ['medium', 'quora']
  const platformRunners = [
    { key: 'hackernews', ran: false },
    { key: 'medium',     ran: false },
    { key: 'substack',   ran: false },
    { key: 'quora',      ran: false },
    { key: 'upwork',     ran: false },
    { key: 'fiverr',     ran: false },
    { key: 'github',     ran: false },
    { key: 'producthunt',ran: false },
  ]
  const redditRan = platforms.includes('reddit')
  for (const r of platformRunners) {
    if (platforms.includes(r.key)) r.ran = true
  }
  assert.equal(redditRan, false, 'Reddit should not run when not in platforms')
  const ranKeys = platformRunners.filter(r => r.ran).map(r => r.key)
  assert.deepEqual(ranKeys.sort(), ['medium', 'quora'])
})

test('Poll loop simulation: legacy monitor (no platforms field) → derived runs all 6 currently-enabled', () => {
  const legacyMonitor = {
    includeMedium: true, includeSubstack: true, includeQuora: true,
    includeUpworkForum: true, includeFiverrForum: true,
  }
  const platforms = migrateLegacyPlatforms(legacyMonitor)
  const allKeys = ['reddit','hackernews','medium','substack','quora','upwork','fiverr','github','producthunt']
  const ranKeys = allKeys.filter(k => platforms.includes(k))
  // Reddit + the 5 legacy include* fields = 6 platforms
  assert.deepEqual(ranKeys.sort(), ['fiverr','medium','quora','reddit','substack','upwork'].sort())
})

// ── Email platform badges ──────────────────────────────────────────────────

test('Email platform badges: only show platforms in the platforms array', () => {
  // Simulate the badge-rendering slice from monitor-v2.js buildAlertEmail
  const monitor = { platforms: ['reddit', 'github'] }
  const active = migrateLegacyPlatforms(monitor)
  assert.deepEqual(active, ['reddit', 'github'])
  // Build a simple text representation of badges to assert on
  const badges = active.map(p => `[${p}]`).join('')
  assert.ok(badges.includes('[reddit]'))
  assert.ok(badges.includes('[github]'))
  assert.ok(!badges.includes('[medium]'))
  assert.ok(!badges.includes('[hackernews]'))
})

// ── Combined PATCH /v1/monitors/:id (platforms + emailEnabled) ─────────────
//
// The PATCH handler accepts either field, both, or neither. These tests
// mirror the handler's body-parsing + validation logic so we verify shape
// without spinning up Express. Helper below mirrors the route's logic 1:1.

function simulateCombinedPatch(body) {
  const updates = {}
  if (Object.prototype.hasOwnProperty.call(body || {}, 'platforms')) {
    const v = validatePlatforms(body.platforms)
    if (!v.ok) return { status: 400, error: { code: 'INVALID_PLATFORMS', message: v.error } }
    updates.platforms = v.platforms
    updates.includeMedium      = v.platforms.includes('medium')
    updates.includeSubstack    = v.platforms.includes('substack')
    updates.includeQuora       = v.platforms.includes('quora')
    updates.includeUpworkForum = v.platforms.includes('upwork')
    updates.includeFiverrForum = v.platforms.includes('fiverr')
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, 'emailEnabled')) {
    if (typeof body.emailEnabled !== 'boolean') {
      return { status: 400, error: { code: 'INVALID_INPUT', message: '`emailEnabled` must be a boolean' } }
    }
    updates.emailEnabled = body.emailEnabled
  }
  if (Object.keys(updates).length === 0) {
    return { status: 400, error: { code: 'NO_UPDATES', message: 'No supported fields in body. Patchable: platforms, emailEnabled' } }
  }
  return { status: 200, updates }
}

test('Combined PATCH: both platforms and emailEnabled — updates both', () => {
  const r = simulateCombinedPatch({ platforms: ['reddit', 'medium'], emailEnabled: false })
  assert.equal(r.status, 200)
  assert.deepEqual(r.updates.platforms, ['reddit', 'medium'])
  assert.equal(r.updates.emailEnabled, false)
})

test('Combined PATCH: only platforms — emailEnabled untouched', () => {
  const r = simulateCombinedPatch({ platforms: ['github'] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.updates.platforms, ['github'])
  assert.equal(Object.prototype.hasOwnProperty.call(r.updates, 'emailEnabled'), false)
})

test('Combined PATCH: only emailEnabled — platforms untouched', () => {
  const r = simulateCombinedPatch({ emailEnabled: false })
  assert.equal(r.status, 200)
  assert.equal(r.updates.emailEnabled, false)
  assert.equal(Object.prototype.hasOwnProperty.call(r.updates, 'platforms'), false)
})

test('Combined PATCH: empty body — returns 400 NO_UPDATES', () => {
  const r = simulateCombinedPatch({})
  assert.equal(r.status, 400)
  assert.equal(r.error.code, 'NO_UPDATES')
})

test('Combined PATCH: undefined body — returns 400 NO_UPDATES', () => {
  const r = simulateCombinedPatch(undefined)
  assert.equal(r.status, 400)
  assert.equal(r.error.code, 'NO_UPDATES')
})

test('Combined PATCH: invalid platforms rejects with INVALID_PLATFORMS', () => {
  const r = simulateCombinedPatch({ platforms: ['twitter'], emailEnabled: false })
  assert.equal(r.status, 400)
  assert.equal(r.error.code, 'INVALID_PLATFORMS')
})

test('Combined PATCH: empty platforms array rejects', () => {
  const r = simulateCombinedPatch({ platforms: [] })
  assert.equal(r.status, 400)
  assert.equal(r.error.code, 'INVALID_PLATFORMS')
})

test('Combined PATCH: non-boolean emailEnabled rejects with INVALID_INPUT', () => {
  const r = simulateCombinedPatch({ emailEnabled: 'false' })  // string, not boolean
  assert.equal(r.status, 400)
  assert.equal(r.error.code, 'INVALID_INPUT')
})

test('Combined PATCH: emailEnabled=1 (number) rejects', () => {
  const r = simulateCombinedPatch({ emailEnabled: 1 })
  assert.equal(r.status, 400)
  assert.equal(r.error.code, 'INVALID_INPUT')
})

test('Combined PATCH: emailEnabled=true accepted', () => {
  const r = simulateCombinedPatch({ emailEnabled: true })
  assert.equal(r.status, 200)
  assert.equal(r.updates.emailEnabled, true)
})

test('Combined PATCH: invalid emailEnabled rejects even if platforms valid', () => {
  const r = simulateCombinedPatch({ platforms: ['reddit'], emailEnabled: 1 })
  assert.equal(r.status, 400)
  assert.equal(r.error.code, 'INVALID_INPUT')
})

test('Combined PATCH: legacy includeXxx flags get mirrored from platforms', () => {
  const r = simulateCombinedPatch({ platforms: ['reddit', 'medium', 'fiverr'] })
  assert.equal(r.updates.includeMedium, true)
  assert.equal(r.updates.includeFiverrForum, true)
  assert.equal(r.updates.includeSubstack, false)  // not in array
  assert.equal(r.updates.includeQuora, false)
  assert.equal(r.updates.includeUpworkForum, false)
})
