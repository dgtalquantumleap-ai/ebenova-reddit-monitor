// lib/keyword-health.js — per-keyword match stats across monitor runs.
//
// Key: insights:kw_health:{monitorId} — JSON object keyed by keyword string.
// Each entry tracks: firstSeenAt (when health tracking started for this kw),
// lastMatchAt (last time it produced a match), totalMatches (lifetime count).
// TTL 90 days, refreshed on every write.
//
// Stale = keyword has been tracked for ≥staleDays AND hasn't matched in that window.

const KEY = (monitorId) => `insights:kw_health:${monitorId}`
const TTL = 90 * 24 * 60 * 60  // 90 days

/**
 * Update health stats after a monitor run.
 * @param {object} redis
 * @param {string} monitorId
 * @param {Map<string, number>} matchesByKeyword  keyword → match count this cycle
 */
export async function updateKeywordHealth(redis, monitorId, matchesByKeyword) {
  try {
    const raw = await redis.get(KEY(monitorId))
    const health = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {}
    const now = new Date().toISOString()
    for (const [kw, count] of matchesByKeyword) {
      if (!health[kw]) health[kw] = { firstSeenAt: now, lastMatchAt: null, totalMatches: 0 }
      health[kw].totalMatches = (health[kw].totalMatches || 0) + count
      if (count > 0) health[kw].lastMatchAt = now
    }
    await redis.set(KEY(monitorId), JSON.stringify(health))
    await redis.expire(KEY(monitorId), TTL)
  } catch (err) {
    console.warn(`[kw-health] update failed for ${monitorId}:`, err.message)
  }
}

/**
 * Read the full health object for a monitor.
 */
export async function getKeywordHealth(redis, monitorId) {
  try {
    const raw = await redis.get(KEY(monitorId))
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {}
  } catch {
    return {}
  }
}

/**
 * Return keywords that have been tracked for ≥staleDays but produced no
 * match in that window. Keywords never seen in health data are excluded
 * (they may predate health tracking — we don't retroactively flag them).
 *
 * @param {object} health  result of getKeywordHealth
 * @param {string[]} keywords  current keyword list for the monitor
 * @param {number} [staleDays=30]
 */
export function getStaleKeywords(health, keywords, staleDays = 30) {
  const thresholdMs = staleDays * 24 * 60 * 60 * 1000
  const now = Date.now()
  return keywords.filter(kw => {
    const h = health[kw]
    if (!h) return false
    if (now - new Date(h.firstSeenAt).getTime() < thresholdMs) return false
    if (h.totalMatches === 0) return true
    return !h.lastMatchAt || (now - new Date(h.lastMatchAt).getTime()) > thresholdMs
  })
}
