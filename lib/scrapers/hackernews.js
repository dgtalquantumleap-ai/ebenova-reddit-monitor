// lib/scrapers/hackernews.js — Hacker News search via the Algolia HN API.
// Public, no auth required. Same return shape as the other scrapers in
// this directory, so monitor-v2.js can use it interchangeably.
//
// Makes two calls per keyword:
//   tags=story    — regular HN stories
//   tags=ask_hn   — Ask HN posts (high-intent: founders asking for tools)
// Results are deduped by objectID. ask_hn posts carry type:'ask_hn' so the
// caller can boost their intentScore (monitor-v2 bumps them to ≥60).
//
// Algolia HN API docs: https://hn.algolia.com/api

import { fetchWithBackoff } from './_fetch-backoff.js'

const UA = 'Mozilla/5.0 (compatible; EbenovaBot/2.0)'
const BASE = 'https://hn.algolia.com/api/v1/search_by_date'

async function fetchHits(keyword, tags, since) {
  const encoded = encodeURIComponent(keyword)
  const url = `${BASE}?query=${encoded}&tags=${tags}&numericFilters=created_at_i>${since}&hitsPerPage=10`
  try {
    const res = await fetchWithBackoff(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) })
    if (!res || !res.ok) {
      if (res) console.warn(`[hackernews] ${res.status} for "${keyword}" (${tags})`)
      return []
    }
    const data = await res.json()
    return data.hits || []
  } catch (err) {
    console.warn(`[hackernews] fetch error for "${keyword}" (${tags}):`, err.message)
    return []
  }
}

function hitToMatch(hit, type, keyword) {
  const createdAt = hit.created_at_i ? new Date(hit.created_at_i * 1000) : new Date()
  return {
    id:        `hn_${hit.objectID}`,
    title:     hit.title || hit.story_title || '(no title)',
    url:       `https://news.ycombinator.com/item?id=${hit.objectID}`,
    subreddit: 'HackerNews',
    author:    hit.author || 'unknown',
    score:     hit.points || 0,
    comments:  hit.num_comments || 0,
    body:      (hit.story_text || '').replace(/<[^>]+>/g, ' ').slice(0, 600),
    createdAt: createdAt.toISOString(),
    keyword,
    source:    'hackernews',
    type,
    approved:  true,
  }
}

export default async function searchHackerNews(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword } = keywordEntry
  const ageMs = MAX_AGE_MS || (24 * 60 * 60 * 1000)
  const since = Math.floor((Date.now() - ageMs) / 1000)

  const [storyHits, askHits] = await Promise.all([
    fetchHits(keyword, 'story', since),
    // 100ms gap between calls to be polite to the Algolia endpoint
    new Promise(resolve => setTimeout(resolve, 100)).then(() => fetchHits(keyword, 'ask_hn', since)),
  ])

  const seen = new Set()
  const results = []

  for (const [hits, type] of [[storyHits, 'story'], [askHits, 'ask_hn']]) {
    for (const hit of hits) {
      if (seen.has(hit.objectID)) continue
      const matchId = `hn_${hit.objectID}`
      if (seenIds.has(matchId)) continue
      seen.add(hit.objectID)
      seenIds.add(matchId)
      results.push(hitToMatch(hit, type, keyword))
      if (results.length >= 20) break
    }
    if (results.length >= 20) break
  }

  const storyCount = results.filter(r => r.type === 'story').length
  const askCount   = results.filter(r => r.type === 'ask_hn').length
  if (results.length > 0) {
    console.log(`[hn] "${keyword}" → ${storyCount} stories, ${askCount} ask_hn posts`)
  }

  if (delay) await delay(1500)
  return results
}
