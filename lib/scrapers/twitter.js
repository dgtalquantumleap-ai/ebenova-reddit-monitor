// lib/scrapers/twitter.js — Twitter/X search via agent-twitter-client (CJS, dynamic import).
// Cookies are persisted to Upstash Redis ('twitter:cookies', 7-day TTL) to avoid
// re-logging in on every process restart.

import { Redis } from '@upstash/redis'
import { resolveKeyword } from '../reddit-rss.js'

const REDIS_KEY   = 'twitter:cookies'
const REDIS_TTL   = 7 * 24 * 60 * 60   // 7 days in seconds
const MAX_RESULTS = 15

let _scraper            = null
let _credsMissingLogged = false
let _redis              = null

function getRedis() {
  if (!_redis) {
    _redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  }
  return _redis
}

async function getScraper() {
  if (_scraper) return _scraper

  const username = process.env.TWITTER_USERNAME
  const password = process.env.TWITTER_PASSWORD

  if (!username || !password) {
    if (!_credsMissingLogged) {
      console.warn('[twitter] TWITTER_USERNAME or TWITTER_PASSWORD not set — skipping Twitter search')
      _credsMissingLogged = true
    }
    return null
  }

  const { Scraper } = await import('agent-twitter-client')
  const scraper = new Scraper()

  // Try cached cookies first.
  try {
    const redis   = getRedis()
    const stored  = await redis.get(REDIS_KEY)
    if (stored) {
      const cookies = Array.isArray(stored) ? stored : JSON.parse(stored)
      await scraper.setCookies(cookies)
      const loggedIn = await scraper.isLoggedIn()
      if (loggedIn) {
        _scraper = scraper
        return _scraper
      }
    }
  } catch (err) {
    console.warn(`[twitter] cookie restore failed: ${err.message}`)
  }

  // Fresh login.
  await scraper.login(username, password)

  // Persist fresh cookies.
  try {
    const cookies = await scraper.getCookies()
    await getRedis().set(REDIS_KEY, JSON.stringify(cookies), { ex: REDIS_TTL })
  } catch (err) {
    console.warn(`[twitter] cookie save failed: ${err.message}`)
  }

  _scraper = scraper
  return _scraper
}

export default async function searchTwitter(keywordEntry, ctx = {}) {
  const keyword    = resolveKeyword(keywordEntry)
  const seenIds    = ctx.seenIds    || { has: () => false, add: () => {} }
  const MAX_AGE_MS = ctx.MAX_AGE_MS || null
  const delay      = ctx.delay

  if (!keyword) return []

  try {
    const scraper = await getScraper()
    if (!scraper) return []

    const { SearchMode } = await import('agent-twitter-client')
    const response = await scraper.fetchSearchTweets(keyword, 20, SearchMode.Latest)
    const raw      = response?.tweets ?? []

    const cutoffMs = MAX_AGE_MS ? Date.now() - MAX_AGE_MS : null
    const results  = []

    for (const tweet of raw) {
      if (results.length >= MAX_RESULTS) break
      if (!tweet.id) continue

      if (cutoffMs && tweet.timeParsed) {
        if (new Date(tweet.timeParsed).getTime() < cutoffMs) continue
      }

      const id = `twitter_${tweet.id}`
      if (seenIds.has(id)) continue
      seenIds.add(id)

      results.push({
        id,
        title:     (tweet.text || '').slice(0, 120),
        url:       `https://x.com/${tweet.username}/status/${tweet.id}`,
        subreddit: 'Twitter',
        author:    tweet.username || 'unknown',
        score:     tweet.likes    || 0,
        comments:  tweet.replies  || 0,
        body:      (tweet.text || '').slice(0, 600),
        createdAt: tweet.timeParsed
          ? new Date(tweet.timeParsed).toISOString()
          : new Date().toISOString(),
        keyword:   keywordEntry.keyword,
        source:    'twitter',
        approved:  true,
      })
    }

    // Refresh cookie TTL after a successful search.
    try {
      const cookies = await scraper.getCookies()
      await getRedis().set(REDIS_KEY, JSON.stringify(cookies), { ex: REDIS_TTL })
    } catch (_) { /* non-fatal */ }

    if (typeof delay === 'function') await delay(2000)
    return results

  } catch (err) {
    const isAuth = err.status === 401 || err.status === 403 ||
      /auth|unauthorized|forbidden/i.test(err.message || '')

    if (isAuth) {
      console.warn(`[twitter] auth error — clearing session: ${err.message}`)
      try { await getRedis().del(REDIS_KEY) } catch (_) {}
      _scraper = null
    } else {
      console.warn(`[twitter] search error for "${keyword}": ${err.message}`)
    }
    return []
  }
}

export const _internals = {
  resetScraper:       () => { _scraper = null; _credsMissingLogged = false },
  _setScraperForTest: (mock) => { _scraper = mock },
}
