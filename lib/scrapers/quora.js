// lib/scrapers/quora.js — Quora public search page scrape
// Returns posts in the same shape as searchReddit() in monitor.js

import { hashUrlToId } from './_id.js'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

export default async function searchQuora(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword } = keywordEntry
  const results = []

  const url = `https://www.quora.com/search?q=${encodeURIComponent(keyword)}&type=question`
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    })
    if (!res.ok) {
      console.warn(`[quora] HTTP ${res.status} for "${keyword}"`)
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
