import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildCompetitorKeywords, _internals } from '../lib/competitor-tracker.js'

test('buildCompetitorKeywords returns 5 phrases per competitor', () => {
  const result = buildCompetitorKeywords(['Notion'])
  assert.equal(result.length, 5)
  assert.ok(result.every(k => k.keyword.toLowerCase().includes('notion')))
})

test('buildCompetitorKeywords phrases match expected templates', () => {
  const result = buildCompetitorKeywords(['Acme'])
  const keywords = result.map(k => k.keyword)
  assert.ok(keywords.includes('Acme alternative'))
  assert.ok(keywords.includes('Acme sucks'))
  assert.ok(keywords.includes('switching from Acme'))
  assert.ok(keywords.includes('replace Acme'))
  assert.ok(keywords.includes('Acme vs'))
})

test('all returned entries have type:"competitor"', () => {
  const result = buildCompetitorKeywords(['Rival'])
  assert.ok(result.every(k => k.type === 'competitor'))
})

test('competitorName field is set on each entry', () => {
  const result = buildCompetitorKeywords(['Rival'])
  assert.ok(result.every(k => k.competitorName === 'Rival'))
})

test('multiple competitors generate 5 phrases each', () => {
  const result = buildCompetitorKeywords(['A', 'B', 'C'])
  assert.equal(result.length, 15)
})

test('returns [] for empty or non-array input', () => {
  assert.deepEqual(buildCompetitorKeywords([]), [])
  assert.deepEqual(buildCompetitorKeywords(null), [])
  assert.deepEqual(buildCompetitorKeywords(), [])
})

test('skips blank or non-string entries', () => {
  const result = buildCompetitorKeywords(['', 'Valid', null, 'Another'])
  assert.equal(result.length, 10)
  assert.ok(result.every(k => k.keyword.includes('Valid') || k.keyword.includes('Another')))
})
