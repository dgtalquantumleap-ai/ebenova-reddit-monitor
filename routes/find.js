// routes/find.js — /v1/find/suggest + /v1/find/preview-counts
//
// Two endpoints powering the Find Customers unified flow:
//   POST /v1/find/suggest         — Anthropic-powered keyword generation from
//                                   a 1-3 sentence product description.
//                                   Falls back to template gallery on error.
//   POST /v1/find/preview-counts  — Live match counts from Reddit + HN per
//                                   keyword (cached 1h via lib/find-cache.js).
//                                   Per-user-per-hour rate limit prevents abuse.

import express from 'express'
import { suggestKeywords } from '../lib/find-suggest.js'
import { makeFindCache } from '../lib/find-cache.js'
import { makeRateLimiter } from '../lib/rate-limit.js'
import { makeCostCap } from '../lib/cost-cap.js'
import { TEMPLATES } from '../lib/templates.js'

// Live preview helper — fetches counts from Reddit + HN only.
// Cached results returned from `lib/find-cache.js`. Two free-and-fast platforms
// is enough signal for the user to verify a keyword's worth — the full 9-platform
// scan happens in the background once the monitor is saved.
async function fetchLiveCounts(keywords, cache) {
  const result = {}
  for (const kw of keywords) {
    const cached = await cache.get(kw)
    if (cached) { result[kw] = cached; continue }
    let count = 0
    const samples = []
    try {
      const redditUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(kw)}&sort=new&limit=20&t=week`
      const r = await fetch(redditUrl, {
        headers: { 'User-Agent': 'EbenovaInsights/2.0 (preview)' },
        signal: AbortSignal.timeout(6000),
      })
      if (r.ok) {
        const data = await r.json()
        const posts = data?.data?.children || []
        count += posts.length
        for (const c of posts.slice(0, 2)) {
          if (c.data) samples.push({
            title: c.data.title,
            url: `https://reddit.com${c.data.permalink}`,
            source: 'reddit',
          })
        }
      }
    } catch { /* ignore — best-effort */ }
    try {
      const hnUrl = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(kw)}&tags=story&hitsPerPage=10`
      const r = await fetch(hnUrl, { signal: AbortSignal.timeout(6000) })
      if (r.ok) {
        const data = await r.json()
        const hits = data?.hits || []
        count += hits.length
        if (samples.length < 2 && hits[0]) {
          samples.push({
            title: hits[0].title,
            url: hits[0].url || `https://news.ycombinator.com/item?id=${hits[0].objectID}`,
            source: 'hackernews',
          })
        }
      }
    } catch { /* ignore */ }
    const value = { count, samples }
    await cache.set(kw, value)
    result[kw] = value
  }
  return result
}

export function makeFindHandler({ redis, suggestFn, countsFn }) {
  const ipLimiter = makeRateLimiter(redis, { max: 5, windowSeconds: 3600 })
  // Per-IP-per-hour cap on preview-counts. Default 10/hr; override via env.
  const previewLimiter = makeRateLimiter(redis, {
    max: parseInt(process.env.FIND_PREVIEW_HOURLY_MAX || '10'),
    windowSeconds: 3600,
  })
  const anthropicCap = makeCostCap(redis, {
    resource: 'anthropic',
    dailyMax: parseInt(process.env.ANTHROPIC_DAILY_MAX || '1000'),
  })

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

  return {
    async suggest(req, res) {
      const auth = await authenticate(req)
      if (!auth) return res.status(401).json({ success: false, error: { code: 'INVALID_KEY', message: 'API key required' } })

      const { description, productUrl } = req.body || {}
      if (typeof description !== 'string' || description.trim().length < 20) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Tell me a bit more about what you sell — at least 20 characters.' } })
      }
      if (description.length > 1500) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Description too long — keep it under 1500 characters.' } })
      }
      // productUrl: optional, must be http(s) if present
      let safeProductUrl = null
      if (productUrl && typeof productUrl === 'string') {
        try {
          const u = new URL(productUrl.trim())
          if (u.protocol === 'http:' || u.protocol === 'https:') safeProductUrl = u.href
        } catch { /* ignore invalid URL */ }
      }

      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown'
      const ipR = await ipLimiter(`find-suggest:ip:${ip}`)
      if (!ipR.allowed) {
        return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: `Too many suggestion requests. Try again in ${Math.ceil(ipR.retryAfterSeconds/60)} minutes.` } })
      }

      // Daily Anthropic cost cap — falls through to template gallery
      const cap = await anthropicCap()
      if (!cap.allowed) {
        console.warn(`[find/suggest] Anthropic daily cap (${cap.used}/${cap.max}) — using template`)
        return res.json({ success: true, ...TEMPLATES.other, fallback: true, fallbackReason: 'daily_cap' })
      }

      try {
        const result = await suggestFn({ description, productUrl: safeProductUrl })
        return res.json({ success: true, ...result })
      } catch (err) {
        console.error('[find/suggest] error:', err.message)
        return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not generate suggestions. Please try again.' } })
      }
    },

    async previewCounts(req, res) {
      const auth = await authenticate(req)
      if (!auth) return res.status(401).json({ success: false, error: { code: 'INVALID_KEY', message: 'API key required' } })

      const { keywords } = req.body || {}
      if (!Array.isArray(keywords) || keywords.length === 0) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'keywords array required' } })
      }

      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown'
      const lim = await previewLimiter(`find-preview:ip:${ip}`)
      if (!lim.allowed) {
        return res.status(429).json({
          success: false,
          error: { code: 'RATE_LIMITED', message: `Preview rate limit hit. Cached counts still display. Try again in ${Math.ceil(lim.retryAfterSeconds/60)} minutes.` },
        })
      }

      try {
        const counts = await countsFn(keywords.slice(0, 25))
        return res.json({ success: true, counts })
      } catch (err) {
        console.error('[find/preview-counts] error:', err.message)
        return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not fetch counts' } })
      }
    },
  }
}

export function createRouter({ redis }) {
  const router = express.Router()
  const cache = makeFindCache(redis)
  const handlers = makeFindHandler({
    redis,
    suggestFn: suggestKeywords,
    countsFn: (kws) => fetchLiveCounts(kws, cache),
  })
  router.post('/suggest', handlers.suggest)
  router.post('/preview-counts', handlers.previewCounts)
  return router
}
