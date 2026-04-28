// Minimal Stripe SDK shape for testing webhook handlers. Tests inject events directly.
import { createHmac } from 'crypto'

export function createMockStripe(opts = {}) {
  return {
    webhooks: {
      constructEvent(rawBody, _signature, _secret) {
        if (opts.failVerification) throw new Error('Invalid signature')
        if (Buffer.isBuffer(rawBody) || typeof rawBody === 'string') {
          return JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'))
        }
        throw new Error('Body must be Buffer or string (Stripe requires raw body)')
      },
    },
    checkout: { sessions: { create: async () => ({ url: 'https://stripe.test/session' }) } },
    billingPortal: { sessions: { create: async () => ({ url: 'https://stripe.test/portal' }) } },
  }
}

// Build a signature header that mock-stripe will accept. Real Stripe SDK does
// HMAC validation; our mock skips that — but tests can still build realistic
// headers by calling this helper.
export function buildSignature(body, secret) {
  const ts = Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
  return `t=${ts},v1=${sig}`
}
