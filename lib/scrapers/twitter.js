// lib/scrapers/twitter.js — Twitter/X search via Nitter RSS (no auth required).
//
// agent-twitter-client requires Twitter login which returns error code 34
// (login endpoint changed/removed). Nitter RSS is the no-auth fallback:
// public Twitter frontend with RSS feeds.
// URL pattern: https://{instance}/search/rss?q={keyword}&f=tweets
//
// Three fallback instances are tried in order. If all fail, we log once and
// return [] gracefully — the monitor cycle continues without Twitter data.

import { hashUrlToId } from './_id.js'
import { resolveKeyword } from '../reddit-rss.js'

const TIMEOUT_MS = 10_000
const MAX_RESULTS = 15
const INSTANCES = [
  'nitter.poast.org',
  'nitter.privacydev.net',
  'nitter.1d4.us',
]

let _allDownLogged = false

function decodeHtmlEntities(s) {
  if (!s) return ''
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
}

function stripHtmlTags(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

// Parse Nitter RSS 2.0 XML into match records.
// Nitter item shape: <title>@user: text</title>, <link>nitter/user/status/ID#m</link>
export function parseNitterRSS(xml, keyword, seenIds, MAX_AGE_MS) {
  const results = []
  const itemPattern = /<item>([\s\S]*?)<\/item>/g
  const cutoffMs = Date.now() - (MAX_AGE_MS || 0)
  let m
  while ((m = itemPattern.exec(xml)) !== null && results.length < MAX_RESULTS) {
    const block = m[1]

    const titleRaw = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                     block.match(/<title>([\s\S]*?)<\/title>/))?.[1] || ''
    const linkRaw  = (block.match(/<link>([\s\S]*?)<\/link>/) ||
                     block.match(/<link\s+[^>]*href="([^"]+)"/))?.[1]?.trim() || ''
    const pubRaw   = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || ''
    const creatorRaw = (block.match(/<dc:creator><!\[CDATA\[([\s\S]*?)\]\]><\/dc:creator>/) ||
                       block.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/))?.[1] || ''
    const descRaw  = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                     block.match(/<description>([\s\S]*?)<\/description>/))?.[1] || ''

    if (!linkRaw) continue

    // Convert Nitter URL → canonical x.com URL.
    // Nitter: https://nitter.instance/username/status/12345#m
    const statusMatch = linkRaw.match(/\/([^/]+)\/status\/(\d+)/)
    if (!statusMatch) continue
    const [, username, statusId] = statusMatch
    const canonicalUrl = `https://x.com/${username}/status/${statusId}`

    const pubDate = pubRaw ? new Date(pubRaw) : null
    if (MAX_AGE_MS && pubDate && Number.isFinite(pubDate.getTime()) && pubDate.getTime() < cutoffMs) continue

    const id = hashUrlToId(canonicalUrl, 'twitter')
    if (seenIds.has(id)) continue
    seenIds.add(id)

    // Title: "@username: tweet text" — strip the "@username: " prefix
    const titleDecoded = decodeHtmlEntities(titleRaw)
    const titleText = titleDecoded.replace(/^@\w+:\s*/, '').trim()
    const body = stripHtmlTags(decodeHtmlEntities(descRaw || titleRaw)).slice(0, 600)
    const author = (creatorRaw || username).replace(/^@/, '').trim()

    results.push({
      id,
      title:     (titleText || body).slice(0, 120),
      url:       canonicalUrl,
      subreddit: 'Twitter',
      author,
      score:     0,
      comments:  0,
      body,
      createdAt: (pubDate && Number.isFinite(pubDate.getTime()))
        ? pubDate.toISOString()
        : new Date().toISOString(),
      keyword,
      source:    'twitter',
      approved:  true,
    })
  }
  return results
}

export default async function searchTwitter(keywordEntry, ctx = {}) {
  const keyword    = resolveKeyword(keywordEntry)
  const seenIds    = ctx.seenIds    || { has: () => false, add: () => {} }
  const MAX_AGE_MS = ctx.MAX_AGE_MS || 24 * 60 * 60 * 1000
  const results    = []
  if (!keyword) return results
  // If all instances failed on a previous keyword this cycle, skip immediately
  // rather than burning TIMEOUT_MS × 3 on every remaining keyword.
  if (_allDownLogged) return results

  const query = encodeURIComponent(keyword)

  for (const instance of INSTANCES) {
    const url = `https://${instance}/search/rss?q=${query}&f=tweets`
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) {
        console.warn(`[twitter] ${instance} returned ${res.status} for "${keyword}" — trying next`)
        continue
      }
      const xml = await res.text()
      if (!xml.includes('<item>')) return results  // empty feed — no results, not an error

      const parsed = parseNitterRSS(xml, keyword, seenIds, MAX_AGE_MS)
      results.push(...parsed)
      if (typeof ctx.delay === 'function') await ctx.delay(1000)
      return results
    } catch (err) {
      console.warn(`[twitter] ${instance} error for "${keyword}": ${err.message} — trying next`)
    }
  }

  if (!_allDownLogged) {
    console.warn('[twitter] all Nitter instances failed — returning [] for this cycle')
    _allDownLogged = true
  }
  return results
}

export const _internals = {
  INSTANCES, TIMEOUT_MS, MAX_RESULTS,
  parseNitterRSS,
  resetAllDownLogged: () => { _allDownLogged = false },
}
