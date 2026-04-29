import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  validatePlatforms,
  migrateLegacyPlatforms,
  getEffectivePlatforms,
  VALID_PLATFORMS,
  PLATFORM_LABELS,
  PLATFORM_EMOJIS,
} from '../lib/platforms.js'

// ── VALID_PLATFORMS / labels / emojis ──────────────────────────────────────

test('VALID_PLATFORMS contains exactly the 10 supported platforms', () => {
  assert.equal(VALID_PLATFORMS.length, 10)
  assert.deepEqual(
    new Set(VALID_PLATFORMS),
    new Set(['reddit','hackernews','medium','substack','quora','upwork','fiverr','github','producthunt','twitter'])
  )
})

test('PLATFORM_LABELS + PLATFORM_EMOJIS define every valid platform', () => {
  for (const p of VALID_PLATFORMS) {
    assert.ok(PLATFORM_LABELS[p], `missing label for ${p}`)
    assert.ok(PLATFORM_EMOJIS[p], `missing emoji for ${p}`)
  }
})

// ── validatePlatforms ──────────────────────────────────────────────────────

test('validatePlatforms: rejects non-array input', () => {
  assert.equal(validatePlatforms('reddit').ok, false)
  assert.equal(validatePlatforms({ reddit: true }).ok, false)
  assert.equal(validatePlatforms(null).ok, false)
  assert.equal(validatePlatforms(undefined).ok, false)
})

test('validatePlatforms: rejects empty array', () => {
  const r = validatePlatforms([])
  assert.equal(r.ok, false)
  assert.match(r.error, /at least 1/)
})

test('validatePlatforms: accepts a single valid entry', () => {
  const r = validatePlatforms(['reddit'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.platforms, ['reddit'])
})

test('validatePlatforms: accepts multiple valid entries', () => {
  const r = validatePlatforms(['medium', 'substack'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.platforms, ['medium', 'substack'])
})

test('validatePlatforms: lowercases + trims input', () => {
  const r = validatePlatforms(['  Reddit ', 'MEDIUM'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.platforms, ['reddit', 'medium'])
})

test('validatePlatforms: dedupes repeated entries', () => {
  const r = validatePlatforms(['reddit', 'reddit', 'medium', 'reddit'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.platforms, ['reddit', 'medium'])
})

test('validatePlatforms: rejects non-string entries', () => {
  const r = validatePlatforms([123])
  assert.equal(r.ok, false)
  assert.match(r.error, /must be a string/)
})

test('validatePlatforms: accepts all 10 platforms at once', () => {
  const r = validatePlatforms(VALID_PLATFORMS)
  assert.equal(r.ok, true)
  assert.equal(r.platforms.length, 10)
})

test('validatePlatforms: rejects linkedin (parked until a real source is wired)', () => {
  const r = validatePlatforms(['linkedin'])
  assert.equal(r.ok, false)
  assert.match(r.error, /unknown platform/)
})

// ── migrateLegacyPlatforms ─────────────────────────────────────────────────

test('migrateLegacyPlatforms: returns existing platforms array as-is', () => {
  const m = { platforms: ['reddit', 'medium'] }
  assert.deepEqual(migrateLegacyPlatforms(m), ['reddit', 'medium'])
})

test('migrateLegacyPlatforms: legacy monitor with all flags true → all 6 currently-enabled', () => {
  // Old monitors had no platforms field; defaults were all 5 includeXxx + reddit always-on.
  const legacy = {
    includeMedium: true, includeSubstack: true, includeQuora: true,
    includeUpworkForum: true, includeFiverrForum: true,
  }
  const r = migrateLegacyPlatforms(legacy)
  assert.deepEqual(r.sort(), ['fiverr','medium','quora','reddit','substack','upwork'].sort())
})

test('migrateLegacyPlatforms: legacy monitor with no flags → still defaults to reddit + all 5 (since !==false defaults true)', () => {
  // The old API set !==false defaults — if a flag is undefined, treated as true.
  const legacy = {}
  const r = migrateLegacyPlatforms(legacy)
  assert.deepEqual(r.sort(), ['fiverr','medium','quora','reddit','substack','upwork'].sort())
})

test('migrateLegacyPlatforms: legacy monitor with includeMedium=false → drops Medium', () => {
  const legacy = { includeMedium: false }
  const r = migrateLegacyPlatforms(legacy)
  assert.equal(r.includes('medium'), false)
  assert.equal(r.includes('reddit'), true) // still defaults to reddit
})

test('migrateLegacyPlatforms: never auto-adds HN/GitHub/ProductHunt for legacy monitors', () => {
  // These weren't running on legacy monitors. Don't surprise users with new noise.
  const legacy = {}
  const r = migrateLegacyPlatforms(legacy)
  assert.equal(r.includes('hackernews'), false)
  assert.equal(r.includes('github'), false)
  assert.equal(r.includes('producthunt'), false)
})

test('migrateLegacyPlatforms: filters junk in existing platforms field', () => {
  const m = { platforms: ['reddit', 'invalid_one', 'medium'] }
  const r = migrateLegacyPlatforms(m)
  // Validation failure → fall back to ['reddit'] (safe default)
  assert.deepEqual(r, ['reddit'])
})

test('migrateLegacyPlatforms: empty array is treated as legacy (no field set)', () => {
  const m = { platforms: [] }
  const r = migrateLegacyPlatforms(m)
  // Empty array doesn't satisfy "exists with length > 0", so falls through to legacy migration
  assert.ok(r.includes('reddit'))
})

test('getEffectivePlatforms: alias for migrateLegacyPlatforms', () => {
  const m = { platforms: ['reddit'] }
  assert.deepEqual(getEffectivePlatforms(m), migrateLegacyPlatforms(m))
})
