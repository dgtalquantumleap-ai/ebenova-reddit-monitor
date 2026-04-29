// lib/scrapers/linkedin.js — LinkedIn post discovery via Google site: search.
// Zero deps, zero auth — built on Node's native fetch and regex parsing of
// Google's HTML (mirrors how medium.js parses RSS without an XML parser).
// Google blocks automated traffic in patterns (CAPTCHA / 429) — we degrade
// gracefully by returning [] when blocking is detected.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()
}

function authorFromUrl(url) {
  // linkedin.com/posts/{slug}-... where slug usually starts with the author handle.
  const m = url.match(/linkedin\.com\/posts\/([^/?#_]+)/i)
  if (!m) return 'linkedin'
  const handle = m[1].split('-')[0] || 'linkedin'
  return handle.slice(0, 60) || 'linkedin'
}

export default async function searchLinkedIn(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword } = keywordEntry
  const results = []

  const query = `site:linkedin.com/posts "${keyword}"`
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&tbs=qdr:w`

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':      UA,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept':          'text/html',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      console.warn(`[linkedin] google ${res.status} for "${keyword}"`)
      if (delay) await delay(3000)
      return []
    }
    const html = await res.text()

    // Detect block / empty signals before parsing.
    if (html.includes('g-recaptcha') || /sorry\/index/i.test(html)) {
      console.warn(`[linkedin] google CAPTCHA hit for "${keyword}"`)
      if (delay) await delay(3000)
      return []
    }
    if (/did not match any documents/i.test(html)) {
      if (delay) await delay(3000)
      return []
    }

    // Pull every linkedin.com/posts/ URL Google embedded in the result page.
    // Be lenient — if the layout shifts, return what we can rather than fail.
    const linkedinUrls = []
    const seenUrl = new Set()
    const urlPattern = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/posts\/[^"'<>\s]+/gi
    let urlMatch
    while ((urlMatch = urlPattern.exec(html)) !== null) {
      let raw = urlMatch[0]
      // Google sometimes wraps URLs in /url?q=...&sa=... — strip trailing chars.
      raw = raw.replace(/&amp;.*$/, '').replace(/[)\]}>'"]+$/, '')
      if (!raw.includes('linkedin.com/posts/')) continue
      if (seenUrl.has(raw)) continue
      seenUrl.add(raw)
      linkedinUrls.push(raw)
    }

    // Pull h3 (titles) and snippet candidates so we can pair them with URLs.
    const titles = []
    const titlePattern = /<h3[^>]*>([\s\S]*?)<\/h3>/gi
    let tm
    while ((tm = titlePattern.exec(html)) !== null) {
      const t = stripTags(tm[1])
      if (t) titles.push(t)
    }

    const snippets = []
    const snippetPattern = /<div[^>]*data-sncf[^>]*>([\s\S]*?)<\/div>/gi
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
