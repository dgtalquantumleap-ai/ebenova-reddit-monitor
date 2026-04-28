import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { dedupAndRank, withinAge } from '../lib/sample-matches.js'

test('dedupAndRank dedups by URL', () => {
  const matches = [
    { url: 'https://r.com/1', title: 'A', createdAt: '2026-04-27T10:00:00Z', score: 5 },
    { url: 'https://r.com/2', title: 'B', createdAt: '2026-04-26T10:00:00Z', score: 3 },
    { url: 'https://r.com/1', title: 'A duplicate', createdAt: '2026-04-25T10:00:00Z', score: 99 },
  ]
  const r = dedupAndRank(matches, 5)
  assert.equal(r.length, 2)
})

test('dedupAndRank ranks by recency desc', () => {
  const matches = [
    { url: 'https://r.com/2', createdAt: '2026-04-26T10:00:00Z' },
    { url: 'https://r.com/1', createdAt: '2026-04-27T10:00:00Z' },
    { url: 'https://r.com/3', createdAt: '2026-04-25T10:00:00Z' },
  ]
  const r = dedupAndRank(matches, 5)
  assert.equal(r[0].url, 'https://r.com/1')
  assert.equal(r[1].url, 'https://r.com/2')
  assert.equal(r[2].url, 'https://r.com/3')
})

test('dedupAndRank caps at limit', () => {
  const matches = Array.from({ length: 20 }, (_, i) => ({
    url: `https://r.com/${i}`,
    createdAt: new Date(Date.now() - i * 1000).toISOString(),
  }))
  const r = dedupAndRank(matches, 5)
  assert.equal(r.length, 5)
})

test('withinAge accepts recent posts', () => {
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  assert.equal(withinAge(recent, 168), true)
})

test('withinAge rejects old posts', () => {
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  assert.equal(withinAge(old, 168), false)
})
