// GET /v1/platforms — single source of truth for the dashboard chip grid.
//
// The endpoint reads VALID_PLATFORMS + PLATFORM_LABELS + PLATFORM_EMOJIS
// from lib/platforms.js. These tests pin the contract so the dashboard's
// "Where to scan" picker stays in sync with the worker's platform-runner
// table without ever drifting again.

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { VALID_PLATFORMS, PLATFORM_LABELS, PLATFORM_EMOJIS } from '../lib/platforms.js'

// Endpoint factory — same shape api-server.js uses, lifted here so the
// test doesn't need to spin up Express.
function makeListHandler() {
  return (req, res) => {
    const platforms = VALID_PLATFORMS.map(id => ({
      id,
      label: PLATFORM_LABELS[id] || id,
      emoji: PLATFORM_EMOJIS[id] || '•',
    }))
    res.json({ success: true, platforms, count: platforms.length })
  }
}

async function call(handler, req = {}) {
  let status = 200, payload
  const res = {
    status(s) { status = s; return this },
    json(p)   { payload = p; return this },
  }
  await handler(req, res)
  return { status, payload }
}

test('GET /v1/platforms returns 200 with all VALID_PLATFORMS', async () => {
  const r = await call(makeListHandler(), {})
  assert.equal(r.status, 200)
  assert.equal(r.payload.success, true)
  assert.equal(r.payload.count, VALID_PLATFORMS.length)
  assert.equal(r.payload.platforms.length, VALID_PLATFORMS.length)
})

test('GET /v1/platforms emits one entry per VALID_PLATFORMS id with id+label+emoji', async () => {
  const r = await call(makeListHandler(), {})
  for (const p of r.payload.platforms) {
    assert.equal(typeof p.id,    'string')
    assert.equal(typeof p.label, 'string')
    assert.equal(typeof p.emoji, 'string')
    assert.ok(p.id.length > 0,    'id must not be empty')
    assert.ok(p.label.length > 0, 'label must not be empty')
    assert.ok(p.emoji.length > 0, 'emoji must not be empty')
  }
})

test('GET /v1/platforms preserves VALID_PLATFORMS ordering', async () => {
  const r = await call(makeListHandler(), {})
  const ids = r.payload.platforms.map(p => p.id)
  assert.deepEqual(ids, VALID_PLATFORMS,
    'endpoint order must match VALID_PLATFORMS array order')
})

test('every platform from /v1/platforms has matching label + emoji from the source maps', async () => {
  const r = await call(makeListHandler(), {})
  for (const p of r.payload.platforms) {
    assert.equal(p.label, PLATFORM_LABELS[p.id], `${p.id}: label mismatch`)
    assert.equal(p.emoji, PLATFORM_EMOJIS[p.id], `${p.id}: emoji mismatch`)
  }
})

// Regression guard for the bug this endpoint fixes — the dashboard had a
// hardcoded list that drifted 4 platforms behind VALID_PLATFORMS. If a
// future PR adds a platform but forgets the label/emoji, this catches it.
test('every VALID_PLATFORMS id has a label AND emoji defined', () => {
  for (const id of VALID_PLATFORMS) {
    assert.ok(PLATFORM_LABELS[id], `missing PLATFORM_LABELS[${id}]`)
    assert.ok(PLATFORM_EMOJIS[id], `missing PLATFORM_EMOJIS[${id}]`)
  }
})

// Pin the four platforms that were missing from the dashboard until this
// endpoint shipped — twitter, jijing, youtube, amazon. If the platform
// drops out of VALID_PLATFORMS, this test fails noisily.
test('the 4 previously-missing platforms are surfaced via /v1/platforms', async () => {
  const r = await call(makeListHandler(), {})
  const ids = new Set(r.payload.platforms.map(p => p.id))
  for (const expected of ['twitter', 'jijing', 'youtube', 'amazon']) {
    assert.ok(ids.has(expected), `${expected} should be in the endpoint output`)
  }
})
