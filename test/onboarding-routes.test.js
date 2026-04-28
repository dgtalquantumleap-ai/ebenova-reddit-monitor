import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'
import { makeOnboardingHandler } from '../routes/onboarding.js'

function fakeRes() {
  let status = 200, payload
  return {
    res: {
      status(s) { status = s; return this },
      json(p) { payload = p; return this },
      setHeader() { return this },
    },
    get status() { return status },
    get payload() { return payload },
  }
}

async function postJSON(handler, body, authKey = 'KEY_ALICE', ip = '1.1.1.1') {
  const r = fakeRes()
  const req = {
    headers: { authorization: `Bearer ${authKey}`, 'x-forwarded-for': ip },
    body,
    socket: { remoteAddress: ip },
  }
  await handler(req, r.res)
  return { status: r.status, payload: r.payload }
}

test('rejects unauthenticated requests', async () => {
  const redis = createMockRedis()
  const h = makeOnboardingHandler({
    redis,
    suggestFn: async () => ({}),
    sampleMatchesFn: async () => [],
  })
  const r = await postJSON(h.suggest, { description: 'I run a SaaS for accountants' }, 'UNKNOWN')
  assert.equal(r.status, 401)
})

test('rejects description below 20 chars', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_ALICE', JSON.stringify({ owner: 'alice', insights: true }))
  const h = makeOnboardingHandler({
    redis,
    suggestFn: async () => ({}),
    sampleMatchesFn: async () => [],
  })
  const r = await postJSON(h.suggest, { description: 'too short' })
  assert.equal(r.status, 400)
})

test('returns suggestion on valid input', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_ALICE', JSON.stringify({ owner: 'alice', insights: true }))
  const VALID = {
    suggestedName: 'Test',
    productContext: 'cleaned input goes here',
    keywords: [{ keyword: 'x', intentType: 'buying', confidence: 'high' }],
    subreddits: ['SaaS'],
    platforms: ['reddit'],
  }
  const h = makeOnboardingHandler({
    redis,
    suggestFn: async () => VALID,
    sampleMatchesFn: async () => [],
  })
  const r = await postJSON(h.suggest, { description: 'I sell SaaS for accountants in the US.' })
  assert.equal(r.status, 200)
  assert.equal(r.payload.suggestedName, 'Test')
})

test('rate-limits after 5 suggest calls per IP', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_ALICE', JSON.stringify({ owner: 'alice', insights: true }))
  const h = makeOnboardingHandler({
    redis,
    suggestFn: async () => ({
      suggestedName: 'T', productContext: 'cleaned cleaned context',
      keywords: [{ keyword: 'x', intentType: 'buying', confidence: 'high' }],
      subreddits: ['SaaS'], platforms: ['reddit'],
    }),
    sampleMatchesFn: async () => [],
  })
  for (let i = 0; i < 5; i++) {
    await postJSON(h.suggest, { description: 'I sell SaaS for accountants in the US.' })
  }
  const r6 = await postJSON(h.suggest, { description: 'I sell SaaS for accountants in the US.' })
  assert.equal(r6.status, 429)
})

test('sample-matches requires keywords array', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_ALICE', JSON.stringify({ owner: 'alice', insights: true }))
  const h = makeOnboardingHandler({ redis, suggestFn: async () => ({}), sampleMatchesFn: async () => [] })
  const r = await postJSON(h.sampleMatches, { keywords: [] }, 'KEY_ALICE', '2.2.2.2')
  assert.equal(r.status, 400)
})

test('sample-matches returns matches on valid input', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_ALICE', JSON.stringify({ owner: 'alice', insights: true }))
  const fakeMatches = [{ id: '1', url: 'https://r.com/1', title: 't' }]
  const h = makeOnboardingHandler({
    redis,
    suggestFn: async () => ({}),
    sampleMatchesFn: async () => fakeMatches,
  })
  const r = await postJSON(h.sampleMatches, { keywords: ['x'], subreddits: [], platforms: ['reddit'] }, 'KEY_ALICE', '3.3.3.3')
  assert.equal(r.status, 200)
  assert.equal(r.payload.matches.length, 1)
})
