// lib/scrapers/medium.js — Medium RSS tag-feed search
// Returns posts in the same shape as searchReddit() in monitor.js

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

export default async function searchMedium(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword } = keywordEntry
  const results = []

  // Medium exposes RSS for tag searches — tags are single words so we try each word
  const tags = keyword.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').filter(Boolean)
  const uniqueTags = [...new Set(tags)].slice(0, 2) // cap at 2 tags per keyword

  for (const tag of uniqueTags) {
    const url = `https://medium.com/feed/tag/${encodeURIComponent(tag)}`
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,application/xml,text/xml' } })
      if (!res.ok) continue
      const xml = await res.text()

      // Parse RSS items with regex (no XML parser dependency)
      const itemPattern = /<item>([\s\S]*?)<\/item>/gi
      let itemMatch
      while ((itemMatch = itemPattern.exec(xml)) !== null) {
        const item = itemMatch[1]
        const title   = (/<title><!\[CDATA\[([^\]]+)\]\]>/.exec(item) || /<title>([^<]+)</.exec(item))?.[1]?.trim()
        const link    = (/<link>([^<]+)</.exec(item))?.[1]?.trim()
        const pubDate = (/<pubDate>([^<]+)</.exec(item))?.[1]?.trim()
        const author  = (/<dc:creator><!\[CDATA\[([^\]]+)\]\]>/.exec(item) || /<dc:creator>([^<]+)</.exec(item))?.[1]?.trim() || 'medium'
        const desc    = (/<description><!\[CDATA\[([^<]{0,800})/.exec(item))?.[1]?.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()

        if (!title || !link) continue

        const createdAt = pubDate ? new Date(pubDate).getTime() : Date.now()
        if (MAX_AGE_MS && Date.now() - createdAt > MAX_AGE_MS) continue

        // Deduplicate using URL hash
        const id = `medium_${Buffer.from(link).toString('base64').slice(0, 24)}`
        if (seenIds.has(id)) continue
        seenIds.add(id)

        results.push({
          id, title, url: link,
          subreddit: `medium-${tag}`,
          author,
          score: 0, comments: 0,
          body: (desc || '').slice(0, 600),
          createdAt: new Date(createdAt).toUTCString(),
          keyword, source: 'medium', approved: true,
        })

        if (results.length >= 10) break
      }
    } catch (err) {
      console.warn(`[medium] fetch error for tag "${tag}":`, err.message)
    }
    if (delay) await delay(1500)
  }

  return results
}
