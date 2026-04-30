// lib/scrapers/jijing.js — Jiji.ng classifieds search.
//
// Jiji is Nigeria's largest classifieds marketplace. High-signal for the
// real-estate, fashion, electronics, food and beauty verticals — every
// listing is a literal "I am buying" or "I am selling" intent. The other
// scrapers (Reddit, Quora, etc.) catch *discussion* about a category;
// Jiji catches *transactions*.
//
// Returns posts in the same shape as searchReddit() in monitor.js so the
// downstream pipeline (classification, dedup, alerts) doesn't care.

import { hashUrlToId } from './_id.js'

const UA = 'ebenova-brand-monitor/1.0'
const BASE_URL = 'https://jiji.ng'
const TIMEOUT_MS = 15_000
const MAX_RESULTS = 10

// Best-effort polite throttle. Jiji doesn't publish a robots policy so we
// match the conservative cadence used by the other classifieds-style
// scrapers (Quora, Upwork) — 2s between requests.
const REQUEST_DELAY_MS = 2000

export default async function searchJijiNg(keywordEntry, ctx = {}) {
  const { keyword } = keywordEntry || {}
  const seenIds = ctx.seenIds || { has: () => false, add: () => {} }
  const MAX_AGE_MS = ctx.MAX_AGE_MS || 24 * 60 * 60 * 1000
  const results = []
  if (!keyword || typeof keyword !== 'string') return results

  const url = `${BASE_URL}/search?query=${encodeURIComponent(keyword)}`
  let html
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html',
        'Accept-Language': 'en-NG,en;q=0.9',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`[jijing] HTTP ${res.status} for "${keyword}"`)
      return results
    }
    html = await res.text()
  } catch (err) {
    console.warn(`[jijing] fetch error for "${keyword}":`, err.message)
    return results
  }

  // Listing card pattern: anchors of the form /<region>/<category>-XXXXXX.html
  // where XXXXXX is the listing's numeric id. Jiji renders these as
  //   <a href="/lagos/houses-for-rent-12345.html" ...>title</a>
  // We capture the path + the anchor's visible text in one pass and dedupe
  // by listing id. The "two .* on either side of href" form keeps us safe
  // against attribute-order shuffling.
  const linkPattern = /<a[^>]*href="(\/[^"?#]+-(\d{4,})\.html)"[^>]*>([\s\S]*?)<\/a>/gi
  const seenLocal = new Set()
  let m
  while ((m = linkPattern.exec(html)) !== null && results.length < MAX_RESULTS) {
    const [, path, listingId, anchorInner] = m
    if (seenLocal.has(listingId)) continue
    seenLocal.add(listingId)

    // Strip nested HTML from the anchor text and collapse whitespace. Jiji
    // wraps titles in <span> for styling; we want the plain text.
    const title = anchorInner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (title.length < 4) continue   // empty / icon-only anchors

    const fullUrl = `${BASE_URL}${path}`
    const id = hashUrlToId(fullUrl, 'jijing')
    if (seenIds.has(id)) continue
    seenIds.add(id)

    // Body: try the description meta hint that often sits near the link in
    // the listing card. If not present, leave empty — title alone is enough
    // signal for classification on a marketplace listing.
    const around = html.slice(Math.max(0, m.index), m.index + 1500)
    const descMatch = around.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    const body = descMatch
      ? descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
      : ''

    // Date: Jiji shows relative timestamps (e.g. "2 hours ago"). Without a
    // reliable absolute date in the HTML we stamp `now` and let the
    // postAgeHours filter pass — better than fabricating a wrong date.
    const createdAt = new Date().toISOString()

    results.push({
      id,
      title:     title.slice(0, 240),
      url:       fullUrl,
      subreddit: 'jiji.ng',
      author:    'jiji-seller',
      score:     0,
      comments:  0,
      body,
      createdAt,
      keyword,
      source:    'jijing',
      approved:  true,
      postAgeHours: 0,
    })
  }

  // Polite throttle — only when at least one result was returned, so an
  // empty/blocked search doesn't add latency to the cycle.
  if (results.length > 0 && typeof ctx.delay === 'function') {
    await ctx.delay(REQUEST_DELAY_MS)
  }
  return results
}

// Test-only exports for pinning constants without re-deriving them.
export const _internals = { UA, BASE_URL, TIMEOUT_MS, REQUEST_DELAY_MS, MAX_RESULTS }
