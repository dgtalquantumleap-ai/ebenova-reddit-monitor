// lib/scrapers/stackoverflow.js — Stack Overflow search via Stack Exchange API v2.3.
//
// Public API, no auth required. Optional STACK_APPS_KEY raises quota from
// 300 to 10 000 requests/day. Responses are gzip-compressed; Node 18+ fetch
// decompresses automatically.
//
// Docs: https://api.stackexchange.com/docs/search

import { fetchWithBackoff } from './_fetch-backoff.js'
import { resolveKeyword } from '../reddit-rss.js'

const UA          = 'Mozilla/5.0 (compatible; EbenovaBot/2.0)'
const MAX_RESULTS = 15
const TIMEOUT_MS  = 8_000

let _quotaWarnedZero = false

export default async function searchStackOverflow(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const keyword = resolveKeyword(keywordEntry)
  if (!keyword) return []

  const results  = []
  const ageMs    = MAX_AGE_MS || (24 * 60 * 60 * 1000)
  const since    = Math.floor((Date.now() - ageMs) / 1000)
  const keyParam = process.env.STACK_APPS_KEY
    ? `&key=${encodeURIComponent(process.env.STACK_APPS_KEY)}`
    : ''
  const url = [
    'https://api.stackexchange.com/2.3/search/advanced',
    `?order=desc&sort=creation`,
    `&q=${encodeURIComponent(keyword)}`,
    `&site=stackoverflow`,
    `&filter=withbody`,
    `&pagesize=${MAX_RESULTS}`,
    `&fromdate=${since}`,
    keyParam,
  ].join('')

  try {
    const res = await fetchWithBackoff(url, {
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res || !res.ok) {
      if (res) console.warn(`[stackoverflow] ${res.status} for "${keyword}"`)
      return results
    }

    const data = await res.json()

    if (data.quota_remaining === 0 && !_quotaWarnedZero) {
      console.warn('[stackoverflow] daily quota exhausted — set STACK_APPS_KEY for 10k/day limit')
      _quotaWarnedZero = true
    }

    for (const item of (data.items || [])) {
      if (results.length >= MAX_RESULTS) break

      const id = `stackoverflow_${item.question_id}`
      if (seenIds.has(id)) continue
      seenIds.add(id)

      const createdAt = new Date(item.creation_date * 1000)
      if (MAX_AGE_MS && createdAt.getTime() < Date.now() - MAX_AGE_MS) continue

      const body = (item.body || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600)

      results.push({
        id,
        title:     item.title     || '(no title)',
        url:       item.link,
        subreddit: 'Stack Overflow',
        author:    item.owner?.display_name || 'unknown',
        score:     item.score        || 0,
        comments:  item.answer_count || 0,
        body,
        createdAt: createdAt.toISOString(),
        keyword,
        source:    'stackoverflow',
        approved:  true,
      })
    }
  } catch (err) {
    console.warn(`[stackoverflow] fetch error for "${keyword}": ${err.message}`)
  }

  if (delay) await delay(1500)
  return results
}

export const _internals = {
  MAX_RESULTS,
  TIMEOUT_MS,
  resetQuotaWarn: () => { _quotaWarnedZero = false },
}
