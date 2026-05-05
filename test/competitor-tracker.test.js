import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildCompetitorKeywords } from '../lib/competitor-tracker.js'

test('buildCompetitorKeywords generates 5 phrases per competitor', () => {
  const phrases = buildCompetitorKeywords(['Lemonade'])
  assert.equal(phrases.length, 5)
  assert.ok(phrases.includes('Lemonade alternative'))
  assert.ok(phrases.includes('Lemonade sucks'))
  assert.ok(phrases.includes('switching from Lemonade'))
  assert.ok(phrases.includes('replace Lemonade'))
  assert.ok(phrases.includes('Lemonade vs'))
})

test('buildCompetitorKeywords handles multiple competitors', () => {
  const phrases = buildCompetitorKeywords(['CompA', 'CompB'])
  assert.equal(phrases.length, 10)
})

test('buildCompetitorKeywords returns [] for empty input', () => {
  assert.deepEqual(buildCompetitorKeywords([]), [])
  assert.deepEqual(buildCompetitorKeywords(), [])
})

test('buildCompetitorKeywords skips empty/null names', () => {
  const phrases = buildCompetitorKeywords(['Valid', '', null, 'Also Valid'])
  assert.equal(phrases.length, 10)
})
