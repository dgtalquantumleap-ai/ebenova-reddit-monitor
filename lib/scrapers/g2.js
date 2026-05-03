// lib/scrapers/g2.js — G2 review discovery via DuckDuckGo.
//
// Uses site:g2.com/reviews search on DuckDuckGo HTML endpoint.
// No auth, no API key required. Returns [] gracefully when DDG is blocked
// or returns no results for the keyword.
//
// G2 review pages (g2.com/products/{slug}/reviews) are well-indexed by DDG.
// We find review pages that mention the keyword in title/snippet. This surfaces
// conversations from real B2B software buyers — high-signal for competitor
// mentions, category pain points, and "looking for alternative" intent.

import { hashUrlToId } from './_id.js'
import { resolveKeyword } from '../reddit-rss.js'

const UA          = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MAX_RESULTS = 10
const TIMEOUT_MS  = 10_000

let _blockedLogged = false

function htmlDecode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function stripTags(s) {
  return htmlDecode(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function unwrapDuckUrl(href) {
  if (!href) return null
  const decoded = htmlDecode(href)
  const m = decoded.match(/[?&]uddg=([^&"']+)/)
  if (m) {
    try { return decodeURIComponent(m[1]) } catch { return null }
  }
  if (/^https?:\/\/(?:www\.)?g2\.com\//i.test(decoded)) return decoded
  return null
}

export default async function searchG2(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const keyword = resolveKeyword(keywordEntry)
  if (!keyword) return []

  const results = []
  // Scope to g2.com/products (review sub-pages) for high-signal buyer content.
  const query   = `site:g2.com/products "${keyword}"`
  const url     = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':      UA,
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!res.ok) {
      if (!_blockedLogged) {
        console.warn(`[g2] DDG returned ${res.status} — returning []`)
        _blockedLogged = true
      }
      return results
    }

    const html = await res.text()
    if (html.includes('duckduckgo.com/d.js') || /Please enable JS/i.test(html)) {
      if (!_blockedLogged) {
        console.warn('[g2] DDG JS-block detected — returning []')
        _blockedLogged = true
      }
      return results
    }

    const g2Urls = []
    const seenUrl = new Set()
    const hrefPat = /href="([^"]+)"/gi
    let hm
    while ((hm = hrefPat.exec(html)) !== null) {
      const href = hm[1]
      if (!/uddg=|g2\.com/i.test(href)) continue
      const real = unwrapDuckUrl(href)
      if (!real || !real.includes('g2.com/')) continue
      if (seenUrl.has(real)) continue
      seenUrl.add(real)
      g2Urls.push(real)
    }

    const titles = []
    const titlePat = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/gi
    let tm
    while ((tm = titlePat.exec(html)) !== null) {
      const t = stripTags(tm[1])
      if (t) titles.push(t)
    }

    const snippets = []
    const snippetPat = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
    let sm
    while ((sm = snippetPat.exec(html)) !== null) {
      const s = stripTags(sm[1])
      if (s) snippets.push(s)
    }

    for (let i = 0; i < g2Urls.length && results.length < MAX_RESULTS; i++) {
      const link = g2Urls[i]
      const id   = hashUrlToId(link, 'g2')
      if (seenIds.has(id)) continue
      seenIds.add(id)

      results.push({
        id,
        title:     (titles[i]   || keyword).slice(0, 200),
        url:       link,
        subreddit: 'G2 Reviews',
        author:    'g2',
        score:     0,
        comments:  0,
        body:      (snippets[i] || '').slice(0, 600),
        createdAt: new Date().toISOString(),
        keyword,
        source:    'g2',
        approved:  true,
      })
    }
  } catch (err) {
    console.warn(`[g2] error for "${keyword}": ${err.message}`)
  }

  if (delay) await delay(2000)
  return results
}

export const _internals = {
  MAX_RESULTS,
  TIMEOUT_MS,
  resetBlockedLog: () => { _blockedLogged = false },
}
