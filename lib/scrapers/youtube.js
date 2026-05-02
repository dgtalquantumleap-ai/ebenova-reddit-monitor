// lib/scrapers/youtube.js — YouTube Data API v3 keyword search
// Searches for recent videos matching the keyword.
// Requires YOUTUBE_API_KEY in env. Degrades gracefully (returns []) if absent.
//
// Quota cost: 100 units per search call (free tier = 10,000 units/day).
// With multi-tenant use, keep maxResults low and gate behind the platforms[] flag.

import { hashUrlToId } from './_id.js'

const API_BASE = 'https://www.googleapis.com/youtube/v3/search'

export default async function searchYouTube(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey) return []

  const { keyword } = keywordEntry
  const results = []

  const ageMs     = MAX_AGE_MS || 24 * 60 * 60 * 1000
  const published = new Date(Date.now() - ageMs).toISOString()

  const params = new URLSearchParams({
    part:           'snippet',
    q:              keyword,
    type:           'video',
    order:          'date',
    publishedAfter: published,
    maxResults:     '10',
    key:            apiKey,
  })

  try {
    const res = await fetch(`${API_BASE}?${params}`, {
      headers: { 'User-Agent': 'EbenovaBot/2.0' },
      signal:  AbortSignal.timeout(8000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[youtube] ${res.status} for "${keyword}": ${body.slice(0, 120)}`)
      return results
    }

    const data = await res.json()

    for (const item of (data.items || [])) {
      if (item.id?.kind !== 'youtube#video') continue
      const videoId = item.id.videoId
      if (!videoId) continue

      const url = `https://www.youtube.com/watch?v=${videoId}`
      const id  = hashUrlToId(url, 'yt')

      if (seenIds.has(id)) continue
      seenIds.add(id)

      const snippet = item.snippet || {}
      results.push({
        id,
        title:     snippet.title || '(no title)',
        url,
        subreddit: snippet.channelTitle || 'YouTube',
        author:    snippet.channelTitle || 'unknown',
        score:     0,
        comments:  0,
        body:      (snippet.description || '').slice(0, 600),
        createdAt: snippet.publishedAt || new Date().toISOString(),
        keyword,
        source:    'youtube',
        approved:  true,
      })

      if (results.length >= 10) break
    }
  } catch (err) {
    console.warn(`[youtube] fetch error for "${keyword}":`, err.message)
  }

  if (delay) await delay(2000)
  return results
}
