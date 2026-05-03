// lib/scrapers/indiehackers.js — Indie Hackers post discovery via DuckDuckGo.
//
// Uses site:indiehackers.com search on DuckDuckGo HTML endpoint.
// No auth, no API key required. Returns [] gracefully when DDG is blocked
// or returns no results for the keyword.
//
// Indie Hackers is React/Next.js with client-side search, so direct HTML
// scraping of their search page yields nothing useful. DDG is used as the
// indexing layer; it crawls IH posts and makes them keyword-searchable.

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
  if (/^https?:\/\/(?:www\.)?indiehackers\.com\//i.test(decoded)) return decoded
  return null
}

const SKIP_PATHS = /\/(feed|search|login|signup|settings|about|learn|podcast|newsletter|contribute|favicon|robots\.txt)/

export default async function searchIndieHackers(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const keyword = resolveKeyword(keywordEntry)
  if (!keyword) return []

  const results = []
  const query   = `site:indiehackers.com "${keyword}"`
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
        console.warn(`[indiehackers] DDG returned ${res.status} — returning []`)
        _blockedLogged = true
      }
      return results
    }

    const html = await res.text()
    if (html.includes('duckduckgo.com/d.js') || /Please enable JS/i.test(html)) {
      if (!_blockedLogged) {
        console.warn('[indiehackers] DDG JS-block detected — returning []')
        _blockedLogged = true
      }
      return results
    }

    const ihUrls = []
    const seenUrl = new Set()
    const hrefPat = /href="([^"]+)"/gi
    let hm
    while ((hm = hrefPat.exec(html)) !== null) {
      const href = hm[1]
      if (!/uddg=|indiehackers\.com/i.test(href)) continue
      const real = unwrapDuckUrl(href)
      if (!real || !real.includes('indiehackers.com/')) continue
      if (SKIP_PATHS.test(real)) continue
      if (seenUrl.has(real)) continue
      seenUrl.add(real)
      ihUrls.push(real)
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

    for (let i = 0; i < ihUrls.length && results.length < MAX_RESULTS; i++) {
      const link = ihUrls[i]
      const id   = hashUrlToId(link, 'indiehackers')
      if (seenIds.has(id)) continue
      seenIds.add(id)

      results.push({
        id,
        title:     (titles[i]   || keyword).slice(0, 200),
        url:       link,
        subreddit: 'Indie Hackers',
        author:    'indiehackers',
        score:     0,
        comments:  0,
        body:      (snippets[i] || '').slice(0, 600),
        createdAt: new Date().toISOString(),
        keyword,
        source:    'indiehackers',
        approved:  true,
      })
    }
  } catch (err) {
    console.warn(`[indiehackers] error for "${keyword}": ${err.message}`)
  }

  if (delay) await delay(2000)
  return results
}

export const _internals = {
  MAX_RESULTS,
  TIMEOUT_MS,
  resetBlockedLog: () => { _blockedLogged = false },
}
