// lib/scrapers/hackernews.js — Hacker News search via the Algolia HN API.
// Public, no auth required. Same return shape as the other scrapers in
// this directory, so monitor-v2.js can use it interchangeably.
//
// Algolia HN API docs: https://hn.algolia.com/api
// We use search_by_date for fresh results sorted by recency.

import { fetchWithBackoff } from './_fetch-backoff.js'

const UA = 'Mozilla/5.0 (compatible; EbenovaBot/2.0)'

export default async function searchHackerNews(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword } = keywordEntry
  const results = []
  const encoded = encodeURIComponent(keyword)
  // Algolia's numericFilters wants epoch seconds. Default to 24h window if
  // MAX_AGE_MS isn't provided so we never blast the user with stale items.
  const ageMs   = MAX_AGE_MS || (24 * 60 * 60 * 1000)
  const since   = Math.floor((Date.now() - ageMs) / 1000)
  const url     = `https://hn.algolia.com/api/v1/search_by_date?query=${encoded}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=10`

  try {
    const res = await fetchWithBackoff(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) })
    if (!res || !res.ok) {
      if (res) console.warn(`[hackernews] ${res.status} for "${keyword}"`)
      return results
    }
    const data = await res.json()
    for (const hit of (data.hits || [])) {
      const id = `hn_${hit.objectID}`
      if (seenIds.has(id)) continue
      seenIds.add(id)

      const createdAt = hit.created_at_i ? new Date(hit.created_at_i * 1000) : new Date()
      results.push({
        id,
        title:     hit.title || hit.story_title || '(no title)',
        url:       `https://news.ycombinator.com/item?id=${hit.objectID}`,
        // We use 'HackerNews' as the subreddit value so the email/feed UI
        // has something to display where r/* would normally go. Source is
        // the canonical platform tag.
        subreddit: 'HackerNews',
        author:    hit.author || 'unknown',
        score:     hit.points || 0,
        comments:  hit.num_comments || 0,
        body:      (hit.story_text || '').replace(/<[^>]+>/g, ' ').slice(0, 600),
        createdAt: createdAt.toISOString(),
        keyword,
        source:    'hackernews',
        // HN posts are public discussion threads; product mentions are fine
        // (community is largely founder/dev-friendly to tool recommendations).
        approved:  true,
      })

      if (results.length >= 10) break
    }
  } catch (err) {
    console.warn(`[hackernews] fetch error for "${keyword}":`, err.message)
  }

  if (delay) await delay(1500)
  return results
}
