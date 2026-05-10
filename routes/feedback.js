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

      // Archive to Redis (best-effort) — initial write without slackDelivery,
      // so even if Slack hangs we still have the submission preserved.
      const archiveKey = `feedback:${auth.apiKey}:${Date.now()}`
      try {
        await redis.set(archiveKey, JSON.stringify(submission))
        if (typeof redis.expire === 'function') {
          await redis.expire(archiveKey, FEEDBACK_TTL_SECONDS)
        }
      } catch (err) {
        console.warn('[feedback] redis archive failed:', err.message)
      }

      // Slack delivery (best-effort, non-blocking from user perspective).
      // Result is captured into a structured record so the feedback archive
      // can answer "did this reach Slack?" without needing Railway log access.
      // Reasons: 'no_webhook' (env unset), 'slack_error' (4xx/5xx from Slack
      // — captures HTTP status), 'network_error' (fetch threw — captures
      // err.message), 'exception' (anything the slack fn throws upstream).
      let slackDelivery
      try {
        const result = await slack(submission)
        slackDelivery = {
          delivered:   !!result?.delivered,
          reason:      result?.reason   || (result?.delivered ? null : 'unknown'),
          status:      result?.status   || null,
          error:       result?.error    || null,
          attemptedAt: new Date().toISOString(),
        }
        if (!result?.delivered) {
          console.warn(`[feedback] Slack delivery failed: ${result?.reason || 'unknown'}`)
        }
      } catch (err) {
        console.warn('[feedback] slack threw:', err.message)
        slackDelivery = {
          delivered:   false,
          reason:      'exception',
          status:      null,
          error:       err.message,
          attemptedAt: new Date().toISOString(),
        }
      }

      // Second Redis write — annotate the record with the slack outcome.
      // Best-effort: if this fails the record from the first write still
      // exists, just without slackDelivery (same as old behavior).
      try {
        await redis.set(archiveKey, JSON.stringify({ ...submission, slackDelivery }))
      } catch (err) {
        console.warn('[feedback] redis annotate failed:', err.message)
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
