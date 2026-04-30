// routes/stripe.js — Stripe billing endpoints
// Mounted at /v1/billing in api-server.js (for /checkout and /portal).
// The webhook handler is exported separately (`webhookHandler`) and mounted
// in api-server.js BEFORE express.json() so the raw body reaches it (F1).

import express from 'express'
import Stripe from 'stripe'
import { Redis } from '@upstash/redis'

const router = express.Router()

// ── Plan config — set price IDs in Railway environment variables ─────────────
const STRIPE_PLANS = {
  growth: {
    priceId: process.env.STRIPE_GROWTH_PRICE_ID,
    name: 'Growth',
    monitors: 20,
    keywords: 100,
  },
  scale: {
    priceId: process.env.STRIPE_SCALE_PRICE_ID,
    name: 'Scale',
    monitors: 100,
    keywords: 500,
  },
}

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY not set')
  return new Stripe(key, { apiVersion: '2023-10-16' })
}

function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('Redis not configured')
  return new Redis({ url, token })
}

// Auth helper — validates Bearer token against Redis key store
async function authenticate(req) {
  const auth = req.headers['authorization'] || ''
  const key  = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!key) return { ok: false, status: 401, error: 'Authorization header required' }
  try {
    const redis = getRedis()
    const raw = await redis.get(`apikey:${key}`)
    if (!raw) return { ok: false, status: 401, error: 'API key not found' }
    const keyData = typeof raw === 'string' ? JSON.parse(raw) : raw
    return { ok: true, apiKey: key, keyData, owner: keyData.owner }
  } catch (err) {
    console.error('[stripe auth]:', err.message)
    return { ok: false, status: 500, error: 'Internal server error' }
  }
}

// ── POST /v1/billing/checkout ─────────────────────────────────────────────────
router.post('/checkout', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })

  const { plan, successUrl, cancelUrl } = req.body
  const planConfig = STRIPE_PLANS[plan]
  if (!planConfig) return res.status(400).json({ success: false, error: `Unknown plan: ${plan}. Valid: growth, scale` })
  if (!planConfig.priceId) return res.status(503).json({ success: false, error: `STRIPE_${plan.toUpperCase()}_PRICE_ID not configured` })

  try {
    const stripe = getStripe()
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: planConfig.priceId, quantity: 1 }],
      success_url: successUrl || `${req.headers.origin || 'https://ebenova.dev'}/dashboard?upgrade=success`,
      cancel_url:  cancelUrl  || `${req.headers.origin || 'https://ebenova.dev'}/dashboard?upgrade=cancelled`,
      metadata: { apiKey: auth.apiKey, owner: auth.owner, plan, ownerEmail: auth.keyData.email || auth.owner },
      customer_email: auth.keyData.email || undefined,
    })
    res.json({ success: true, checkoutUrl: session.url })
  } catch (err) {
    console.error('[stripe checkout]:', err.message)
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// ── POST /v1/billing/portal ───────────────────────────────────────────────────
router.post('/portal', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })

  const customerId = auth.keyData.stripeCustomerId
  if (!customerId) return res.status(404).json({ success: false, error: 'No Stripe customer found for this key. Please complete a checkout first.' })

  try {
    const stripe = getStripe()
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: req.body?.returnUrl || `${req.headers.origin || 'https://ebenova.dev'}/dashboard`,
    })
    res.json({ success: true, portalUrl: session.url })
  } catch (err) {
    console.error('[stripe portal]:', err.message)
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// ── Webhook handler (exported separately — mounted before express.json()) ─────
//
// F1: Stripe SDK requires the raw request body (Buffer) for signature
//     verification. api-server.js mounts this with express.raw() BEFORE
//     express.json() to ensure the body isn't pre-parsed.
//
// F2: Only signature errors return 400. All other handler errors return 500
//     so Stripe retries. Previously, all errors were swallowed → silent drops.
//
// F3: Events deduped by event.id with a 30-day TTL. Stripe retries within
//     ~3 days; 30d is generous defense in depth.
//
// F4: customer.subscription.deleted and invoice.payment_failed properly
//     downgrade the customer's plan via the stripe:customer:* reverse index.
export async function webhookHandler(req, res) {
  const sig    = req.headers['stripe-signature']
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    console.error('[stripe] STRIPE_WEBHOOK_SECRET not set')
    return res.status(500).send('Webhook secret not configured')
  }

  // Stage 1: signature verification — failure is legitimately 400
  let event
  try {
    const stripe = getStripe()
    event = stripe.webhooks.constructEvent(req.body, sig, secret)
  } catch (err) {
    console.error('[stripe] Webhook signature verification failed:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  console.log(`[stripe] Event: ${event.type} (${event.id})`)

  // Stage 2: handler errors must NOT be swallowed — Stripe needs 5xx to retry
  try {
    await handleEvent(event)
    return res.json({ received: true })
  } catch (err) {
    console.error('[stripe] Webhook handler error:', err.message, err.stack)
    return res.status(500).json({ error: 'Handler failed; will retry' })
  }
}

async function handleEvent(event) {
  const redis = getRedis()

  // F3: idempotency — short-circuit if we've already processed this event id.
  // Uses SET NX with 30d TTL. Stripe retries within 3 days; 30d is generous.
  const dedupKey = `processed:stripe:event:${event.id}`
  const isFirst = await redis.set(dedupKey, '1', { nx: true, ex: 60 * 60 * 24 * 30 })
  if (!isFirst) {
    console.log(`[stripe] Duplicate event ${event.id}, skipping`)
    return
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const { apiKey, plan, ownerEmail } = session.metadata || {}
    const customerId  = session.customer
    const customerEmail = session.customer_details?.email || ownerEmail || ''

    if (apiKey) {
      // Existing user — upgrade plan AND write F4 reverse index
      const raw = await redis.get(`apikey:${apiKey}`)
      if (raw) {
        const keyData = typeof raw === 'string' ? JSON.parse(raw) : raw
        const updated = {
          ...keyData,
          insightsPlan: plan,
          stripeCustomerId: customerId,
          upgradedAt: new Date().toISOString(),
        }
        await redis.set(`apikey:${apiKey}`, JSON.stringify(updated))
    await redis.expire(`apikey:${apiKey}`, 365 * 24 * 60 * 60).catch(() => {})
        await redis.set(`stripe:customer:${customerId}`, apiKey)
        // Reset failure counter on successful payment
        await redis.del(`apikey:${apiKey}:payment_failures`).catch(() => {})
        console.log(`[stripe] Upgraded ${apiKey.slice(0, 12)}… to ${plan} (customer ${customerId})`)
      }
    } else if (customerEmail) {
      // New customer (no existing API key) — provision one
      const { randomBytes } = await import('crypto')
      const newKey = `ins_${randomBytes(16).toString('hex')}`
      const now = new Date().toISOString()
      const keyData = {
        owner: customerEmail,
        email: customerEmail,
        insights: true,
        insightsPlan: plan || 'growth',
        stripeCustomerId: customerId,
        createdAt: now,
        source: 'stripe-checkout',
      }
      await redis.set(`apikey:${newKey}`, JSON.stringify(keyData))
      await redis.expire(`apikey:${newKey}`, 365 * 24 * 60 * 60).catch(() => {})
      await redis.set(`stripe:customer:${customerId}`, newKey)  // F4 reverse index
      await redis.set(`insights:signup:${customerEmail}`, JSON.stringify({ key: newKey, createdAt: now }))
      await redis.expire(`insights:signup:${customerEmail}`, 365 * 24 * 60 * 60).catch(() => {})

      // Send welcome email with new key
      const resendKey = process.env.RESEND_API_KEY
      if (resendKey) {
        const { Resend } = await import('resend')
        const resend = new Resend(resendKey)
        const from = process.env.FROM_EMAIL || 'insights@ebenova.org'
        const appUrl = process.env.APP_URL || 'https://ebenova.org'
        await resend.emails.send({
          from, to: customerEmail,
          subject: `Your Ebenova Insights API key (${(plan||'growth').charAt(0).toUpperCase()+(plan||'growth').slice(1)} plan)`,
          html: `<p>Thanks for upgrading! Here's your API key:</p><p style="font-family:monospace;font-size:16px;font-weight:bold;">${newKey}</p><p><a href="${appUrl}/dashboard">Open dashboard →</a></p>`,
        }).catch(err => console.error('[stripe] Welcome email failed:', err.message))
      }

      console.log(`[stripe] Provisioned new key for ${customerEmail} on ${plan} plan`)
    }
  }

  // F4: handle subscription cancellation — downgrade plan to starter
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object
    const apiKey = await redis.get(`stripe:customer:${sub.customer}`)
    if (!apiKey) {
      console.warn(`[stripe] Cancellation for unknown customer ${sub.customer} (no reverse index — may need backfill)`)
      return
    }
    const raw = await redis.get(`apikey:${apiKey}`)
    if (!raw) return
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw
    data.insightsPlan = 'starter'
    data.cancelledAt = new Date().toISOString()
    await redis.set(`apikey:${apiKey}`, JSON.stringify(data))
    console.log(`[stripe] Downgraded ${apiKey.slice(0, 12)}… to starter (subscription cancelled)`)
  }

  // F4: handle payment failure — auto-downgrade after 2 consecutive failures
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object
    const apiKey = await redis.get(`stripe:customer:${invoice.customer}`)
    if (!apiKey) {
      console.warn(`[stripe] Payment failure for unknown customer ${invoice.customer}`)
      return
    }
    const failures = await redis.incr(`apikey:${apiKey}:payment_failures`)
    await redis.expire(`apikey:${apiKey}:payment_failures`, 60 * 60 * 24 * 30)  // 30-day window
    console.warn(`[stripe] Payment failure ${failures} for ${apiKey.slice(0, 12)}… (customer ${invoice.customer})`)
    if (failures >= 2) {
      const raw = await redis.get(`apikey:${apiKey}`)
      if (raw) {
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw
        data.insightsPlan = 'starter'
        data.downgradedReason = 'payment_failed'
        data.downgradedAt = new Date().toISOString()
        await redis.set(`apikey:${apiKey}`, JSON.stringify(data))
        console.log(`[stripe] Auto-downgraded ${apiKey.slice(0, 12)}… after ${failures} payment failures`)
      }
    }
  }
}

export default router
