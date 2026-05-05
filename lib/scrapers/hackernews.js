// lib/scrapers/hackernews.js — Hacker News search via the Algolia HN API.
// Public, no auth required. Same return shape as the other scrapers.
// Makes two calls per keyword: stories + Ask HN posts (high buying signal).

import { fetchWithBackoff } from './_fetch-backoff.js'

const UA       = 'Mozilla/5.0 (compatible; EbenovaBot/2.0)'
const MAX_HITS = 10
const HN_BASE  = 'https://hn.algolia.com/api/v1/search_by_date'

async function fetchHN(encoded, since, tags) {
  const url = `${HN_BASE}?query=${encoded}&tags=${tags}&numericFilters=created_at_i>${since}&hitsPerPage=${MAX_HITS}`
  try {
    const res = await fetchWithBackoff(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) })
    if (!res || !res.ok) {
      if (res) console.warn(`[hackernews] ${res.status} for "${tags}" query`)
      return []
    }
    return (await res.json()).hits || []
  } catch (err) {
    console.warn(`[hackernews] fetch error (${tags}):`, err.message)
    return []
  }
}

export default async function searchHackerNews(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword } = keywordEntry
  const results = []
  const seen = new Set()  // dedup within this call by objectID
  const encoded = encodeURIComponent(keyword)
  const ageMs = MAX_AGE_MS || (24 * 60 * 60 * 1000)
  const since = Math.floor((Date.now() - ageMs) / 1000)

  // Two calls: stories + Ask HN
  const storyHits   = await fetchHN(encoded, since, 'story')
  await new Promise(r => setTimeout(r, 100))
  const askHnHits   = await fetchHN(encoded, since, 'ask_hn')

  let storyCount = 0, askCount = 0

  function processHit(hit, type) {
    if (seen.has(hit.objectID)) return
    seen.add(hit.objectID)
    const id = `hn_${hit.objectID}`
    if (seenIds.has(id)) return
    seenIds.add(id)
    if (results.length >= MAX_HITS) return
    const createdAt = hit.created_at_i ? new Date(hit.created_at_i * 1000) : new Date()
    results.push({
      id,
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
    })
    if (type === 'story') storyCount++
    else askCount++
  }

  for (const hit of storyHits) processHit(hit, 'story')
  for (const hit of askHnHits)  processHit(hit, 'ask_hn')

  if (storyCount > 0 || askCount > 0) {
    console.log(`[hn] "${keyword}" → ${storyCount} stories, ${askCount} ask_hn posts`)
  }

  if (delay) await delay(1500)
  return results
}
