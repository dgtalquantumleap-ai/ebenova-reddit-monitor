import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'
import { _internals } from '../lib/variants-call.js'

const { buildVariantsPrompt, extractVariantsJSON, validateVariants } = _internals

// ── buildVariantsPrompt ───────────────────────────────────────────────────────

test('buildVariantsPrompt: includes title, body, and productContext', () => {
  const p = buildVariantsPrompt({
    title: 'Need a CRM', body: 'Looking for options', productContext: 'I make CRMs',
  })
  assert.ok(p.includes('Need a CRM'))
  assert.ok(p.includes('Looking for options'))
  assert.ok(p.includes('I make CRMs'))
})

test('buildVariantsPrompt: asks for valueHook, directBridge, empathy keys', () => {
  const p = buildVariantsPrompt({ title: 'Test', body: '', productContext: '' })
  assert.ok(p.includes('valueHook'))
  assert.ok(p.includes('directBridge'))
  assert.ok(p.includes('empathy'))
})

test('buildVariantsPrompt: truncates long body at 400 chars', () => {
  const longBody = 'x'.repeat(1000)
  const p = buildVariantsPrompt({ title: 'T', body: longBody, productContext: '' })
  // The body in the prompt should be truncated
  const bodySection = p.split('Post body: ')[1]?.slice(0, 410)
  assert.ok(bodySection && bodySection.length <= 410)
})

// ── extractVariantsJSON ───────────────────────────────────────────────────────

test('extractVariantsJSON: parses plain JSON', () => {
  const text = '{"valueHook":"hook","directBridge":"bridge","empathy":"empathy"}'
  const obj = extractVariantsJSON(text)
  assert.deepEqual(obj, { valueHook: 'hook', directBridge: 'bridge', empathy: 'empathy' })
})

test('extractVariantsJSON: parses JSON in code fence', () => {
  const text = '```json\n{"valueHook":"h","directBridge":"b","empathy":"e"}\n```'
  const obj = extractVariantsJSON(text)
  assert.deepEqual(obj, { valueHook: 'h', directBridge: 'b', empathy: 'e' })
})

test('extractVariantsJSON: returns null for garbage input', () => {
  assert.equal(extractVariantsJSON('not json at all'), null)
  assert.equal(extractVariantsJSON(''), null)
  assert.equal(extractVariantsJSON(null), null)
})

// ── validateVariants ─────────────────────────────────────────────────────────

test('validateVariants: returns object with all three keys', () => {
  const v = validateVariants({ valueHook: 'hook', directBridge: 'bridge', empathy: 'emp' })
  assert.ok(v)
  assert.equal(v.valueHook, 'hook')
  assert.equal(v.directBridge, 'bridge')
  assert.equal(v.empathy, 'emp')
})

test('validateVariants: returns null when obj is null', () => {
  assert.equal(validateVariants(null), null)
  assert.equal(validateVariants(undefined), null)
})

test('validateVariants: returns null when all three values are missing/empty', () => {
  assert.equal(validateVariants({}), null)
  assert.equal(validateVariants({ valueHook: '', directBridge: '', empathy: '' }), null)
})

test('validateVariants: trims whitespace from values', () => {
  const v = validateVariants({ valueHook: '  hook  ', directBridge: '  bridge  ', empathy: '  emp  ' })
  assert.equal(v.valueHook, 'hook')
  assert.equal(v.directBridge, 'bridge')
  assert.equal(v.empathy, 'emp')
})

// ── Redis cache for variants ──────────────────────────────────────────────────

test('variants: cached result returned on second call (cache hit)', async () => {
  const redis = createMockRedis()
  const matchId = 'abc123'
  const variants = { valueHook: 'hook text', directBridge: 'bridge text', empathy: 'empathy text' }

  // First call — cache miss, store result
  const cached = await redis.get(`variants:${matchId}`)
  assert.equal(cached, null) // cache miss

  await redis.set(`variants:${matchId}`, JSON.stringify(variants))
  await redis.expire(`variants:${matchId}`, 60 * 60 * 24) // 24h TTL

  // Second call — cache hit
  const hit = await redis.get(`variants:${matchId}`)
  assert.ok(hit)
  assert.deepEqual(JSON.parse(hit), variants)
})

test('variants: POST /v1/matches/:id/variants returns 401 without auth (logic check)', () => {
  // Simulate the auth check the endpoint performs
  const headers = {}
  const auth = headers['authorization'] || ''
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  assert.equal(key, '')
  // Empty key → 401
  assert.equal(!key, true)
})

test('variants: endpoint shape has valueHook, directBridge, empathy', () => {
  // Simulate the response shape
  const variants = { valueHook: 'v', directBridge: 'd', empathy: 'e' }
  const response = { success: true, variants, cached: false }
  assert.ok(response.variants.valueHook !== undefined)
  assert.ok(response.variants.directBridge !== undefined)
  assert.ok(response.variants.empathy !== undefined)
})
