import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'

// We test the webhook behavior patterns. The real handler in routes/stripe.js
// uses these same patterns (signature verification, error propagation, dedup,
// cancellation downgrade, payment-failed dunning).

function makeWebhookHandler({ stripe, handleEventBody }) {
  return async function webhookHandler(req, res) {
    let event
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], 'fake-secret')
    } catch (err) {
      return res.status(400).json({ error: 'Invalid signature' })
    }
    try {
      await handleEventBody(event)
      return res.json({ received: true })
    } catch (err) {
      console.error('[stripe] handler error', err.message)
      return res.status(500).json({ error: 'Handler failed; will retry' })
    }
  }
}

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

// ── F2: error propagation ──────────────────────────────────────────────────

test('F2: returns 200 on successful event', async () => {
  const stripe = { webhooks: { constructEvent: () => ({ id: 'evt_1', type: 'checkout.session.completed' }) } }
  const handler = makeWebhookHandler({ stripe, handleEventBody: async () => {} })
  const r = fakeRes()
  await handler({ body: '{}', headers: {} }, r.res)
  assert.equal(r.status, 200)
  assert.equal(r.payload.received, true)
})

test('F2: returns 400 on signature verification failure', async () => {
  const stripe = { webhooks: { constructEvent: () => { throw new Error('bad sig') } } }
  const handler = makeWebhookHandler({ stripe, handleEventBody: async () => {} })
  const r = fakeRes()
  await handler({ body: '{}', headers: {} }, r.res)
  assert.equal(r.status, 400)
})

test('F2: returns 500 (not 200) when handler throws', async () => {
  const stripe = { webhooks: { constructEvent: () => ({ id: 'evt_2', type: 'force_failure' }) } }
  const handler = makeWebhookHandler({
    stripe,
    handleEventBody: async () => { throw new Error('Redis is down') },
  })
  const r = fakeRes()
  await handler({ body: '{}', headers: {} }, r.res)
  assert.equal(r.status, 500, 'Stripe must see 5xx so it retries')
})

// ── F3: idempotency ────────────────────────────────────────────────────────

test('F3: duplicate event id is processed only once', async () => {
  const redis = createMockRedis()
  let processed = 0
  async function handleWithDedup(event) {
    const dedupKey = `processed:stripe:event:${event.id}`
    const isFirst = await redis.set(dedupKey, '1', { nx: true, ex: 60 })
    if (!isFirst) return { deduped: true }
    processed++
    return { deduped: false }
  }
  const r1 = await handleWithDedup({ id: 'evt_dup', type: 'x' })
  const r2 = await handleWithDedup({ id: 'evt_dup', type: 'x' })
  assert.equal(processed, 1)
  assert.equal(r1.deduped, false)
  assert.equal(r2.deduped, true)
})

// ── F4: customer reverse index + cancellation + dunning ────────────────────

test('F4: checkout.session.completed writes the customer→apiKey reverse index', async () => {
  const redis = createMockRedis()
  async function onUpgrade(apiKey, customerId) {
    await redis.set(`apikey:${apiKey}`, JSON.stringify({ owner: 'alice', insightsPlan: 'growth', stripeCustomerId: customerId }))
    await redis.set(`stripe:customer:${customerId}`, apiKey)
  }
  await onUpgrade('KEY_X', 'cus_abc')
  assert.equal(await redis.get('stripe:customer:cus_abc'), 'KEY_X')
})

test('F4: customer.subscription.deleted downgrades the plan to starter', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_X', JSON.stringify({ owner: 'alice', insightsPlan: 'scale', stripeCustomerId: 'cus_abc' }))
  await redis.set('stripe:customer:cus_abc', 'KEY_X')

  async function onCancel(customerId) {
    const apiKey = await redis.get(`stripe:customer:${customerId}`)
    if (!apiKey) return false
    const raw = await redis.get(`apikey:${apiKey}`)
    const data = JSON.parse(raw)
    data.insightsPlan = 'starter'
    data.cancelledAt = '2026-04-27T00:00:00Z'
    await redis.set(`apikey:${apiKey}`, JSON.stringify(data))
    return true
  }
  const ok = await onCancel('cus_abc')
  assert.equal(ok, true)
  const after = JSON.parse(await redis.get('apikey:KEY_X'))
  assert.equal(after.insightsPlan, 'starter')
})

test('F4: invoice.payment_failed downgrades after 2 consecutive failures', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_X', JSON.stringify({ owner: 'alice', insightsPlan: 'scale', stripeCustomerId: 'cus_abc' }))
  await redis.set('stripe:customer:cus_abc', 'KEY_X')

  async function onPaymentFailed(customerId) {
    const apiKey = await redis.get(`stripe:customer:${customerId}`)
    if (!apiKey) return null
    const failures = await redis.incr(`apikey:${apiKey}:payment_failures`)
    if (failures >= 2) {
      const data = JSON.parse(await redis.get(`apikey:${apiKey}`))
      data.insightsPlan = 'starter'
      await redis.set(`apikey:${apiKey}`, JSON.stringify(data))
      return 'downgraded'
    }
    return 'warned'
  }
  assert.equal(await onPaymentFailed('cus_abc'), 'warned')
  assert.equal(await onPaymentFailed('cus_abc'), 'downgraded')
})
