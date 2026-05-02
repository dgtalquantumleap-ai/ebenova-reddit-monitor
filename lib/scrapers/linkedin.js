// lib/scrapers/linkedin.js — LinkedIn post search via DuckDuckGo HTML scraping.
// No new npm packages — uses only built-in fetch and regex.
// Why DuckDuckGo: Railway runs on cloud IPs that Google blocks with CAPTCHA.
// DuckDuckGo is permissive with datacenter IPs and indexes the same public posts.

export default async function searchLinkedIn(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword } = keywordEntry
  const results = []

  const query = encodeURIComponent(`site:linkedin.com/posts "${keyword}"`)
  const url   = `https://html.duckduckgo.com/html/?q=${query}`

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      console.warn(`[linkedin] DuckDuckGo returned ${res.status} for "${keyword}"`)
      if (delay) await delay(3000)
      return results
    }

    const html = await res.text()

    // Block detection
    if (
      html.includes('duckduckgo.com/d.js') ||
      html.includes('enable JavaScript') ||
      html.includes('g-recaptcha')
    ) {
      console.warn(`[linkedin] DuckDuckGo blocked request for "${keyword}"`)
      if (delay) await delay(3000)
      return results
    }

    // Extract LinkedIn post URLs from DDG redirect links
    const urlPattern = /uddg=(https?%3A%2F%2F(?:www\.)?linkedin\.com%2Fposts%2F[^&"]+)/g
    const directPattern = /href="(https?:\/\/(?:www\.)?linkedin\.com\/posts\/[^"]+)"/g

    const foundUrls = new Set()
    let m

    const pattern1 = new RegExp(urlPattern.source, 'g')
    while ((m = pattern1.exec(html)) !== null) {
      try { foundUrls.add(decodeURIComponent(m[1])) } catch { /* skip malformed */ }
    }

    if (foundUrls.size === 0) {
      const pattern2 = new RegExp(directPattern.source, 'g')
      while ((m = pattern2.exec(html)) !== null) {
        foundUrls.add(m[1])
      }
    }

    for (const postUrl of foundUrls) {
      if (!postUrl.includes('linkedin.com/posts/')) continue

      const id = `linkedin_${Buffer.from(postUrl).toString('base64').slice(0, 24)}`
      if (seenIds.has(id)) continue
      seenIds.add(id)

      // Extract snippet — 300 chars of text near the URL in the raw HTML
      const urlIdx = html.indexOf(postUrl.replace('https://', ''))
      const windowStart = Math.max(0, urlIdx - 100)
      const windowEnd   = Math.min(html.length, urlIdx + 400)
      const rawSnippet  = html.slice(windowStart, windowEnd)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      // Author from URL slug: linkedin.com/posts/john-smith-123_abc → 'john-smith'
      const slugMatch = postUrl.match(/\/posts\/([a-z0-9-]+)/i)
      const author    = slugMatch
        ? slugMatch[1].replace(/-\d+$/, '').slice(0, 40)
        : 'linkedin'

      results.push({
        id,
        title:     rawSnippet.slice(0, 200) || 'LinkedIn post',
        url:       postUrl,
        subreddit: 'LinkedIn',
        author,
        score:     0,
        comments:  0,
        body:      rawSnippet.slice(0, 600),
        createdAt: new Date().toISOString(),
        keyword,
        source:    'linkedin',
        approved:  true,
      })

      if (results.length >= 10) break
    }
  } catch (err) {
    console.warn(`[linkedin] Error for "${keyword}":`, err.message)
  }

  if (delay) await delay(3000)
  return results
}
