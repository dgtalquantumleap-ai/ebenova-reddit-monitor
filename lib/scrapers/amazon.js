// lib/scrapers/amazon.js — Amazon product reviews (HTML scrape).
//
// Signal value: product feedback, competitor complaints, feature requests.
// Reviews are public HTML — no auth, no API key — but Amazon is aggressive
// about rate-limiting, anti-bot pages, and fingerprinting. The scraper
// strategy is conservative:
//
//   1. /s?k={keyword}&sort=review-rank   → top 3 product ASINs
//   2. /product-reviews/{ASIN}?sortBy=recent → recent reviews per product
//
// Polite throttle: 3000ms between requests. UA: a research-bot identity.
// Any fetch / parse error returns [] — never throws — so an aggressive
// block from Amazon doesn't break the rest of the cycle.
//
// IMPORTANT: this scraper is opt-in only (the user must explicitly add
// 'amazon' to monitor.platforms). Do not auto-include in legacy migrations
// or default suggestions — Amazon's terms are stricter than the other
// public-search platforms, so the activation should be deliberate.

import { hashUrlToId } from './_id.js'

const BASE = 'https://www.amazon.com'
const UA   = 'Mozilla/5.0 (compatible; research-bot/1.0)'
const REQUEST_DELAY_MS = 3000
const TIMEOUT_MS = 15_000
const MAX_PRODUCTS = 3
const MAX_REVIEWS_PER_PRODUCT = 8

// One-shot warning so logs don't fill if Amazon serves an anti-bot page.
let _warnedBlocked = false

export default async function searchAmazonReviews(keywordEntry, ctx = {}) {
  const { keyword } = keywordEntry || {}
  const seenIds = ctx.seenIds || { has: () => false, add: () => {} }
  const MAX_AGE_MS = ctx.MAX_AGE_MS || 24 * 60 * 60 * 1000
  const results = []
  if (!keyword || typeof keyword !== 'string') return results

  // ── Stage 1: search for product ASINs ────────────────────────────────────
  const searchUrl = `${BASE}/s?${new URLSearchParams({ k: keyword, sort: 'review-rank' }).toString()}`
  let searchHtml
  try {
    const res = await fetch(searchUrl, {
      headers: amazonHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`[amazon] search ${res.status} for "${keyword}"`)
      return results
    }
    searchHtml = await res.text()
  } catch (err) {
    console.warn(`[amazon] search fetch error for "${keyword}":`, err.message)
    return results
  }

  // Anti-bot interstitial — Amazon serves a CAPTCHA page with this title
  // when a request looks robotic. Detect and bail without further requests.
  if (/Sorry, we just need to make sure you're not a robot/i.test(searchHtml)) {
    if (!_warnedBlocked) {
      console.warn('[amazon] hit anti-bot interstitial — skipping until next cycle')
      _warnedBlocked = true
    }
    return results
  }

  // Extract the first MAX_PRODUCTS unique ASINs from the search results.
  // Amazon's search markup uses data-asin="B0XXXXXXXX" on each result tile.
  const asins = []
  const asinSeen = new Set()
  const asinPattern = /data-asin="([A-Z0-9]{10})"/g
  let m
  while ((m = asinPattern.exec(searchHtml)) !== null && asins.length < MAX_PRODUCTS) {
    const asin = m[1]
    if (asinSeen.has(asin)) continue
    asinSeen.add(asin)
    asins.push(asin)
  }
  if (asins.length === 0) return results

  // ── Stage 2: fetch reviews for each product ──────────────────────────────
  const cutoffMs = Date.now() - MAX_AGE_MS
  for (let i = 0; i < asins.length; i++) {
    if (i > 0 && typeof ctx.delay === 'function') await ctx.delay(REQUEST_DELAY_MS)
    const asin = asins[i]
    const reviewsUrl = `${BASE}/product-reviews/${asin}?${new URLSearchParams({
      sortBy: 'recent',
      reviewerType: 'all_reviews',
      pageNumber: '1',
    }).toString()}`

    let reviewsHtml
    try {
      const res = await fetch(reviewsUrl, {
        headers: amazonHeaders(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) { console.warn(`[amazon] reviews ${res.status} for ${asin}`); continue }
      reviewsHtml = await res.text()
    } catch (err) {
      console.warn(`[amazon] reviews fetch error for ${asin}: ${err.message}`)
      continue
    }

    // Product name — strip from the page <title>. Best-effort fallback to ASIN.
    const titleMatch = reviewsHtml.match(/<title[^>]*>([^<]*)<\/title>/i)
    const productName = (titleMatch?.[1] || '').replace(/Amazon\.com[^:]*:?\s*/i, '').replace(/Customer reviews:\s*/i, '').trim().slice(0, 120) || asin
    const productSlug = productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || asin.toLowerCase()

    // Each review block lives in <div data-hook="review" id="customer_review-{reviewId}">.
    const reviewBlockPattern = /<div[^>]*data-hook="review"[^>]*id="customer_review-([^"]+)"[\s\S]*?(?=<div[^>]*data-hook="review"|<div[^>]*id="cm_cr-pagination)/g
    let blockMatch
    let count = 0
    while ((blockMatch = reviewBlockPattern.exec(reviewsHtml)) !== null && count < MAX_REVIEWS_PER_PRODUCT) {
      const reviewId = blockMatch[1]
      const block    = blockMatch[0]

      const reviewerName  = matchInner(block, /<span class="a-profile-name">([^<]+)<\/span>/i) || 'amazon-reviewer'
      const reviewTitle   = matchInner(block, /data-hook="review-title"[\s\S]*?<span[^>]*>([^<]+)<\/span>/i) ||
                            matchInner(block, /data-hook="review-title"[\s\S]*?>([^<]+)<\/a>/i) || ''
      const reviewBody    = matchInner(block, /data-hook="review-body"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i) || ''
      const ratingText    = matchInner(block, /class="a-icon-alt">([^<]+)<\/span>/i) || ''
      const ratingNum     = (() => {
        const r = ratingText.match(/(\d(?:\.\d)?)/)
        return r ? Math.round(parseFloat(r[1])) : 0
      })()
      const dateText      = matchInner(block, /data-hook="review-date">([^<]+)</i) || ''
      const reviewDate    = parseAmazonDate(dateText)

      // Drop reviews older than the cycle's age cap. Reviews without a parseable
      // date pass through (postAgeHours=0) — better than dropping good signal.
      if (reviewDate && reviewDate.getTime() < cutoffMs) continue

      const url = `${BASE}/gp/customer-reviews/${reviewId}`
      const id  = hashUrlToId(url, 'amazon')
      if (seenIds.has(id)) continue
      seenIds.add(id)

      const cleanedBody = reviewBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400)
      const postAgeHours = reviewDate
        ? Math.max(0, Math.floor((Date.now() - reviewDate.getTime()) / (60 * 60 * 1000)))
        : 0

      results.push({
        id,
        title:     (reviewTitle || '').trim().slice(0, 240) || `Review of ${productName.slice(0, 80)}`,
        url,
        subreddit: `amazon:${productSlug}`,
        author:    reviewerName.trim().slice(0, 60),
        score:     ratingNum,                     // 1-5 stars
        comments:  0,
        body:      cleanedBody,
        createdAt: (reviewDate || new Date()).toISOString(),
        keyword,
        source:    'amazon',
        approved:  true,
        postAgeHours,
      })
      count++
    }
  }
  return results
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function amazonHeaders() {
  return {
    'User-Agent':      UA,
    'Accept':          'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  }
}

function matchInner(haystack, re) {
  const m = haystack.match(re)
  return m ? m[1].trim() : null
}

// Amazon prints "Reviewed in the United States on March 12, 2026" — pull the
// trailing date phrase. Returns a Date or null. Never throws.
function parseAmazonDate(text) {
  if (!text) return null
  const m = text.match(/(?:on\s+)?([A-Z][a-z]+ \d{1,2},\s*\d{4})/)
  if (!m) return null
  const d = new Date(m[1])
  return Number.isFinite(d.getTime()) ? d : null
}

// Test-only export so tests can reset the warning flag.
export const _internals = {
  BASE, UA, REQUEST_DELAY_MS, TIMEOUT_MS,
  MAX_PRODUCTS, MAX_REVIEWS_PER_PRODUCT,
  parseAmazonDate,
  resetBlockedWarning: () => { _warnedBlocked = false },
}
