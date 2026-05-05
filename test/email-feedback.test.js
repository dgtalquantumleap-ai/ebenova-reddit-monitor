import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'
import { makeEmailFeedbackHandler, buildThanksPage, _internals } from '../lib/email-feedback.js'
import { getKeywordHealth } from '../lib/keyword-health.js'

const { MATCH_TTL, FEEDBACK_TTL } = _internals

function makeCtx(overrides = {}) {
  const redis = overrides.redis || createMockRedis()
  const handler = makeEmailFeedbackHandler({ redis, appUrl: 'https://app.example.com', ...overrides })
  return { redis, handler }
}

async function call(handler, query = {}) {
  let status = 200
  let body = ''
  const res = {
    status(s) { status = s; return this },
    send(b) { body = b; return this },
  }
  await handler({ query }, res)
  return { status, body }
}

test('records emailFeedback=yes on the match and writes feedback key', async () => {
  const { redis, handler } = makeCtx()
  await redis.set('insights:match:m1:post_abc', JSON.stringify({ id: 'post_abc', title: 'Test' }))
  const { status } = await call(handler, { match_id: 'post_abc', monitor_id: 'm1', v: 'yes' })
  assert.equal(status, 200)
  const stored = JSON.parse(await redis.get('insights:match:m1:post_abc'))
  assert.equal(stored.emailFeedback, 'yes')
  assert.ok(stored.emailFeedbackAt)
  const fb = JSON.parse(await redis.get('insights:email-feedback:m1:post_abc'))
  assert.equal(fb.v, 'yes')
})

test('records emailFeedback=no', async () => {
  const { redis, handler } = makeCtx()
  await redis.set('insights:match:m1:post_xyz', JSON.stringify({ id: 'post_xyz' }))
  await call(handler, { match_id: 'post_xyz', monitor_id: 'm1', v: 'no' })
  const stored = JSON.parse(await redis.get('insights:match:m1:post_xyz'))
  assert.equal(stored.emailFeedback, 'no')
})

test('still writes feedback key when match no longer exists', async () => {
  const { redis, handler } = makeCtx()
  const { status } = await call(handler, { match_id: 'gone', monitor_id: 'm1', v: 'yes' })
  assert.equal(status, 200)
  const fb = JSON.parse(await redis.get('insights:email-feedback:m1:gone'))
  assert.equal(fb.v, 'yes')
})

test('returns 400 for invalid v value', async () => {
  const { handler } = makeCtx()
  const { status } = await call(handler, { match_id: 'x', monitor_id: 'm1', v: 'maybe' })
  assert.equal(status, 400)
})

test('returns 400 when match_id is missing', async () => {
  const { handler } = makeCtx()
  const { status } = await call(handler, { monitor_id: 'm1', v: 'yes' })
  assert.equal(status, 400)
})

test('returns 400 when monitor_id is missing', async () => {
  const { handler } = makeCtx()
  const { status } = await call(handler, { match_id: 'x', v: 'yes' })
  assert.equal(status, 400)
})

test('returns HTML with the dashboard link on success', async () => {
  const { redis, handler } = makeCtx()
  await redis.set('insights:match:m1:p1', JSON.stringify({ id: 'p1' }))
  const { body } = await call(handler, { match_id: 'p1', monitor_id: 'm1', v: 'yes' })
  assert.ok(body.includes('Thanks for the feedback'))
  assert.ok(body.includes('https://app.example.com'))
  assert.ok(body.includes('👍'))
})

test('returns 👎 emoji page for v=no', async () => {
  const { redis, handler } = makeCtx()
  await redis.set('insights:match:m1:p2', JSON.stringify({ id: 'p2' }))
  const { body } = await call(handler, { match_id: 'p2', monitor_id: 'm1', v: 'no' })
  assert.ok(body.includes('👎'))
})

test('buildThanksPage escapes appUrl for HTML safety', () => {
  const page = buildThanksPage('yes', 'https://app.example.com/"><script>alert(1)</script>')
  assert.ok(!page.includes('<script>alert(1)</script>'))
})

test('updates keyword health feedbackYes when match has a keyword', async () => {
  const { redis, handler } = makeCtx()
  await redis.set('insights:match:m1:p10', JSON.stringify({ id: 'p10', keyword: 'saas tool' }))
  await call(handler, { match_id: 'p10', monitor_id: 'm1', v: 'yes' })
  const health = await getKeywordHealth(redis, 'm1')
  assert.equal(health['saas tool'].feedbackYes, 1)
})

test('updates keyword health feedbackNo when match has a keyword', async () => {
  const { redis, handler } = makeCtx()
  await redis.set('insights:match:m1:p11', JSON.stringify({ id: 'p11', keyword: 'saas tool' }))
  await call(handler, { match_id: 'p11', monitor_id: 'm1', v: 'no' })
  const health = await getKeywordHealth(redis, 'm1')
  assert.equal(health['saas tool'].feedbackNo, 1)
})

test('skips keyword health update when match has no keyword field', async () => {
  const { redis, handler } = makeCtx()
  await redis.set('insights:match:m1:p12', JSON.stringify({ id: 'p12' }))
  await call(handler, { match_id: 'p12', monitor_id: 'm1', v: 'yes' })
  const health = await getKeywordHealth(redis, 'm1')
  assert.deepEqual(health, {})
})

test('soft-fails on Redis error and still returns HTML', async () => {
  const brokenRedis = {
    get: async () => { throw new Error('connection refused') },
    set: async () => { throw new Error('connection refused') },
    expire: async () => {},
  }
  const handler = makeEmailFeedbackHandler({ redis: brokenRedis, appUrl: 'https://app.example.com' })
  const { status, body } = await call(handler, { match_id: 'x', monitor_id: 'm1', v: 'yes' })
  assert.equal(status, 200)
  assert.ok(body.includes('Thanks for the feedback'))
})
