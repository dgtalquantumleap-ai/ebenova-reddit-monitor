// lib/scrapers/twitter.js — Twitter/X search via agent-twitter-client.
// Uses Twitter's internal GraphQL API; no paid API, no Puppeteer/Playwright.
//
// Session is cached two ways:
//   1. Module scope (in-memory): the Scraper instance survives across calls
//      within one process so we don't re-login per keyword.
//   2. Redis key "twitter:cookies" (7-day TTL): the cookie jar survives across
//      Railway container restarts, so we don't trip account-lock heuristics
//      by re-logging-in from scratch every deploy.
//
// agent-twitter-client ships as CommonJS — we load it with dynamic import()
// so this ESM module doesn't require interop tweaks at startup.

import { Redis } from '@upstash/redis'

const COOKIE_KEY = 'twitter:cookies'
const COOKIE_TTL = 60 * 60 * 24 * 7 // 7 days

let _Scraper = null
let _SearchMode = null
let _scraperInstance = null
let _loginAttempted = false
let _loginOk = false
let _missingCredsLogged = false

function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  try { return new Redis({ url, token }) } catch { return null }
}

async function loadPkg() {
  if (_Scraper && _SearchMode) return
  const pkg = await import('agent-twitter-client')
  _Scraper    = pkg.Scraper
  _SearchMode = pkg.SearchMode
}

async function persistCookies(scraper, redis) {
  if (!redis) return
  try {
    const cookies = await scraper.getCookies()
    if (cookies) {
      await redis.set(COOKIE_KEY, JSON.stringify(cookies), { ex: COOKIE_TTL })
    }
  } catch (err) {
    console.warn(`[twitter] persist cookies failed: ${err.message}`)
  }
}

async function getScraper() {
  const username = process.env.TWITTER_USERNAME
  const password = process.env.TWITTER_PASSWORD
  if (!username || !password) {
    if (!_missingCredsLogged) {
      console.warn('[twitter] TWITTER_USERNAME / TWITTER_PASSWORD not set — skipping Twitter scraper')
      _missingCredsLogged = true
    }
    return null
  }

  if (_scraperInstance && _loginOk) return _scraperInstance
  if (_loginAttempted && !_loginOk) return null

  _loginAttempted = true

  await loadPkg()
  const scraper = new _Scraper()
  const redis = getRedis()

  // Try restoring a saved session first.
  if (redis) {
    try {
      const stored = await redis.get(COOKIE_KEY)
      if (stored) {
        const cookies = typeof stored === 'string' ? JSON.parse(stored) : stored
        await scraper.setCookies(cookies)
        _scraperInstance = scraper
        _loginOk = true
        return _scraperInstance
      }
    } catch (err) {
      console.warn(`[twitter] restore cookies failed: ${err.message}`)
    }
  }

  // No cached session — log in fresh, then persist the cookies.
  try {
    await scraper.login(username, password)
    _scraperInstance = scraper
    _loginOk = true
    await persistCookies(scraper, redis)
    return _scraperInstance
  } catch (err) {
    console.warn(`[twitter] login failed: ${err.message}`)
    _loginOk = false
    return null
  }
}

function isAuthError(err) {
  const m = (err?.message || '').toLowerCase()
  return m.includes('auth') || m.includes('login') || m.includes('401') || m.includes('403')
}

async function clearSession() {
  _scraperInstance = null
  _loginOk = false
  _loginAttempted = false
  const redis = getRedis()
  if (redis) {
    try { await redis.del(COOKIE_KEY) } catch (_) {}
  }
}

export default async function searchTwitter(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword } = keywordEntry
  const results = []

  let scraper
  try {
    scraper = await getScraper()
  } catch (err) {
    console.warn(`[twitter] error for "${keyword}": ${err.message}`)
    if (delay) await delay(2000)
    return []
  }
  if (!scraper) {
    if (delay) await delay(2000)
    return []
  }

  try {
    const searchMode = _SearchMode
    const tweetsIter = await scraper.fetchSearchTweets(keyword, 20, searchMode.Latest)
    const tweets = Array.isArray(tweetsIter?.tweets) ? tweetsIter.tweets : (tweetsIter?.tweets || [])

    for (const tweet of tweets) {
      if (!tweet || !tweet.id) continue
      const id = `twitter_${tweet.id}`
      if (seenIds.has(id)) continue

      const createdAt = tweet.timeParsed instanceof Date
        ? tweet.timeParsed
        : (tweet.timeParsed ? new Date(tweet.timeParsed) : new Date())
      if (MAX_AGE_MS && Date.now() - createdAt.getTime() > MAX_AGE_MS) continue

      seenIds.add(id)
      const text = (tweet.text || '').toString()
      results.push({
        id,
        title:     text.slice(0, 120),
        url:       `https://x.com/${tweet.username}/status/${tweet.id}`,
        subreddit: 'Twitter',
        author:    tweet.username || 'unknown',
        score:     tweet.likes || 0,
        comments:  tweet.replies || 0,
        body:      text.slice(0, 600),
        createdAt: createdAt.toISOString(),
        keyword,
        source:    'twitter',
        approved:  true,
      })

      if (results.length >= 15) break
    }

    // Refresh cookies on a successful call so the saved session stays alive.
    if (results.length > 0 || tweets.length > 0) {
      await persistCookies(scraper, getRedis())
    }
  } catch (err) {
    console.warn(`[twitter] error for "${keyword}": ${err.message}`)
    if (isAuthError(err)) {
      await clearSession()
    }
    if (delay) await delay(2000)
    return []
  }

  if (delay) await delay(2000)
  return results
}
