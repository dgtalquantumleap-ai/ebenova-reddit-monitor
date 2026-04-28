// lib/find-cache.js — Redis-backed cache for /v1/find/preview-counts results.
// Keyword counts are expensive to compute (live HTTP to Reddit + HN); caching
// for 1h with normalized lowercase keys lets multiple users share results
// when their suggested keywords overlap.

const TTL_SECONDS = 3600 // 1 hour
const KEY_PREFIX = 'findcache:'

const normalize = (kw) => String(kw || '').toLowerCase().trim()

export function makeFindCache(redis) {
  return {
    async get(keyword) {
      const k = KEY_PREFIX + normalize(keyword)
      const raw = await redis.get(k)
      if (!raw) return null
      try { return typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null }
    },

    async set(keyword, value) {
      const k = KEY_PREFIX + normalize(keyword)
      const v = JSON.stringify({ ...value, cachedAt: new Date().toISOString() })
      await redis.set(k, v)
      await redis.expire(k, TTL_SECONDS)
    },

    async getMany(keywords) {
      const result = {}
      for (const kw of keywords) {
        result[kw] = await this.get(kw)
      }
      return result
    },
  }
}
