// lib/scrapers/substack.js — Substack internal search
// Returns posts in the same shape as searchReddit() in monitor.js

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

export default async function searchSubstack(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword } = keywordEntry
  const results = []

  const url = `https://substack.com/api/v1/post/search?query=${encodeURIComponent(keyword)}&offset=0&limit=10`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' }
    })
    if (!res.ok) {
      console.warn(`[substack] HTTP ${res.status} for "${keyword}"`)
      return results
    }

    const data = await res.json()
    const posts = data?.results || data?.posts || []

    for (const post of posts) {
      const title   = post.title || post.headline || ''
      const link    = post.canonical_url || post.url || ''
      const author  = post.publishedBylines?.[0]?.name || post.author?.name || 'substack'
      const body    = (post.description || post.subtitle || '').slice(0, 600)
      const pubAt   = post.post_date || post.published_at || post.publishedAt || ''
      const createdAt = pubAt ? new Date(pubAt).getTime() : Date.now()

      if (!title || !link) continue
      if (MAX_AGE_MS && Date.now() - createdAt > MAX_AGE_MS) continue

      const id = `ss_${Buffer.from(link).toString('base64').slice(0, 24)}`
      if (seenIds.has(id)) continue
      seenIds.add(id)

      results.push({
        id, title, url: link,
        subreddit: 'substack',
        author,
        score: post.reactions || 0, comments: 0,
        body,
        createdAt: new Date(createdAt).toUTCString(),
        keyword, source: 'substack', approved: true,
      })
    }
  } catch (err) {
    console.warn(`[substack] fetch error for "${keyword}":`, err.message)
  }

  return results
}
