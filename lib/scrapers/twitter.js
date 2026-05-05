// lib/scrapers/twitter.js — Twitter/X search via agent-twitter-client.
//
// Lazy singleton: one Scraper instance per process, cookies persisted in
// Upstash Redis (key 'twitter:cookies', 7-day TTL) so restarts don't
// re-login on every cycle.
//
// Credentials required: TWITTER_USERNAME + TWITTER_PASSWORD env vars.
// If absent, logs once and returns [] on every call.
//
// ESM/CJS interop: agent-twitter-client is CommonJS — always dynamic-imported.

import { Redis } from '@upstash/redis'
import { resolveKeyword } from '../reddit-rss.js'

const MAX_RESULTS = 15
const COOKIE_KEY  = 'twitter:cookies'
const COOKIE_TTL  = 604800 // 7 days

let _Scraper   = null
let _SearchMode = null
let _instance  = null
let _warnedNoCredentials = false

function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  return new Redis({ url, token })
}

async function loadLib() {
  if (_Scraper) return
  const lib = await import('agent-twitter-client')
  _Scraper    = lib.Scraper    || lib.default?.Scraper
  _SearchMode = lib.SearchMode || lib.default?.SearchMode
}

async function getInstance() {
  const user = process.env.TWITTER_USERNAME
  const pass = process.env.TWITTER_PASSWORD
  if (!user || !pass) {
    if (!_warnedNoCredentials) {
      console.warn('[twitter] TWITTER_USERNAME or TWITTER_PASSWORD not set — skipping Twitter scrape')
      _warnedNoCredentials = true
    }
    return null
  }

  if (_instance) return _instance

  try {
    await loadLib()
    const redis  = getRedis()
    const scraper = new _Scraper()

    if (redis) {
      const stored = await redis.get(COOKIE_KEY).catch(() => null)
      if (stored) {
        const cookies = typeof stored === 'string' ? JSON.parse(stored) : stored
        await scraper.setCookies(cookies)
      } else {
        await scraper.login(user, pass)
        const fresh = await scraper.getCookies().catch(() => null)
        if (fresh) {
          redis.set(COOKIE_KEY, JSON.stringify(fresh), { ex: COOKIE_TTL }).catch(() => {})
        }
      }
    } else {
      await scraper.login(user, pass)
    }

    _instance = scraper
    return _instance
  } catch (err) {
    console.error('[twitter] getInstance failed:', err.message)
    return null
  }
}

function refreshCookies(scraper) {
  const redis = getRedis()
  if (!redis) return
  scraper.getCookies()
    .then(c => c && redis.set(COOKIE_KEY, JSON.stringify(c), { ex: COOKIE_TTL }))
    .catch(() => {})
}

function isAuthError(err) {
  return /auth|login|401|403|session/i.test(err?.message || '')
}

export default async function searchTwitter(keywordEntry, { seenIds, delay, MAX_AGE_MS } = {}) {
  const keyword    = resolveKeyword(keywordEntry)
  const _seenIds   = seenIds   || { has: () => false, add: () => {} }
  const _maxAgeMs  = MAX_AGE_MS || 24 * 60 * 60 * 1000
  const results    = []

  if (!keyword) return results

  let scraper
  try {
    scraper = await getInstance()
    if (!scraper) return results
  } catch (err) {
    console.error('[twitter] getInstance threw:', err.message)
    return results
  }

  try {
    const tweets = await scraper.fetchSearchTweets(keyword, 20, _SearchMode.Latest)
    const cutoff  = Date.now() - _maxAgeMs

    for (const tweet of tweets?.tweets || []) {
      if (results.length >= MAX_RESULTS) break
      if (!tweet?.id) continue

      const id = `twitter_${tweet.id}`
      if (_seenIds.has(id)) continue

      const createdAt = tweet.timeParsed
        ? new Date(tweet.timeParsed).toISOString()
        : new Date().toISOString()
      if (new Date(createdAt).getTime() < cutoff) continue

      _seenIds.add(id)
      results.push({
        id,
        title:     (tweet.text || '').slice(0, 120),
        url:       `https://x.com/${tweet.username}/status/${tweet.id}`,
        subreddit: 'Twitter',
        author:    tweet.username || 'unknown',
        score:     tweet.likes    || 0,
        comments:  tweet.replies  || 0,
        body:      (tweet.text    || '').slice(0, 600),
        createdAt,
        keyword,
        source:    'twitter',
        approved:  true,
      })
    }

    refreshCookies(scraper)
  } catch (err) {
    if (isAuthError(err)) {
      console.warn('[twitter] auth error — clearing cookie cache and resetting instance')
      _instance = null
      const redis = getRedis()
      if (redis) redis.del(COOKIE_KEY).catch(() => {})
    } else {
      console.error('[twitter] fetchSearchTweets failed:', err.message)
    }
    return []
  }

  if (typeof delay === 'function') await delay(2000)
  return results
}

export const _internals = {
  resetInstance:      () => { _instance = null },
  // kept for test backward-compatibility (platform-audit.test.js test 8)
  resetAllDownLogged: () => {},
}
