// lib/scrapers/producthunt.js — Product Hunt search
// Tries official API first (PRODUCT_HUNT_ACCESS_TOKEN), falls back to SSR page scrape

import * as cheerio from 'cheerio'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export default async function searchProductHunt(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword } = keywordEntry
  const token = process.env.PRODUCT_HUNT_ACCESS_TOKEN

  if (token) return searchViaAPI(keyword, token, seenIds, MAX_AGE_MS)
  return searchViaPage(keyword, seenIds, MAX_AGE_MS)
}

// ── Official API (GraphQL) ────────────────────────────────────────────────────
async function searchViaAPI(keyword, token, seenIds, MAX_AGE_MS) {
  const results = []
  const query = `query($q:String!){search(query:$q,first:20,types:[POST]){edges{node{...on Post{id name tagline description createdAt votesCount commentsCount slug url user{username}}}}}}`
  try {
    const res = await fetch('https://api.producthunt.com/v2/api/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': UA,
      },
      body: JSON.stringify({ query, variables: { q: keyword } }),
      signal: AbortSignal.timeout(9000),
    })
    if (!res.ok) return []
    const data = await res.json()
    for (const edge of (data?.data?.search?.edges || [])) {
      const p = edge?.node
      if (!p) continue
      const createdAt = new Date(p.createdAt).getTime()
      if (MAX_AGE_MS && Date.now() - createdAt > MAX_AGE_MS) continue
      const id = `ph_${p.id}`
      if (seenIds.has(id)) continue
      seenIds.add(id)
      results.push({
        id, source: 'producthunt',
        title: p.name || p.tagline,
        body: p.tagline || p.description || '',
        url: p.url || `https://www.producthunt.com/posts/${p.slug}`,
        subreddit: 'producthunt',
        author: p.user?.username || '',
        score: p.votesCount || 0,
        comments: p.commentsCount || 0,
        createdAt: p.createdAt,
        keyword, approved: true,
      })
      if (results.length >= 15) break
    }
  } catch (err) {
    console.warn(`[producthunt] API error for "${keyword}":`, err.message)
  }
  return results
}

// ── SSR page scrape (no token) ────────────────────────────────────────────────
async function searchViaPage(keyword, seenIds, MAX_AGE_MS) {
  const results = []
  try {
    const url = `https://www.producthunt.com/search?q=${encodeURIComponent(keyword)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return []
    const html = await res.text()

    // Try __NEXT_DATA__ first (Next.js SSR)
    const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
    if (nextMatch) {
      try {
        const nextData = JSON.parse(nextMatch[1])
        const hits = nextData?.props?.pageProps?.searchResults?.items
          || nextData?.props?.pageProps?.hits
          || []
        for (const p of hits) {
          const createdAt = new Date(p.createdAt || p.featuredAt || Date.now()).getTime()
          if (MAX_AGE_MS && Date.now() - createdAt > MAX_AGE_MS) continue
          const id = `ph_${p.id || p.slug}`
          if (seenIds.has(id)) continue
          seenIds.add(id)
          results.push({
            id, source: 'producthunt',
            title: p.name || p.tagline || p.title || '',
            body: p.tagline || p.description || '',
            url: p.url || (p.slug ? `https://www.producthunt.com/posts/${p.slug}` : ''),
            subreddit: 'producthunt',
            author: p.user?.username || '',
            score: p.votesCount || 0,
            comments: p.commentsCount || 0,
            createdAt: new Date(createdAt).toISOString(),
            keyword, approved: true,
          })
          if (results.length >= 15) break
        }
        if (results.length) return results
      } catch (_) {}
    }

    // Cheerio fallback — PH product cards
    const $ = cheerio.load(html)
    $('[data-test="post-item"], [class*="post-item"], [class*="PostItem"]').each((_, el) => {
      if (results.length >= 15) return false
      const $el = $(el)
      const title = $el.find('h3, [class*="title"], [class*="name"]').first().text().trim()
      const tagline = $el.find('p, [class*="tagline"], [class*="description"]').first().text().trim()
      const href = $el.find('a[href*="/posts/"]').first().attr('href')
      if (!title || !href) return
      const url = href.startsWith('http') ? href : `https://www.producthunt.com${href}`
      const id = `ph_${Buffer.from(url).toString('base64').slice(0, 24)}`
      if (seenIds.has(id)) return
      seenIds.add(id)
      results.push({
        id, source: 'producthunt',
        title, body: tagline,
        url, subreddit: 'producthunt',
        author: '', score: 0, comments: 0,
        createdAt: new Date().toISOString(),
        keyword, approved: true,
      })
    })
  } catch (err) {
    console.warn(`[producthunt] page scrape error for "${keyword}":`, err.message)
  }
  return results
}
