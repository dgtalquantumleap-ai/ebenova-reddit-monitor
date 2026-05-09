// lib/scrapers/upwork.js — Upwork Community forum search (public HTML)
// Returns posts in the same shape as searchReddit() in monitor.js
//
// ─── DISABLED at the platform-dispatch layer ────────────────────────────────
// As of May 2026 this scraper is gated off in lib/platforms.js
// (PLATFORM_DISABLED.upwork). community.upwork.com returns HTTP 403 on
// every server-side request — Khoros (the Lithium-derived forum platform)
// has hardened bot detection enough that a plain User-Agent + Accept-Language
// fetch is rejected without a logged-in session. monitor-v2.js (main
// dispatch), monitor.js (v1, gated alongside INCLUDE_UPWORK_FORUM), and
// api-server.js /v1/search all consult isPlatformDisabled('upwork') and
// short-circuit before this scraper is called.
//
// To re-enable: delete the 'upwork' entry from PLATFORM_DISABLED in
// lib/platforms.js after one of these is in place:
//   1. An Apify Upwork actor (or equivalent paid scraper) wired into
//      a new fetch path here, OR
//   2. A logged-in HTTP session — store cookies in Redis the same way
//      Twitter scraper does, refresh on 401.
// Tests that import this module directly continue to work — they exercise
// scraper internals via mocked fetches.
// ────────────────────────────────────────────────────────────────────────────

import * as cheerio from 'cheerio'
import { hashUrlToId } from './_id.js'
import { fetchWithBackoff } from './_fetch-backoff.js'
import { resolveKeyword } from '../reddit-rss.js'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

export default async function searchUpwork(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const keyword = resolveKeyword(keywordEntry)
  const results = []

  const url = `https://community.upwork.com/t5/forums/searchpage/tab/message?q=${encodeURIComponent(keyword)}&sort_by=-topicPostDate`
  try {
    const res = await fetchWithBackoff(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    })
    if (!res || !res.ok) {
      if (res) console.warn(`[upwork] HTTP ${res.status} for "${keyword}"`)
      return results
    }

    const html = await res.text()
    const $ = cheerio.load(html)

    // Upwork Community uses Lithium/Khoros — search results are in .search-result or message list items
    const candidates = []

    // Primary selector: search result message rows
    $('li.search-result, .message-list-item, .lia-message-item, h3.lia-message-subject a, .search-results .message-subject a').each((i, el) => {
      const $el = $(el)
      const $link = $el.is('a') ? $el : $el.find('a').first()
      const href = $link.attr('href') || ''
      const title = ($link.text() || $el.find('.message-subject, .lia-message-subject').text() || '').trim()
      if (href && title && href.includes('/t5/')) candidates.push({ href, title })
    })

    // Fallback: any link into the t5 board with a reasonable title
    if (candidates.length === 0) {
      $('a[href*="/t5/"]').each((i, el) => {
        const href  = $(el).attr('href') || ''
        const title = $(el).text().trim()
        if (title.length > 15 && title.length < 250 && !href.includes('searchpage') && !href.includes('/category/')) {
          candidates.push({ href, title })
        }
      })
    }

    const seen = new Set()
    for (const { href, title } of candidates.slice(0, 10)) {
      const fullUrl = href.startsWith('http') ? href : `https://community.upwork.com${href}`
      const id = hashUrlToId(href, 'upwork')
      if (seen.has(id) || seenIds.has(id)) continue
      seen.add(id)
      seenIds.add(id)

      results.push({
        id, title,
        url: fullUrl,
        subreddit: 'upwork-community',
        author: 'upwork',
        score: 0, comments: 0,
        body: '',
        createdAt: new Date().toUTCString(),
        keyword, source: 'upwork', approved: true,
      })
    }
  } catch (err) {
    console.warn(`[upwork] fetch error for "${keyword}":`, err.message)
  }

  if (delay) await delay(3000)
  return results
}
