// lib/scrapers/quora.js — Quora public search page scrape
// Returns posts in the same shape as searchReddit() in monitor.js

import { hashUrlToId } from './_id.js'
import { fetchWithBackoff } from './_fetch-backoff.js'
import { resolveKeyword } from '../reddit-rss.js'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// One-shot disable: if Quora returns 403 (bot block) we log once and return []
// silently for the rest of the process lifetime. Prevents log spam every cycle.
let _disabled = false

export default async function searchQuora(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const keyword = resolveKeyword(keywordEntry)
  const results = []

  if (_disabled) return results

  const url = `https://www.quora.com/search?q=${encodeURIComponent(keyword)}&type=question`
  try {
    const res = await fetchWithBackoff(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
        'Referer': 'https://www.google.com/',
      }
    })
    if (!res || !res.ok) {
      if (res?.status === 403) {
        _disabled = true
        console.warn('[quora] DISABLED — returning [] (bot blocked). Quora returns 403 from server IPs.')
        return results
      }
      if (res) console.warn(`[quora] HTTP ${res.status} for "${keyword}"`)
      return results
    }

    const html = await res.text()

    // Extract question links from Quora's HTML — they appear as /What-is... or /How-do...
    // Pattern: href="/[A-Z][^"?]+" with the question text in the anchor
    const linkPattern = /href="(\/[A-Z][^"?#]{10,200})"/g
    const seen = new Set()
    let match

    while ((match = linkPattern.exec(html)) !== null && results.length < 10) {
      const path = match[1]
      // Skip profile pages, topic pages, and search result artifacts
      if (path.includes('/profile/') || path.includes('/topic/') || path.startsWith('/sitemap')) continue
      if (!path.match(/\/[A-Z][a-z]/)) continue // questions start with capital letter word

      const id = hashUrlToId(path, 'quora')
      if (seen.has(id) || seenIds.has(id)) continue
      seen.add(id)

      // Extract surrounding text as the title
      const idx = match.index
      const surrounding = html.slice(Math.max(0, idx - 50), idx + 300)
      const titleMatch = surrounding.match(/>([^<]{10,200})<\//)
      const title = titleMatch?.[1]?.trim() || path.slice(1).replace(/-/g, ' ')

      seenIds.add(id)
      results.push({
        id, title,
        url: `https://www.quora.com${path}`,
        subreddit: 'quora',
        author: 'quora',
        score: 0, comments: 0,
        body: '',
        createdAt: new Date().toUTCString(),
        keyword, source: 'quora', approved: true,
      })
    }
  } catch (err) {
    console.warn(`[quora] fetch error for "${keyword}":`, err.message)
  }

  return results
}

// Test-only: reset the one-shot disabled flag between test cases.
export const _internals = {
  reset: () => { _disabled = false },
}
