import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { embeddingCacheKey } from '../lib/embedding-cache.js'

test('hashes full text, not prefix', () => {
  const long1 = 'A'.repeat(100) + '__suffix1'
  const long2 = 'A'.repeat(100) + '__suffix2'
  assert.notEqual(embeddingCacheKey(long1), embeddingCacheKey(long2),
    'two texts with same first 100 chars but different suffix must differ')
})

test('same text gives same key (idempotent)', () => {
  const t = 'Some sample post text'
  assert.equal(embeddingCacheKey(t), embeddingCacheKey(t))
})

test('returns a short hex string', () => {
  assert.match(embeddingCacheKey('x'), /^[a-f0-9]{16}$/)
})
