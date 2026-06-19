// lib/reddit-cache.js — Redis-backed short-TTL cache for Reddit RSS search
// results. Each (keyword, subreddit, type) search is cached so consecutive poll
// cycles reuse the parsed entries instead of re-fetching. This cuts the request
// volume that triggers Reddit's anonymous-IP 429s — every cache hit is one
// fewer outbound request against the ~10 req/min anonymous ceiling.
//
// Stores the PARSED RSS entries (pre-dedup). The caller still runs its seen/age
// filter on a cache hit (see processEntries in monitor-v2.js), so nothing is
// double-emitted; the only effect is up to TTL seconds of staleness, which is
// fine for monitoring. Factory shape mirrors lib/find-cache.js.

import { createHash } from 'node:crypto'

const DEFAULT_TTL_SECONDS = parseInt(process.env.REDDIT_SEARCH_CACHE_TTL_SEC || '900') // 15 min
const KEY_PREFIX = 'reddit:search:v1:'

// Stable, normalized cache key from the search params. Hashed so arbitrary
// keyword text can never break the Redis key format.
export function searchCacheKey({ keyword, subreddit = null, type = 'keyword' } = {}) {
  const basis = [
    type || 'keyword',
    subreddit ? String(subreddit).toLowerCase().replace(/^r\//, '') : '_',
    String(keyword || '').toLowerCase().trim(),
  ].join('|')
  return KEY_PREFIX + createHash('sha1').update(basis).digest('hex')
}

export function makeRedditCache(redis, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  return {
    /** @returns {Promise<Array|null>} cached parsed entries, or null on miss. */
    async get(params) {
      if (!redis) return null
      try {
        const raw = await redis.get(searchCacheKey(params))
        if (!raw) return null
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        return Array.isArray(parsed?.entries) ? parsed.entries : null
      } catch {
        return null
      }
    },

    /** Best-effort store; Redis failures are swallowed (cache is optional). */
    async set(params, entries) {
      if (!redis || !Array.isArray(entries)) return
      try {
        const k = searchCacheKey(params)
        await redis.set(k, JSON.stringify({ entries, cachedAt: new Date().toISOString() }))
        await redis.expire(k, ttlSeconds)
      } catch {
        /* cache is best-effort — a miss next time is harmless */
      }
    },
  }
}
