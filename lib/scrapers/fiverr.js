// lib/scrapers/fiverr.js — Fiverr Community forum search (public HTML)
// Returns posts in the same shape as searchReddit() in monitor.js

import * as cheerio from 'cheerio'
import { hashUrlToId } from './_id.js'
import { fetchWithBackoff } from './_fetch-backoff.js'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

export default async function searchFiverr(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword } = keywordEntry
  const results = []

  const url = `https://community.fiverr.com/forums/search?q=${encodeURIComponent(keyword)}`
  try {
    const res = await fetchWithBackoff(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    })
    if (!res || !res.ok) {
      if (res) console.warn(`[fiverr] HTTP ${res.status} for "${keyword}"`)
      return results
    }

    const html = await res.text()
    const $ = cheerio.load(html)

    const candidates = []

    // Fiverr Community uses Discourse — search results have data-topic-id attributes
    $('li.fps-result, .search-results li, a.search-link, [data-topic-id]').each((i, el) => {
      const $el = $(el)
      const $link = $el.is('a') ? $el : $el.find('a').first()
      const href  = $link.attr('href') || ''
      const title = ($el.find('.topic-title, h3').text() || $link.text() || '').trim()
      if (href && title.length > 10) candidates.push({ href, title })
    })

    // Fallback: links that look like topic URLs
    if (candidates.length === 0) {
      $('a[href*="/t/"]').each((i, el) => {
        const href  = $(el).attr('href') || ''
        const title = $(el).text().trim()
        if (title.length > 15 && title.length < 250) candidates.push({ href, title })
      })
    }

    const seen = new Set()
    for (const { href, title } of candidates.slice(0, 10)) {
      const fullUrl = href.startsWith('http') ? href : `https://community.fiverr.com${href}`
      const id = hashUrlToId(href, 'fiverr')
      if (seen.has(id) || seenIds.has(id)) continue
      seen.add(id)
      seenIds.add(id)

      results.push({
        id, title,
        url: fullUrl,
        subreddit: 'fiverr-community',
        author: 'fiverr',
        score: 0, comments: 0,
        body: '',
        createdAt: new Date().toUTCString(),
        keyword, source: 'fiverr', approved: true,
      })
    }
  } catch (err) {
    console.warn(`[fiverr] fetch error for "${keyword}":`, err.message)
  }

  if (delay) await delay(3000)
  return results
}
