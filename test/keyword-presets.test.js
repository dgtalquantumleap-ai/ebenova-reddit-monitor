// Vertical-keyword presets (Roadmap PR #33).
//
// These pin the contract that the dashboard and the worker both depend on:
// the library has the right shape, every preset is internally consistent
// (every keyword has a type, every platform exists in VALID_PLATFORMS), and
// the public endpoints return a stable shape — list view omits the
// subreddits hint, per-id view includes it.

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PRESET_LIBRARY, listPresets, getPreset, presetForList } from '../lib/keyword-presets.js'
import { VALID_PLATFORMS } from '../lib/platforms.js'

const VALID_PLATFORMS_SET = new Set(VALID_PLATFORMS)

// ── Library-shape tests ────────────────────────────────────────────────────

test('1. PRESET_LIBRARY has exactly 8 entries', () => {
  assert.equal(Object.keys(PRESET_LIBRARY).length, 8)
})

test('2. every preset has the required fields', () => {
  for (const [key, p] of Object.entries(PRESET_LIBRARY)) {
    assert.equal(p.id, key, `${key}: id must equal the library key`)
    assert.equal(typeof p.label, 'string')
    assert.ok(p.label.length > 0, `${key}: label must not be empty`)
    assert.equal(typeof p.emoji, 'string')
    assert.ok(p.emoji.length > 0, `${key}: emoji must not be empty`)
    assert.equal(typeof p.description, 'string')
    assert.ok(Array.isArray(p.keywords),  `${key}: keywords must be an array`)
    assert.ok(Array.isArray(p.platforms), `${key}: platforms must be an array`)
    assert.ok(Array.isArray(p.subreddits), `${key}: subreddits must be an array`)
    assert.equal(p.mode, 'keyword',       `${key}: mode must be 'keyword'`)
  }
})

test('3. every keyword in every preset has a valid type field', () => {
  const ALLOWED = new Set(['keyword', 'competitor'])
  for (const [key, p] of Object.entries(PRESET_LIBRARY)) {
    for (const kw of p.keywords) {
      assert.equal(typeof kw.term, 'string', `${key}: keyword.term must be a string`)
      assert.ok(kw.term.length > 0, `${key}: keyword.term must not be empty`)
      assert.ok(ALLOWED.has(kw.type), `${key}: keyword "${kw.term}" has bad type "${kw.type}"`)
    }
  }
})

test('4. every platform in every preset exists in VALID_PLATFORMS', () => {
  for (const [key, p] of Object.entries(PRESET_LIBRARY)) {
    for (const platform of p.platforms) {
      assert.ok(
        VALID_PLATFORMS_SET.has(platform),
        `preset "${key}" references unknown platform "${platform}" (not in VALID_PLATFORMS)`,
      )
    }
  }
})

test('8. no preset has an empty keywords array', () => {
  for (const [key, p] of Object.entries(PRESET_LIBRARY)) {
    assert.ok(p.keywords.length > 0, `${key}: keywords must be non-empty`)
  }
})

// ── presetForList shape (used by GET /v1/presets) ──────────────────────────

test('presetForList strips the subreddits field from a preset', () => {
  const p = PRESET_LIBRARY.freelancing
  const view = presetForList(p)
  assert.equal(view.id, 'freelancing')
  assert.equal(view.subreddits, undefined, 'subreddits must be omitted from the list-shape view')
  assert.ok(Array.isArray(view.keywords))
  assert.ok(Array.isArray(view.platforms))
})

test('presetForList(null/undefined) returns null safely', () => {
  assert.equal(presetForList(null), null)
  assert.equal(presetForList(undefined), null)
})

// ── Endpoint factory tests (mimic api-server.js handler shape) ─────────────

function makeListHandler() {
  return (req, res) => {
    const presets = listPresets()
    res.json({ success: true, presets, count: presets.length })
  }
}

function makeGetHandler() {
  return (req, res) => {
    const preset = getPreset(req.params.id)
    if (!preset) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Preset not found' } })
    }
    res.json({ success: true, preset })
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

test('5. GET /v1/presets returns 200 with all 8 presets and no subreddits leakage', async () => {
  const r = await call(makeListHandler(), { params: {} })
  assert.equal(r.status, 200)
  assert.equal(r.payload.success, true)
  assert.equal(r.payload.count, 8)
  assert.equal(r.payload.presets.length, 8)
  for (const p of r.payload.presets) {
    assert.equal(p.subreddits, undefined, `${p.id}: subreddits should not appear in /v1/presets list`)
  }
})

test('6. GET /v1/presets/:id returns the full preset (with subreddits) for a valid id', async () => {
  const r = await call(makeGetHandler(), { params: { id: 'freelancing' } })
  assert.equal(r.status, 200)
  assert.equal(r.payload.success, true)
  assert.equal(r.payload.preset.id, 'freelancing')
  assert.ok(Array.isArray(r.payload.preset.subreddits))
  assert.ok(r.payload.preset.subreddits.length > 0)
})

test('7. GET /v1/presets/:id returns 404 for an invalid id', async () => {
  const r = await call(makeGetHandler(), { params: { id: 'not-a-real-preset' } })
  assert.equal(r.status, 404)
  assert.equal(r.payload.success, false)
  assert.equal(r.payload.error.code, 'NOT_FOUND')
})

test('GET /v1/presets/:id returns 404 for empty / null id', async () => {
  for (const id of ['', null, undefined]) {
    const r = await call(makeGetHandler(), { params: { id } })
    assert.equal(r.status, 404)
  }
})
