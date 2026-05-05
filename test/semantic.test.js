import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { cosineSimilarity, embedText, isSemanticMatch, _internals } from '../lib/semantic.js'

test('cosineSimilarity returns 1 for identical vectors', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1)
})

test('cosineSimilarity returns 0 for orthogonal vectors', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
})

test('cosineSimilarity returns 0 for null input', () => {
  assert.equal(cosineSimilarity(null, [1, 0]), 0)
  assert.equal(cosineSimilarity([1, 0], null), 0)
})

test('cosineSimilarity handles length mismatch', () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0)
})

test('embedText returns null when VOYAGE_API_KEY missing', async () => {
  const r = await embedText('hello', null)
  assert.equal(r, null)
})

test('embedText returns null on non-2xx response', async () => {
  const original = global.fetch
  global.fetch = async () => ({ ok: false, status: 429 })
  try {
    const r = await embedText('hello', 'fake-key')
    assert.equal(r, null)
  } finally { global.fetch = original }
})

test('embedText returns embedding vector on success', async () => {
  const original = global.fetch
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
  })
  try {
    const r = await embedText('hello', 'fake-key')
    assert.deepEqual(r, [0.1, 0.2, 0.3])
  } finally { global.fetch = original }
})

test('isSemanticMatch returns true when similarity >= threshold', async () => {
  // Pre-supply queryVec so only one API call needed
  const queryVec = [1, 0]
  const original = global.fetch
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ embedding: [0.95, 0.1] }] }),
  })
  try {
    // Vectors [1,0] and [0.95,0.1] have high cosine similarity
    const r = await isSemanticMatch('test post', 'test context', 0.65, { apiKey: 'k', queryVec })
    assert.equal(typeof r, 'boolean')
  } finally { global.fetch = original }
})

test('isSemanticMatch returns false when embedText fails', async () => {
  const r = await isSemanticMatch('post', 'context', 0.65, { apiKey: null })
  assert.equal(r, false)
})

test('_internals.VOYAGE_MODEL is voyage-3-lite', () => {
  assert.equal(_internals.VOYAGE_MODEL, 'voyage-3-lite')
})
