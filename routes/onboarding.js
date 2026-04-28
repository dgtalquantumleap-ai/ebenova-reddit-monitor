// /v1/onboarding/suggest + /sample-matches
// Used exclusively by the dashboard's onboarding wizard.
//
// Both endpoints require Bearer auth (the just-issued API key from signup).
// Both rate-limit by IP and by API key to cap LLM cost.

import express from 'express'
import { suggestKeywords } from '../lib/keyword-suggest.js'
import { getSampleMatches } from '../lib/sample-matches.js'
import { makeRateLimiter } from '../lib/rate-limit.js'

// Factory pattern lets tests inject mocked dependencies.
export function makeOnboardingHandler({ redis, suggestFn, sampleMatchesFn }) {
  const ipLimiter = makeRateLimiter(redis, { max: 5, windowSeconds: 3600 })
  const keyLimiter = makeRateLimiter(redis, { max: 3, windowSeconds: 86400 })

  async function authenticate(req) {
    const auth = req.headers['authorization'] || ''
    const apiKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    if (!apiKey) return null
    const raw = await redis.get(`apikey:${apiKey}`)
    if (!raw) return null
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!data.insights) return null
    return { apiKey, owner: data.owner }
  }

  async function checkLimits(req, apiKey) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown'
    const ipR = await ipLimiter(`onboarding:ip:${ip}`)
    if (!ipR.allowed) return { limited: true, retryAfterSeconds: ipR.retryAfterSeconds }
    const keyR = await keyLimiter(`onboarding:key:${apiKey}`)
    if (!keyR.allowed) return { limited: true, retryAfterSeconds: keyR.retryAfterSeconds }
    return { limited: false }
  }

  return {
    async suggest(req, res) {
      const auth = await authenticate(req)
      if (!auth) return res.status(401).json({ success: false, error: { code: 'INVALID_KEY', message: 'API key required' } })

      const { description } = req.body || {}
      if (typeof description !== 'string' || description.trim().length < 20) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Tell us a bit more about what you sell — at least 20 characters.' } })
      }
      if (description.length > 1500) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Description too long — keep it under 1500 characters.' } })
      }

      const limits = await checkLimits(req, auth.apiKey)
      if (limits.limited) {
        return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: `Too many requests. Try again in ${Math.ceil(limits.retryAfterSeconds/60)} minutes.` } })
      }

      try {
        const result = await suggestFn({ description })
        return res.json({ success: true, ...result })
      } catch (err) {
        console.error('[onboarding/suggest] error:', err.message)
        return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not generate suggestions. Please try again.' } })
      }
    },

    async sampleMatches(req, res) {
      const auth = await authenticate(req)
      if (!auth) return res.status(401).json({ success: false, error: { code: 'INVALID_KEY', message: 'API key required' } })

      const { keywords, subreddits, platforms, monitorId } = req.body || {}
      if (!Array.isArray(keywords) || keywords.length === 0) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'keywords array required' } })
      }

      const limits = await checkLimits(req, auth.apiKey)
      if (limits.limited) {
        return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } })
      }

      try {
        const matches = await sampleMatchesFn({
          keywords: keywords.slice(0, 10),
          subreddits: (subreddits || []).slice(0, 10),
          platforms: (platforms || ['reddit']).slice(0, 5),
        })

        // If monitorId provided, persist sample matches as the seed for the
        // Matches feed so the user lands on a populated page.
        if (monitorId && matches.length) {
          for (const m of matches) {
            const key = `insights:match:${monitorId}:${m.id || m.url}`
            await redis.set(key, JSON.stringify({ ...m, monitorId, storedAt: new Date().toISOString() }))
            await redis.expire(key, 60 * 60 * 24 * 7)
          }
        }

        return res.json({ success: true, matches })
      } catch (err) {
        console.error('[onboarding/sample-matches] error:', err.message)
        return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not fetch sample matches' } })
      }
    },
  }
}

// Default Express router for production wiring
export function createRouter({ redis }) {
  const router = express.Router()
  const handlers = makeOnboardingHandler({
    redis,
    suggestFn: suggestKeywords,
    sampleMatchesFn: getSampleMatches,
  })
  router.post('/suggest', handlers.suggest)
  router.post('/sample-matches', handlers.sampleMatches)
  return router
}
