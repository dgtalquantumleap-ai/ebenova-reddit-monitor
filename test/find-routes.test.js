import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'
import { makeFindHandler } from '../routes/find.js'

function fakeRes() {
  let status = 200, payload
  return {
    res: {
      status(s) { status = s; return this },
      json(p) { payload = p; return this },
    },
    get status() { return status },
    get payload() { return payload },
  }
}

async function postJSON(handler, body, authKey = 'KEY_A', ip = '1.1.1.1') {
  const r = fakeRes()
  const req = {
    headers: { authorization: `Bearer ${authKey}`, 'x-forwarded-for': ip },
    body,
    socket: { remoteAddress: ip },
  }
  await handler(req, r.res)
  return { status: r.status, payload: r.payload }
}

test('rejects unauthenticated suggest', async () => {
  const redis = createMockRedis()
  const h = makeFindHandler({ redis, suggestFn: async () => ({}), countsFn: async () => ({}) })
  const r = await postJSON(h.suggest, { description: 'I run a SaaS for accountants' }, 'UNKNOWN')
  assert.equal(r.status, 401)
})

test('rejects too-short description', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a', insights: true }))
  const h = makeFindHandler({ redis, suggestFn: async () => ({}), countsFn: async () => ({}) })
  const r = await postJSON(h.suggest, { description: 'too short' })
  assert.equal(r.status, 400)
})

test('suggest returns shape with keywords', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a', insights: true }))
  const VALID = {
    suggestedName: 'Test', productContext: 'cleaned',
    keywords: [{ keyword: 'x', intentType: 'buying', confidence: 'high' }],
    subreddits: ['SaaS'], platforms: ['reddit'],
  }
  const h = makeFindHandler({
    redis, suggestFn: async () => VALID, countsFn: async () => ({})
  })
  const r = await postJSON(h.suggest, { description: 'I sell SaaS for accountants' })
  assert.equal(r.status, 200)
  assert.equal(r.payload.suggestedName, 'Test')
})

test('preview-counts requires keywords array', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a', insights: true }))
  const h = makeFindHandler({ redis, suggestFn: async () => ({}), countsFn: async () => ({}) })
  const r = await postJSON(h.previewCounts, { keywords: [] })
  assert.equal(r.status, 400)
})

test('preview-counts returns counts on valid input', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a', insights: true }))
  const h = makeFindHandler({
    redis,
    suggestFn: async () => ({}),
    countsFn: async (kws) => Object.fromEntries(kws.map(k => [k, { count: 5, samples: [] }])),
  })
  const r = await postJSON(h.previewCounts, { keywords: ['scope creep', 'unpaid invoice'] })
  assert.equal(r.status, 200)
  assert.equal(r.payload.counts['scope creep'].count, 5)
})

test('preview-counts rate-limits after configured max per IP per hour', async () => {
  // Use a low max for the test by setting env var before importing
  process.env.FIND_PREVIEW_HOURLY_MAX = '3'
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a', insights: true }))
  const h = makeFindHandler({
    redis,
    suggestFn: async () => ({}),
    countsFn: async () => ({}),
  })
  for (let i = 0; i < 3; i++) {
    await postJSON(h.previewCounts, { keywords: ['x'] })
  }
  const r4 = await postJSON(h.previewCounts, { keywords: ['x'] })
  assert.equal(r4.status, 429)
  delete process.env.FIND_PREVIEW_HOURLY_MAX
})
