// lib/scrapers/telegram.js — Public Telegram channel scraper via t.me/s/{channel}.
// No auth or API key required. One GET per channel per cycle; keyword matching
// is done client-side since there is no server-side search API.
// Returns [] gracefully on any fetch/parse failure — channel is skipped.

import { hashUrlToId } from './_id.js'

const TIMEOUT_MS = 10_000
const MAX_RESULTS = 15
const UA = 'Mozilla/5.0 (compatible; EbenovaBot/2.0)'

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

export function parseTelegramHTML(html, channel, allKeywords, seenIds, MAX_AGE_MS) {
  const results = []
  const cutoffMs = Date.now() - (MAX_AGE_MS || 0)
  const msgPattern = /<div[^>]*class="[^"]*tgme_widget_message[^"]*"[^>]*data-post="[^/]+\/(\d+)"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g

  let m
  while ((m = msgPattern.exec(html)) !== null && results.length < MAX_RESULTS) {
    const [, postId, block] = m

    const bodyMatch = block.match(/<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    const body = stripHtml(bodyMatch?.[1] || '').slice(0, 600)
    if (!body) continue

    const dateMatch = block.match(/<time[^>]+datetime="([^"]+)"/)
    const pubRaw = dateMatch?.[1] || ''
    const pubDate = pubRaw ? new Date(pubRaw) : null
    if (MAX_AGE_MS && pubDate && Number.isFinite(pubDate.getTime()) && pubDate.getTime() < cutoffMs) continue

    const url = `https://t.me/${channel}/${postId}`
    const id  = hashUrlToId(url, 'telegram')
    if (seenIds.has(id)) continue

    const searchText = body.toLowerCase()
    const matchedKeyword = allKeywords.find(kw => searchText.includes(kw.toLowerCase()))
    if (!matchedKeyword) continue

    seenIds.add(id)
    results.push({
      id,
      title:     body.slice(0, 120),
      url,
      subreddit: `@${channel}`,
      author:    channel,
      score:     0,
      comments:  0,
      body,
      createdAt: (pubDate && Number.isFinite(pubDate.getTime()))
        ? pubDate.toISOString()
        : new Date().toISOString(),
      keyword:   matchedKeyword,
      source:    'telegram',
      approved:  true,
    })
  }
  return results
}

export default async function searchTelegram(keywordEntry, ctx = {}) {
  const { seenIds = { has: () => false, add: () => {} }, MAX_AGE_MS, allKeywords = [], telegramChannels = [], delay } = ctx
  if (!telegramChannels.length || !allKeywords.length) return []

  const results = []
  for (const channel of telegramChannels) {
    if (results.length >= MAX_RESULTS) break
    const handle = channel.replace(/^@/, '')
    try {
      const res = await fetch(`https://t.me/s/${handle}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        console.warn(`[telegram] @${handle} returned ${res.status} — skipping`)
        continue
      }
      const html = await res.text()
      const parsed = parseTelegramHTML(html, handle, allKeywords, seenIds, MAX_AGE_MS)
      results.push(...parsed)
      if (delay) await delay(1000)
    } catch (err) {
      console.warn(`[telegram] @${handle} error: ${err.message} — skipping`)
    }
  }
  return results.slice(0, MAX_RESULTS)
}

export const _internals = { TIMEOUT_MS, MAX_RESULTS, parseTelegramHTML }
