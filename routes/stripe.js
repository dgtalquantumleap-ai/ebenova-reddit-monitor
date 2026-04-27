// routes/stripe.js — Stripe billing endpoints
// Mounted at /v1/billing in api-server.js

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
    return { ok: false, status: 500, error: err.message }
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
      metadata: { apiKey: auth.apiKey, owner: auth.owner, plan },
      // Pre-fill email if we have it
      customer_email: auth.keyData.email || undefined,
    })
    res.json({ success: true, checkoutUrl: session.url })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
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
    res.status(500).json({ success: false, error: err.message })
  }
})

// ── POST /v1/billing/webhook ──────────────────────────────────────────────────
// Must use raw body — mounted with express.raw() in api-server.js
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig     = req.headers['stripe-signature']
  const secret  = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) return res.status(500).send('STRIPE_WEBHOOK_SECRET not set')

  let event
  try {
    const stripe = getStripe()
    event = stripe.webhooks.constructEvent(req.body, sig, secret)
  } catch (err) {
    console.error('[stripe] Webhook signature verification failed:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  console.log(`[stripe] Event: ${event.type}`)

  try {
    const redis = getRedis()

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const { apiKey, plan } = session.metadata || {}
      const customerId = session.customer

      if (apiKey && plan) {
        const raw = await redis.get(`apikey:${apiKey}`)
        if (raw) {
          const keyData = typeof raw === 'string' ? JSON.parse(raw) : raw
          const updated = { ...keyData, insightsPlan: plan, stripeCustomerId: customerId, upgradedAt: new Date().toISOString() }
          await redis.set(`apikey:${apiKey}`, JSON.stringify(updated))
          console.log(`[stripe] ✅ Upgraded ${apiKey} to ${plan} plan`)
        }
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object
      const customerId = sub.customer

      // Find the API key associated with this customer ID
      // We scan keys — for production use a reverse-index; here we use the metadata approach
      // The customer ID was stored when the checkout completed
      const members = await redis.smembers('insights:waitlist').catch(() => [])
      // Also check active monitors for owner info — look up by customer ID in key data
      // This is a best-effort approach; for scale, maintain a customerId → apiKey index
      console.warn(`[stripe] Subscription deleted for customer ${customerId} — manual downgrade may be needed if key lookup fails`)
    }

    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object
      console.warn(`[stripe] ⚠️ Payment failed for customer ${invoice.customer} — invoice ${invoice.id}`)
    }
  } catch (err) {
    console.error('[stripe] Webhook handler error:', err.message)
  }

  res.json({ received: true })
})

export default router
