// routes/feedback.js — POST /v1/feedback
//   Auth: Bearer apikey (so submissions are attributed)
//   Body: { npsScore: 0-10, message: 1-2000 chars, category: bug|idea|praise|pricing|other }
//   Side effects: posts to Slack (best-effort), stores 90 days in Redis
//   Rate limit: 5/hour per user via existing makeRateLimiter

import express from 'express'
import { sendFeedbackToSlack } from '../lib/slack-feedback.js'
import { makeRateLimiter } from '../lib/rate-limit.js'

const VALID_CATEGORIES = new Set(['bug', 'idea', 'praise', 'pricing', 'other'])
const FEEDBACK_TTL_SECONDS = 90 * 24 * 60 * 60

export function makeFeedbackHandler({ redis, slackFn }) {
  const slack = slackFn || sendFeedbackToSlack
  const limiter = makeRateLimiter(redis, { max: 5, windowSeconds: 3600 })

  async function authenticate(req) {
    const auth = req.headers['authorization'] || ''
    const apiKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    if (!apiKey) return null
    const raw = await redis.get(`apikey:${apiKey}`)
    if (!raw) return null
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!data.insights) return null
    return { apiKey, data }
  }

  return {
    async submit(req, res) {
      const auth = await authenticate(req)
      if (!auth) return res.status(401).json({ success: false, error: { code: 'INVALID_KEY', message: 'API key required' } })

      const { npsScore, message, category } = req.body || {}
      if (typeof npsScore !== 'number' || !Number.isInteger(npsScore) || npsScore < 0 || npsScore > 10) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'npsScore must be an integer 0-10' } })
      }
      if (typeof message !== 'string') {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'message must be a string' } })
      }
      const trimmed = message.trim()
      if (trimmed.length === 0 || message.length > 2000) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'message must be 1-2000 characters' } })
      }
      if (!VALID_CATEGORIES.has(category)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'category must be one of: bug, idea, praise, pricing, other' } })
      }

      const lim = await limiter(`feedback:${auth.apiKey}`)
      if (!lim.allowed) {
        return res.status(429).json({
          success: false,
          error: { code: 'RATE_LIMITED', message: `Too many submissions. Try again in ${Math.ceil(lim.retryAfterSeconds / 60)} minutes.` },
        })
      }

      const submission = {
        email: auth.data.email || auth.data.owner,
        plan: auth.data.insightsPlan || 'starter',
        npsScore,
        message: trimmed,
        category,
        submittedAt: new Date().toISOString(),
      }

      // Archive to Redis (best-effort)
      try {
        const key = `feedback:${auth.apiKey}:${Date.now()}`
        await redis.set(key, JSON.stringify(submission))
        if (typeof redis.expire === 'function') {
          await redis.expire(key, FEEDBACK_TTL_SECONDS)
        }
      } catch (err) {
        console.warn('[feedback] redis archive failed:', err.message)
      }

      // Slack delivery (best-effort, non-blocking from user perspective)
      try {
        const result = await slack(submission)
        if (!result.delivered) {
          console.warn(`[feedback] Slack delivery failed: ${result.reason}`)
        }
      } catch (err) {
        console.warn('[feedback] slack threw:', err.message)
      }

      return res.json({ success: true })
    },
  }
}

export function createRouter({ redis }) {
  const router = express.Router()
  const handlers = makeFeedbackHandler({ redis })
  router.post('/', handlers.submit)
  return router
}
