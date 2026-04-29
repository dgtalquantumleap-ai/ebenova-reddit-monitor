// lib/author-profiles.js — per-monitor author profile storage in Redis.
//
// Each unique (monitor, platform, author) tuple gets one hash:
//   key:    author:profile:{monitorId}:{platform}:{author}
//   fields: author, platform, firstSeen, lastSeen, postCount,
//           latestPostTitle, latestPostUrl, platforms (JSON array)
//
// Plus a per-monitor index set:
//   key: author:list:{monitorId}
//   members: "<platform>:<author>" — for listing all authors a monitor
//   has captured without a Redis SCAN.
//
// Authors that are obviously placeholder strings (the platform name itself,
// 'unknown', empty values) are skipped — they're noise, not real people, and
// would dilute the deduplication signal that downstream features (Builder
// Tracker, consistency scoring) build on.
//
// Storage is best-effort: Redis errors are logged and swallowed so monitor
// cycles don't fail because the profile sidecar broke.

const PLACEHOLDER_AUTHORS = new Set([
  'unknown',
  'reddit', 'hackernews', 'hn',
  'medium', 'substack',
  'quora', 'upwork', 'fiverr',
  'github', 'producthunt', 'ph',
  'twitter', 'linkedin',
])

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days — outlives match TTL (7d)
                                              // so a history can build up.

/**
 * Decide whether an `author` string from a scraper is a real username worth
 * tracking, or a generic placeholder we should drop.
 *
 * @param {string|null|undefined} author
 * @param {string|null|undefined} source - the platform key on the match
 * @returns {boolean} true if this is a placeholder we should skip
 */
export function isPlaceholderAuthor(author, source) {
  if (!author) return true
  const a = String(author).trim().toLowerCase()
  if (a.length < 2) return true
  if (PLACEHOLDER_AUTHORS.has(a)) return true
  if (source && a === String(source).trim().toLowerCase()) return true
  return false
}

/**
 * Record / increment an author profile entry for a single match.
 *
 * Idempotent at the Redis level: the same (monitorId, platform, author) tuple
 * always writes to the same hash. Counts are read-modify-write so two
 * concurrent monitor cycles for the same monitor MAY race; we accept that
 * imprecision in exchange for not requiring Lua. The set membership is
 * idempotent regardless.
 *
 * @returns {Promise<{ recorded: boolean, reason?: string, isNew?: boolean,
 *                     postCount?: number, error?: string }>}
 */
export async function recordAuthor({ redis, monitorId, match, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  if (!redis || !match || !monitorId) {
    return { recorded: false, reason: 'missing-args' }
  }

  const { author, source } = match
  if (isPlaceholderAuthor(author, source)) {
    return { recorded: false, reason: 'placeholder-author' }
  }

  const username = String(author).trim()
  const platform = String(source).trim().toLowerCase()
  const key = `author:profile:${monitorId}:${platform}:${username}`
  const indexKey = `author:list:${monitorId}`
  const now = match.createdAt || new Date().toISOString()

  try {
    const existing = (await redis.hgetall(key)) || {}
    const isNew = Object.keys(existing).length === 0

    const fields = {
      author: username,
      platform,
      lastSeen: now,
      latestPostTitle: (match.title || '').slice(0, 240),
      latestPostUrl: match.url || '',
    }

    if (isNew) {
      fields.firstSeen = now
      fields.postCount = '1'
      fields.platforms = JSON.stringify([platform])
    } else {
      const prevCount = parseInt(existing.postCount, 10) || 0
      fields.postCount = String(prevCount + 1)
      // Preserve firstSeen if it was set; backfill if a legacy entry lacks it.
      fields.firstSeen = existing.firstSeen || now
      // Preserve / extend platforms array (this scraper key always matches the
      // outer key's platform but we keep the field for cross-platform
      // aggregation later — see Builder Tracker).
      let prevPlatforms = []
      try { prevPlatforms = JSON.parse(existing.platforms || '[]') } catch (_) {}
      if (!Array.isArray(prevPlatforms)) prevPlatforms = []
      if (!prevPlatforms.includes(platform)) prevPlatforms.push(platform)
      fields.platforms = JSON.stringify(prevPlatforms)
    }

    await redis.hset(key, fields)
    await redis.expire(key, ttlSeconds)
    await redis.sadd(indexKey, `${platform}:${username}`)
    await redis.expire(indexKey, ttlSeconds)

    return { recorded: true, isNew, key, postCount: parseInt(fields.postCount, 10) }
  } catch (err) {
    console.warn(`[author-profile] error for ${username}@${platform}: ${err.message}`)
    return { recorded: false, reason: 'redis-error', error: err.message }
  }
}
