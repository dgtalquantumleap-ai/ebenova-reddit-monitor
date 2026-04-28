// Run scrapers in parallel to fetch sample matches for the wizard's
// confirmation screen. Caps at 5 results, dedup by URL, rank by recency.
// Reuses the existing scraper modules without modification.

import searchMedium from './scrapers/medium.js'
import searchSubstack from './scrapers/substack.js'
import searchQuora from './scrapers/quora.js'
import searchUpwork from './scrapers/upwork.js'
import searchFiverr from './scrapers/fiverr.js'

const SCRAPERS = {
  medium: searchMedium,
  substack: searchSubstack,
  quora: searchQuora,
  upwork: searchUpwork,
  fiverr: searchFiverr,
}

const DEFAULT_AGE_HOURS = 168  // 7 days
const DEFAULT_LIMIT = 5

export function withinAge(createdAt, maxHours = DEFAULT_AGE_HOURS) {
  if (!createdAt) return true
  const ageMs = Date.now() - new Date(createdAt).getTime()
  return ageMs <= maxHours * 60 * 60 * 1000
}

export function dedupAndRank(matches, limit = DEFAULT_LIMIT) {
  const byUrl = new Map()
  for (const m of matches) {
    if (!m.url) continue
    if (!byUrl.has(m.url)) byUrl.set(m.url, m)
  }
  const unique = Array.from(byUrl.values())
  unique.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
  return unique.slice(0, limit)
}

// Search Reddit's public JSON for posts matching a keyword across subreddits.
// Lightweight version (no Groq draft, no semantic search — those run in the
// real cron). Just fetch + filter by age.
async function searchReddit(keyword, subreddits, maxAgeHours) {
  const results = []
  const subs = subreddits.length ? subreddits : ['all']
  for (const sub of subs.slice(0, 5)) {
    const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json?q=${encodeURIComponent(keyword)}&restrict_sr=1&sort=new&limit=10`
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'ebenova-monitor-preview/1.0' },
      })
      if (!res.ok) continue
      const data = await res.json()
      for (const child of data?.data?.children || []) {
        const p = child.data
        if (!p) continue
        const createdAt = new Date((p.created_utc || 0) * 1000).toISOString()
        if (!withinAge(createdAt, maxAgeHours)) continue
        results.push({
          id: p.id,
          source: 'reddit',
          subreddit: p.subreddit,
          title: p.title,
          body: (p.selftext || '').slice(0, 280),
          author: p.author,
          score: p.score,
          comments: p.num_comments,
          url: `https://reddit.com${p.permalink}`,
          createdAt,
          matchedKeyword: keyword,
        })
      }
    } catch { /* skip this sub on error */ }
  }
  return results
}

export async function getSampleMatches({ keywords, subreddits, platforms, maxAgeHours = DEFAULT_AGE_HOURS, limit = DEFAULT_LIMIT }) {
  const tasks = []

  for (const kw of (keywords || []).slice(0, 5)) {
    if (platforms.includes('reddit')) tasks.push(searchReddit(kw, subreddits || [], maxAgeHours))
    for (const platform of platforms) {
      if (platform === 'reddit') continue
      const fn = SCRAPERS[platform]
      if (!fn) continue
      tasks.push(
        Promise.resolve()
          .then(() => fn({ keyword: kw, maxAgeHours }))
          .then(rows => (rows || []).map(r => ({ ...r, source: platform, matchedKeyword: kw })))
          .catch(() => [])
      )
    }
  }

  const results = (await Promise.all(tasks)).flat()
  return dedupAndRank(results, limit)
}
