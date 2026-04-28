import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'
import { makeFeedbackHandler } from '../routes/feedback.js'

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

test('rejects unauthenticated submit', async () => {
  const redis = createMockRedis()
  const h = makeFeedbackHandler({ redis, slackFn: async () => ({ delivered: true }) })
  const r = await postJSON(h.submit, { npsScore: 9, message: 'good', category: 'praise' }, 'UNKNOWN')
  assert.equal(r.status, 401)
})

test('rejects invalid npsScore', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a', insights: true, insightsPlan: 'starter' }))
  const h = makeFeedbackHandler({ redis, slackFn: async () => ({ delivered: true }) })
  const r1 = await postJSON(h.submit, { npsScore: -1, message: 'x', category: 'bug' })
  assert.equal(r1.status, 400)
  const r2 = await postJSON(h.submit, { npsScore: 11, message: 'x', category: 'bug' })
  assert.equal(r2.status, 400)
  const r3 = await postJSON(h.submit, { npsScore: 'nine', message: 'x', category: 'bug' })
  assert.equal(r3.status, 400)
})

test('rejects message too short or too long', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a', insights: true, insightsPlan: 'starter' }))
  const h = makeFeedbackHandler({ redis, slackFn: async () => ({ delivered: true }) })
  const r1 = await postJSON(h.submit, { npsScore: 5, message: '', category: 'bug' })
  assert.equal(r1.status, 400)
  const r2 = await postJSON(h.submit, { npsScore: 5, message: 'x'.repeat(2001), category: 'bug' })
  assert.equal(r2.status, 400)
})

test('rejects invalid category', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a', insights: true, insightsPlan: 'starter' }))
  const h = makeFeedbackHandler({ redis, slackFn: async () => ({ delivered: true }) })
  const r = await postJSON(h.submit, { npsScore: 5, message: 'hi', category: 'malicious' })
  assert.equal(r.status, 400)
})

test('accepts valid submission and calls slackFn with auth context', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a@x.com', email: 'a@x.com', insights: true, insightsPlan: 'growth' }))
  let slackArg
  const h = makeFeedbackHandler({
    redis,
    slackFn: async (arg) => { slackArg = arg; return { delivered: true } },
  })
  const r = await postJSON(h.submit, { npsScore: 9, message: 'love it', category: 'praise' })
  assert.equal(r.status, 200)
  assert.equal(r.payload.success, true)
  assert.equal(slackArg.email, 'a@x.com')
  assert.equal(slackArg.plan, 'growth')
  assert.equal(slackArg.npsScore, 9)
  assert.equal(slackArg.message, 'love it')
})

test('returns success=true even when Slack delivery fails', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a@x.com', insights: true, insightsPlan: 'starter' }))
  const h = makeFeedbackHandler({
    redis,
    slackFn: async () => ({ delivered: false, reason: 'no_webhook' }),
  })
  const r = await postJSON(h.submit, { npsScore: 5, message: 'hi', category: 'other' })
  assert.equal(r.status, 200)
  assert.equal(r.payload.success, true)
})

test('rate-limits after 5 submissions per hour', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a@x.com', insights: true, insightsPlan: 'starter' }))
  const h = makeFeedbackHandler({ redis, slackFn: async () => ({ delivered: true }) })
  for (let i = 0; i < 5; i++) {
    const r = await postJSON(h.submit, { npsScore: 5, message: `try ${i}`, category: 'idea' })
    assert.equal(r.status, 200)
  }
  const r6 = await postJSON(h.submit, { npsScore: 5, message: 'try 6', category: 'idea' })
  assert.equal(r6.status, 429)
})

test('trims message before validation and storage', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a@x.com', insights: true, insightsPlan: 'starter' }))
  let slackArg
  const h = makeFeedbackHandler({
    redis,
    slackFn: async (arg) => { slackArg = arg; return { delivered: true } },
  })
  const r = await postJSON(h.submit, { npsScore: 8, message: '   hello world   ', category: 'idea' })
  assert.equal(r.status, 200)
  assert.equal(slackArg.message, 'hello world')
})
