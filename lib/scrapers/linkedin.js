// lib/scrapers/linkedin.js — LinkedIn post discovery via DuckDuckGo HTML.
// Zero deps, zero auth — built on Node's native fetch and regex parsing.
// Why DuckDuckGo and not Google: Google blocks datacenter IPs (Railway runs
// on cloud infra), so a Google scraper from prod fails almost immediately.
// DuckDuckGo's HTML endpoint is far more permissive with cloud IPs and
// indexes the same public LinkedIn posts.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function htmlDecode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x2F;/gi, '/')
}

function stripTags(s) {
  return htmlDecode(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function authorFromUrl(url) {
  // linkedin.com/posts/{slug}-... where slug usually starts with the author handle.
  const m = url.match(/linkedin\.com\/posts\/([^/?#_]+)/i)
  if (!m) return 'linkedin'
  const handle = m[1].split('-')[0] || 'linkedin'
  return handle.slice(0, 60) || 'linkedin'
}

// DuckDuckGo wraps result links in /l/?uddg=<encoded-url>. Pull the real URL
// out, or accept a direct linkedin URL if DDG ever switches to non-redirect form.
function unwrapDuckUrl(href) {
  if (!href) return null
  const decoded = htmlDecode(href)
  const m = decoded.match(/[?&]uddg=([^&"']+)/)
  if (m) {
    try { return decodeURIComponent(m[1]) } catch { return null }
  }
  if (/^https?:\/\/(?:www\.)?linkedin\.com\/posts\//i.test(decoded)) return decoded
  return null
}

export default async function searchLinkedIn(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword } = keywordEntry
  const results = []

  const query = `site:linkedin.com/posts "${keyword}"`
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':      UA,
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      console.warn(`[linkedin] duckduckgo ${res.status} for "${keyword}"`)
      if (delay) await delay(3000)
      return []
    }
    const html = await res.text()

    // Block / JS-required signals before parsing.
    if (html.includes('duckduckgo.com/d.js') || /Please enable JS/i.test(html)) {
      console.warn(`[linkedin] duckduckgo JS-block for "${keyword}"`)
      if (delay) await delay(3000)
      return []
    }

    // Extract every linkedin.com/posts link DDG embedded — covers both the
    // wrapped /l/?uddg=… form and direct hrefs if DDG ever stops redirecting.
    const linkedinUrls = []
    const seenUrl = new Set()

    const hrefPattern = /href="([^"]+)"/gi
    let hrefMatch
    while ((hrefMatch = hrefPattern.exec(html)) !== null) {
      const href = hrefMatch[1]
      if (!/uddg=|linkedin\.com\/posts\//i.test(href)) continue
      const real = unwrapDuckUrl(href)
      if (!real || !real.includes('linkedin.com/posts/')) continue
      if (seenUrl.has(real)) continue
      seenUrl.add(real)
      linkedinUrls.push(real)
    }

    // Title + snippet candidates from DDG's result blocks. These are best-
    // effort and may not pair 1:1 with URLs if the page format shifts.
    const titles = []
    const titlePattern = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/gi
    let tm
    while ((tm = titlePattern.exec(html)) !== null) {
      const t = stripTags(tm[1])
      if (t) titles.push(t)
    }

    const snippets = []
    const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
    let sm
    while ((sm = snippetPattern.exec(html)) !== null) {
      const s = stripTags(sm[1])
      if (s) snippets.push(s)
    }

    for (let i = 0; i < linkedinUrls.length; i++) {
      const link = linkedinUrls[i]
      const id = `linkedin_${Buffer.from(link).toString('base64').slice(0, 24)}`
      if (seenIds.has(id)) continue
      seenIds.add(id)

      const title   = (titles[i] || keyword).slice(0, 200)
      const snippet = (snippets[i] || '').slice(0, 600)

      results.push({
        id,
        title,
        url:       link,
        subreddit: 'LinkedIn',
        author:    authorFromUrl(link),
        score:     0,
        comments:  0,
        body:      snippet,
        createdAt: new Date().toISOString(),
        keyword,
        source:    'linkedin',
        approved:  true,
      })

      if (results.length >= 10) break
    }
  } catch (err) {
    console.warn(`[linkedin] error for "${keyword}": ${err.message}`)
    if (delay) await delay(3000)
    return []
  }

  if (delay) await delay(3000)
  return results
}
