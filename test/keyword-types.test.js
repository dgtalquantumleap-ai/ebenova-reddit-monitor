import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  VALID_KEYWORD_TYPES,
  normalizeKeyword,
  normalizeKeywordList,
  isValidKeywordType,
  isoWeekLabel,
  previousIsoWeekLabel,
} from '../lib/keyword-types.js'

// ── normalizeKeyword: input shapes ─────────────────────────────────────────

test('normalizeKeyword: plain string → defaults to type=keyword', () => {
  assert.deepEqual(normalizeKeyword('freelance contract'), {
    keyword: 'freelance contract', type: 'keyword', subreddits: [], productContext: '',
  })
})

test('normalizeKeyword: trims string input', () => {
  assert.equal(normalizeKeyword('  hi  ').keyword, 'hi')
})

test('normalizeKeyword: rejects too-short / empty string', () => {
  assert.equal(normalizeKeyword(''), null)
  assert.equal(normalizeKeyword(' '), null)
  assert.equal(normalizeKeyword('a'), null)   // <2 chars
})

test('normalizeKeyword: legacy object (no type) → adds type=keyword', () => {
  const r = normalizeKeyword({ keyword: 'kw', subreddits: ['SaaS'], productContext: 'pc' })
  assert.deepEqual(r, { keyword: 'kw', type: 'keyword', subreddits: ['SaaS'], productContext: 'pc' })
})

test('normalizeKeyword: object with type=competitor preserves it', () => {
  const r = normalizeKeyword({ keyword: 'DocuSign too expensive', type: 'competitor' })
  assert.equal(r.type, 'competitor')
})

test('normalizeKeyword: accepts `term` field (per spec) as keyword alias', () => {
  const r = normalizeKeyword({ term: 'X', type: 'competitor' })
  // 'X' is 1 char, so should reject — try a longer term
  assert.equal(r, null)
  const r2 = normalizeKeyword({ term: 'XY', type: 'competitor' })
  assert.equal(r2.keyword, 'XY')
  assert.equal(r2.type, 'competitor')
})

test('normalizeKeyword: unknown type silently coerces to keyword', () => {
  const r = normalizeKeyword({ keyword: 'kw', type: 'bogus' })
  assert.equal(r.type, 'keyword')
})

test('normalizeKeyword: type case-insensitive', () => {
  assert.equal(normalizeKeyword({ keyword: 'kw', type: 'COMPETITOR' }).type, 'competitor')
  assert.equal(normalizeKeyword({ keyword: 'kw', type: ' Competitor ' }).type, 'competitor')
})

test('normalizeKeyword: caps subreddits at 10 + productContext at 500 chars', () => {
  const subs = Array.from({ length: 20 }, (_, i) => `sr${i}`)
  const r = normalizeKeyword({
    keyword: 'kw', subreddits: subs, productContext: 'x'.repeat(800),
  })
  assert.equal(r.subreddits.length, 10)
  assert.equal(r.productContext.length, 500)
})

test('normalizeKeyword: rejects non-string non-object inputs', () => {
  assert.equal(normalizeKeyword(null), null)
  assert.equal(normalizeKeyword(undefined), null)
  assert.equal(normalizeKeyword(42), null)
  assert.equal(normalizeKeyword(true), null)
})

// ── normalizeKeywordList ──────────────────────────────────────────────────

test('normalizeKeywordList: handles mixed legacy + new format', () => {
  const out = normalizeKeywordList([
    'string-form',
    { keyword: 'object-form', type: 'competitor' },
    { keyword: 'no-type-form' },
    'a',                  // too short — dropped
    null,                 // dropped
    { junk: true },       // no keyword/term — dropped
  ])
  assert.equal(out.length, 3)
  assert.equal(out[0].keyword, 'string-form')
  assert.equal(out[0].type, 'keyword')
  assert.equal(out[1].keyword, 'object-form')
  assert.equal(out[1].type, 'competitor')
  assert.equal(out[2].keyword, 'no-type-form')
  assert.equal(out[2].type, 'keyword')
})

test('normalizeKeywordList: returns [] for non-array', () => {
  assert.deepEqual(normalizeKeywordList(null), [])
  assert.deepEqual(normalizeKeywordList(undefined), [])
  assert.deepEqual(normalizeKeywordList('string'), [])
})

// ── VALID_KEYWORD_TYPES + isValidKeywordType ──────────────────────────────

test('VALID_KEYWORD_TYPES includes phrase', () => {
  assert.ok(VALID_KEYWORD_TYPES.includes('phrase'))
  assert.ok(VALID_KEYWORD_TYPES.includes('keyword'))
  assert.ok(VALID_KEYWORD_TYPES.includes('competitor'))
  assert.equal(VALID_KEYWORD_TYPES.length, 3)
})

test('isValidKeywordType: accepts keyword, competitor, phrase', () => {
  assert.equal(isValidKeywordType('keyword'),    true)
  assert.equal(isValidKeywordType('competitor'), true)
  assert.equal(isValidKeywordType('phrase'),     true)
  assert.equal(isValidKeywordType('  PHRASE '),  true)   // trim + lowercase
  assert.equal(isValidKeywordType('rival'),      false)
  assert.equal(isValidKeywordType(''),           false)
  assert.equal(isValidKeywordType(null),         false)
  assert.equal(isValidKeywordType(123),          false)
})

// ── phrase type ───────────────────────────────────────────────────────────────

test('normalizeKeyword: quoted string → type=phrase, quotes stripped', () => {
  const r = normalizeKeyword('"scope creep"')
  assert.equal(r.keyword, 'scope creep')
  assert.equal(r.type, 'phrase')
})

test('normalizeKeyword: single-quoted word → type=phrase', () => {
  const r = normalizeKeyword('"freelance"')
  assert.equal(r.keyword, 'freelance')
  assert.equal(r.type, 'phrase')
})

test('normalizeKeyword: object with type=phrase is preserved', () => {
  const r = normalizeKeyword({ keyword: 'scope creep', type: 'phrase' })
  assert.equal(r.type, 'phrase')
  assert.equal(r.keyword, 'scope creep')
})

test('normalizeKeyword: quoted string with only spaces inside is rejected', () => {
  assert.equal(normalizeKeyword('"  "'), null)
  assert.equal(normalizeKeyword('" "'), null)
})

test('normalizeKeyword: unmatched quotes are treated as plain keyword', () => {
  const r = normalizeKeyword('"no closing')
  assert.equal(r.type, 'keyword')
  assert.equal(r.keyword, '"no closing')
})

// ── isoWeekLabel ──────────────────────────────────────────────────────────

test('isoWeekLabel: standard YYYY-Www format', () => {
  // 2026-04-29 is a Wednesday in ISO week 18 of 2026
  assert.equal(isoWeekLabel(new Date('2026-04-29T12:00:00Z')), '2026-W18')
})

test('isoWeekLabel: zero-pads single-digit weeks', () => {
  assert.equal(isoWeekLabel(new Date('2026-01-05T12:00:00Z')), '2026-W02')
  assert.equal(isoWeekLabel(new Date('2026-01-12T12:00:00Z')), '2026-W03')
})

test('isoWeekLabel: handles year-boundary correctly', () => {
  // 2025-12-29 is Monday of ISO week 1 of 2026 (year-edge case)
  assert.equal(isoWeekLabel(new Date('2025-12-29T12:00:00Z')), '2026-W01')
  // 2024-12-30 is Monday of week 1 of 2025
  assert.equal(isoWeekLabel(new Date('2024-12-30T12:00:00Z')), '2025-W01')
})

test('previousIsoWeekLabel: returns the week 7 days earlier', () => {
  assert.equal(previousIsoWeekLabel(new Date('2026-04-29T12:00:00Z')), '2026-W17')
  assert.equal(previousIsoWeekLabel(new Date('2026-01-05T12:00:00Z')), '2026-W01')
})
