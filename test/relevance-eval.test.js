// Regression lock for the relevance truth set (test/fixtures/relevance-truthset.json).
//
// This is NOT a precision benchmark — it pins the two invariants that any future
// relevance fix must not break:
//   1. retrieval-class contamination stays at 0 (PR #84 must not regress)
//   2. clearly-relevant true positives stay 100% admitted (no fix may drop them)
// Per-class leak rates for polysemy / intent_inversion are reported by the
// harness (scripts/relevance-eval.mjs) and are expected to move as those classes
// get addressed — they are deliberately NOT asserted here.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { passesRelevanceCheck } from '../lib/relevance.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/relevance-truthset.json', import.meta.url)))
const rows = fixture.rows

// Mirror the live pipeline gates (post-#84).
function admitted(r) {
  if (r.keywordType === 'competitor') {
    return !!r.competitorName && passesRelevanceCheck(r, r.competitorName, 'competitor')
  }
  return passesRelevanceCheck(r, r.query, r.keywordType || 'keyword')
}

function leakOf(failureType) {
  const rs = rows.filter(r => r.failure_type === failureType)
  return { total: rs.length, leaked: rs.filter(admitted).length }
}

test('truth set fixture is present and non-trivial', () => {
  assert.ok(Array.isArray(rows) && rows.length >= 40, `expected >=40 rows, got ${rows?.length}`)
})

test('retrieval contamination stays at 0 (PR #84 regression lock)', () => {
  const { total, leaked } = leakOf('retrieval')
  assert.ok(total > 0, 'fixture must contain retrieval-class rows')
  assert.equal(leaked, 0, `retrieval contamination regressed: ${leaked}/${total} competitor matches leaked through the brand gate`)
})

test('clearly-relevant true positives stay 100% admitted', () => {
  const { total, leaked } = leakOf('relevant')
  assert.ok(total > 0, 'fixture must contain at least one relevant true positive')
  assert.equal(leaked, total, `a relevance fix dropped a true positive: only ${leaked}/${total} admitted`)
})
