// lib/scrapers/rss.js — RSS 2.0 and Atom feed scraper (no auth required).
// Fetches user-configured feeds and matches posts client-side against all
// monitor keywords. Supports both RSS 2.0 (<item>) and Atom (<entry>) formats.
// Returns [] gracefully on any fetch/parse failure — the monitor cycle continues.
import { hashUrlToId } from './_id.js'

const TIMEOUT_MS = 10_000
const MAX_RESULTS = 15

export const CURATED_FEEDS = []

function decodeHtmlEntities(s) {
  if (!s) return ''
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

export function parseRSSFeed(xml, allKeywords, seenIds, MAX_AGE_MS, feedUrl) {
  const results = []
  const cutoffMs = Date.now() - (MAX_AGE_MS || 0)
  const hostname = (() => { try { return new URL(feedUrl).hostname } catch { return feedUrl || 'rss' } })()

  const isAtom = /<feed[\s>]/.test(xml) || /xmlns[^>]*Atom/i.test(xml)
  const itemTag = isAtom ? 'entry' : 'item'
  const itemPattern = new RegExp(`<${itemTag}>([\\s\\S]*?)<\\/${itemTag}>`, 'g')

  let m
  while ((m = itemPattern.exec(xml)) !== null && results.length < MAX_RESULTS) {
    const block = m[1]

    const titleRaw = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                     block.match(/<title[^>]*>([\s\S]*?)<\/title>/))?.[1] || ''

    let linkRaw = ''
    if (isAtom) {
      linkRaw = block.match(/<link[^>]+href="([^"]+)"/)?.[1] ||
                block.match(/<id>(https?:\/\/[^<]+)<\/id>/)?.[1] || ''
    } else {
      linkRaw = (block.match(/<link>([\s\S]*?)<\/link>/) ||
                block.match(/<link\s+[^>]*href="([^"]+)"/))?.[1]?.trim() || ''
    }
    if (!linkRaw) continue

    const bodyBlock = isAtom
      ? (block.match(/<content[^>]*>([\s\S]*?)<\/content>/) || block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/))
      : (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || block.match(/<description>([\s\S]*?)<\/description>/))
    const bodyRaw = bodyBlock?.[1] || ''

    const dateBlock = isAtom
      ? (block.match(/<published>([\s\S]*?)<\/published>/) || block.match(/<updated>([\s\S]*?)<\/updated>/))
      : block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)
    const pubRaw = dateBlock?.[1]?.trim() || ''

    const authorRaw = (block.match(/<dc:creator><!\[CDATA\[([\s\S]*?)\]\]><\/dc:creator>/) ||
                      block.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/) ||
                      block.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/))?.[1] || ''

    const pubDate = pubRaw ? new Date(pubRaw) : null
    if (MAX_AGE_MS && pubDate && Number.isFinite(pubDate.getTime()) && pubDate.getTime() < cutoffMs) continue

    const id = hashUrlToId(linkRaw.trim(), 'rss')
    if (seenIds.has(id)) continue

    const title = stripHtml(decodeHtmlEntities(titleRaw)).slice(0, 120)
    const body  = stripHtml(decodeHtmlEntities(bodyRaw)).slice(0, 600)
    const searchText = `${title} ${body}`.toLowerCase()

    const matchedKeyword = allKeywords.find(kw => searchText.includes(kw.toLowerCase()))
    if (!matchedKeyword) continue

    seenIds.add(id)
    results.push({
      id,
      title:     title || body.slice(0, 120),
      url:       linkRaw.trim(),
      subreddit: hostname,
      author:    stripHtml(decodeHtmlEntities(authorRaw)) || hostname,
      score:     0,
      comments:  0,
      body,
      createdAt: (pubDate && Number.isFinite(pubDate.getTime()))
        ? pubDate.toISOString()
        : new Date().toISOString(),
      keyword:   matchedKeyword,
      source:    'rss',
      approved:  true,
    })
  }
  return results
}

export default async function searchRSS(keywordEntry, ctx = {}) {
  const { seenIds = { has: () => false, add: () => {} }, MAX_AGE_MS, allKeywords = [], rssFeeds = [], delay } = ctx
  const feeds = [...CURATED_FEEDS, ...rssFeeds]
  if (!feeds.length || !allKeywords.length) return []

  const results = []
  for (const feedUrl of feeds) {
    if (results.length >= MAX_RESULTS) break
    try {
      const res = await fetch(feedUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) {
        console.warn(`[rss] ${feedUrl} returned ${res.status} — skipping`)
        continue
      }
      const xml = await res.text()
      const parsed = parseRSSFeed(xml, allKeywords, seenIds, MAX_AGE_MS, feedUrl)
      results.push(...parsed)
      if (delay) await delay(1000)
    } catch (err) {
      console.warn(`[rss] ${feedUrl} error: ${err.message} — skipping`)
    }
  }
  return results.slice(0, MAX_RESULTS)
}

export const _internals = { TIMEOUT_MS, MAX_RESULTS, parseRSSFeed }
