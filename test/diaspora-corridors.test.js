// Diaspora corridor library (Roadmap PR #36).
//
// Pins every guarantee the worker's runMonitor() corridor-override path and
// the dashboard's create-monitor flow rely on:
//   - the library has 3 entries with the right shape
//   - every platform reference exists in VALID_PLATFORMS (otherwise the
//     worker's platform-runner table would silently skip a corridor's
//     scrapers)
//   - the public endpoints serve the right shape (list omits subreddits;
//     per-id includes them; bad id → 404)

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  DIASPORA_CORRIDORS,
  listCorridors,
  getCorridor,
  isValidCorridorId,
  corridorForList,
} from '../lib/diaspora-corridors.js'
import { VALID_PLATFORMS } from '../lib/platforms.js'

const VALID_PLATFORMS_SET = new Set(VALID_PLATFORMS)

// ─── 1. exactly 3 entries ─────────────────────────────────────────────────

test('1. DIASPORA_CORRIDORS has exactly 3 entries', () => {
  assert.equal(DIASPORA_CORRIDORS.length, 3)
})

// ─── 2. every corridor has the required fields ────────────────────────────

test('2. every corridor has the required fields', () => {
  for (const c of DIASPORA_CORRIDORS) {
    assert.equal(typeof c.id, 'string')
    assert.ok(c.id.length > 0, `corridor must have a non-empty id`)
    assert.equal(typeof c.label, 'string')
    assert.ok(c.label.length > 0, `${c.id}: label must not be empty`)
    assert.equal(typeof c.emoji, 'string')
    assert.ok(c.emoji.length > 0, `${c.id}: emoji must not be empty`)
    assert.equal(typeof c.description, 'string')
    assert.ok(Array.isArray(c.platforms),  `${c.id}: platforms must be an array`)
    assert.ok(Array.isArray(c.subreddits), `${c.id}: subreddits must be an array`)
    assert.ok(Array.isArray(c.keywords),   `${c.id}: keywords must be an array`)
    assert.ok(c.keywords.length > 0,       `${c.id}: keywords must be non-empty`)
    assert.ok(c.platforms.length > 0,      `${c.id}: platforms must be non-empty`)
  }
})

// ─── 3. every platform exists in VALID_PLATFORMS ──────────────────────────

test('3. every platform reference exists in VALID_PLATFORMS', () => {
  for (const c of DIASPORA_CORRIDORS) {
    for (const p of c.platforms) {
      assert.ok(
        VALID_PLATFORMS_SET.has(p),
        `corridor "${c.id}" references unknown platform "${p}"`,
      )
    }
  }
})

// ─── corridorForList strips subreddits ────────────────────────────────────

test('corridorForList omits subreddits from the list view', () => {
  const c = DIASPORA_CORRIDORS[0]
  const view = corridorForList(c)
  assert.equal(view.id, c.id)
  assert.equal(view.subreddits, undefined, 'subreddits must be omitted from list view')
  assert.ok(Array.isArray(view.platforms), 'platforms must remain in the list view')
})

test('corridorForList(null/undefined) returns null safely', () => {
  assert.equal(corridorForList(null), null)
  assert.equal(corridorForList(undefined), null)
})

// ─── isValidCorridorId ────────────────────────────────────────────────────

test('isValidCorridorId returns true for known ids, false for unknown', () => {
  for (const c of DIASPORA_CORRIDORS) {
    assert.equal(isValidCorridorId(c.id), true, `${c.id} should be valid`)
  }
  assert.equal(isValidCorridorId('not-a-corridor'), false)
  assert.equal(isValidCorridorId(''),               false)
  assert.equal(isValidCorridorId(null),             false)
  assert.equal(isValidCorridorId(undefined),        false)
})

// ─── getCorridor returns full corridor (with subreddits) ──────────────────

test('getCorridor returns the full record (including subreddits)', () => {
  const c = getCorridor('lagos_london')
  assert.ok(c, 'lagos_london should resolve to a corridor')
  assert.equal(c.id, 'lagos_london')
  assert.ok(Array.isArray(c.subreddits))
  assert.ok(c.subreddits.length > 0)
})

test('getCorridor returns null for unknown id', () => {
  assert.equal(getCorridor('nope'),     null)
  assert.equal(getCorridor(''),         null)
  assert.equal(getCorridor(null),       null)
  assert.equal(getCorridor(undefined),  null)
})

// ─── Endpoint factory tests (mimic api-server.js handler shape) ───────────

function makeListHandler() {
  return (req, res) => {
    const corridors = listCorridors()
    res.json({ success: true, corridors, count: corridors.length })
  }
}

function makeGetHandler() {
  return (req, res) => {
    const corridor = getCorridor(req.params.id)
    if (!corridor) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Corridor not found' } })
    }
    res.json({ success: true, corridor })
  }
}

async function call(handler, req) {
  let status = 200, payload
  const res = {
    status(s) { status = s; return this },
    json(p)   { payload = p; return this },
  }
  await handler(req, res)
  return { status, payload }
}

// ─── 4. GET /v1/corridors returns all 3 ───────────────────────────────────

test('4. GET /v1/corridors returns 200 with all 3 corridors and no subreddits leakage', async () => {
  const r = await call(makeListHandler(), { params: {} })
  assert.equal(r.status, 200)
  assert.equal(r.payload.success, true)
  assert.equal(r.payload.count, 3)
  assert.equal(r.payload.corridors.length, 3)
  for (const c of r.payload.corridors) {
    assert.equal(c.subreddits, undefined, `${c.id}: subreddits should not leak in list`)
  }
})

// ─── 5. GET /v1/corridors/:id returns correct corridor ────────────────────

test('5. GET /v1/corridors/:id returns the full corridor for a valid id', async () => {
  const r = await call(makeGetHandler(), { params: { id: 'lagos_houston' } })
  assert.equal(r.status, 200)
  assert.equal(r.payload.success, true)
  assert.equal(r.payload.corridor.id, 'lagos_houston')
  assert.ok(Array.isArray(r.payload.corridor.subreddits))
  assert.ok(r.payload.corridor.subreddits.length > 0)
})

// ─── 6. GET /v1/corridors/invalid returns 404 ─────────────────────────────

test('6. GET /v1/corridors/:id returns 404 for unknown id', async () => {
  const r = await call(makeGetHandler(), { params: { id: 'lagos_atlantis' } })
  assert.equal(r.status, 404)
  assert.equal(r.payload.success, false)
  assert.equal(r.payload.error.code, 'NOT_FOUND')
})

test('GET /v1/corridors/:id returns 404 for empty / null / undefined id', async () => {
  for (const id of ['', null, undefined]) {
    const r = await call(makeGetHandler(), { params: { id } })
    assert.equal(r.status, 404)
  }
})

// ─── ID list pinned (regression guard for the spec) ───────────────────────

test('the 3 corridor ids match the spec exactly', () => {
  assert.deepEqual(
    new Set(DIASPORA_CORRIDORS.map(c => c.id)),
    new Set(['lagos_london', 'lagos_toronto', 'lagos_houston']),
  )
})
