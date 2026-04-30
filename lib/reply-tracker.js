// lib/reply-tracker.js — reply outcome tracking (Layer 3 / Roadmap PR #29).
//
// When a user marks a match as posted (PR #21 set match.postedAt), we should
// know 24 hours later whether their reply got engagement. This module owns
// that loop: re-fetches the post's current comment count + score from the
// platform, compares to the baseline values stored at match time, and writes
// an `engagement` record onto the match.
//
// The match's `score` and `comments` fields are the baseline (set by the
// scraper when the post was first matched). The current values come from
// the platform API at sweep time. delta = current - baseline.
//
// Supported platforms (plus fallback shape):
//   reddit       JSON of the post URL (no auth)
//   hackernews   Algolia HN API
//   github       Issues + PRs REST endpoint (uses GITHUB_TOKEN if available)
//   anything else  marked engagement.error = 'unsupported' so we don't retry
//
// Crash-resilient design: state lives on the match record. The sweep is
// idempotent — running it twice produces the same writes. No external
// scheduler / queue. monitor-v2 fires runEngagementSweep on its own cron.

const ONE_HOUR_MS = 60 * 60 * 1000
const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS

// Platforms whose post URLs we know how to re-fetch.
const SUPPORTED_PLATFORMS = new Set(['reddit', 'hackernews', 'github'])

// ── Per-platform fetchers ──────────────────────────────────────────────────

async function fetchRedditEngagement(url) {
  // Accepts either /r/{sub}/comments/{id}/... or /comments/{id}/.. shape.
  const m = String(url || '').match(/reddit\.com\/r\/([^/?#]+)\/comments\/([a-z0-9]+)/i)
  if (!m) return { ok: false, error: 'url-parse-failed' }
  const [, sub, postId] = m
  try {
    const res = await fetch(`https://www.reddit.com/r/${sub}/comments/${postId}.json`, {
      headers: { 'User-Agent': 'EbenovaInsights/2.0 (engagement-check)' },
      signal: AbortSignal.timeout(8000),
    })
    if (res.status === 404) return { ok: false, error: 'post-deleted' }
    if (!res.ok) return { ok: false, error: `reddit-${res.status}` }
    const data = await res.json()
    const post = data?.[0]?.data?.children?.[0]?.data
    if (!post) return { ok: false, error: 'reddit-empty' }
    return { ok: true, comments: Number(post.num_comments) || 0, score: Number(post.score) || 0 }
  } catch (err) {
    return { ok: false, error: `reddit-${err.message || 'fetch-failed'}` }
  }
}

async function fetchHackerNewsEngagement(url) {
  const m = String(url || '').match(/news\.ycombinator\.com\/item\?id=(\d+)/)
  if (!m) return { ok: false, error: 'url-parse-failed' }
  try {
    const res = await fetch(`https://hn.algolia.com/api/v1/items/${m[1]}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (res.status === 404) return { ok: false, error: 'post-deleted' }
    if (!res.ok) return { ok: false, error: `hn-${res.status}` }
    const data = await res.json()
    if (!data || !data.id) return { ok: false, error: 'hn-empty' }
    // Algolia's "children" array includes ALL descendants (a flat tree); the
    // count we want is the same one shown on the original story page.
    const comments = Array.isArray(data.children) ? countDescendants(data.children) : 0
    return { ok: true, comments, score: Number(data.points) || 0 }
  } catch (err) {
    return { ok: false, error: `hn-${err.message || 'fetch-failed'}` }
  }
}

function countDescendants(children) {
  let n = 0
  for (const c of children) {
    n++
    if (Array.isArray(c.children) && c.children.length) n += countDescendants(c.children)
  }
  return n
}

async function fetchGitHubEngagement(url) {
  const m = String(url || '').match(/github\.com\/([^/?#]+)\/([^/?#]+)\/(issues|pull)\/(\d+)/i)
  if (!m) return { ok: false, error: 'url-parse-failed' }
  const [, owner, repo, _type, number] = m
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'EbenovaInsights/2.0 (engagement-check)',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`, {
      headers, signal: AbortSignal.timeout(8000),
    })
    if (res.status === 404) return { ok: false, error: 'post-deleted' }
    if (!res.ok) return { ok: false, error: `github-${res.status}` }
    const data = await res.json()
    return {
      ok: true,
      comments: Number(data.comments) || 0,
      // GitHub doesn't expose a single "score" — use total reactions as a
      // close proxy since +1 / heart / hooray reactions are the engagement
      // signal a user cares about.
      score: Number(data.reactions?.total_count) || 0,
    }
  } catch (err) {
    return { ok: false, error: `github-${err.message || 'fetch-failed'}` }
  }
}

const FETCHERS = {
  reddit:     fetchRedditEngagement,
  hackernews: fetchHackerNewsEngagement,
  github:     fetchGitHubEngagement,
}

/**
 * Fetch the current engagement state for a single match's source URL.
 * Dispatches to the platform-specific fetcher.
 *
 * @param {object} match  must have at least { source, url }
 * @returns {Promise<{ ok: true, comments, score } | { ok: false, error }>}
 */
export async function fetchEngagement(match) {
  if (!match) return { ok: false, error: 'no-match' }
  const platform = String(match.source || '').toLowerCase()
  const fetcher = FETCHERS[platform]
  if (!fetcher) return { ok: false, error: 'unsupported' }
  if (!match.url) return { ok: false, error: 'no-url' }
  return fetcher(match.url)
}

/**
 * Compute the engagement record for a match given its baseline + a freshly
 * fetched current state. Pure function — no I/O.
 *
 * @param {object} match    the stored record (uses match.score, match.comments as baselines)
 * @param {object} current  result of fetchEngagement (ok or error)
 * @param {Date} [now]
 * @returns {{ commentsDelta, scoreDelta, gotEngagement, checkedAt, error }}
 */
export function computeEngagement(match, current, now = new Date()) {
  const checkedAt = now.toISOString()
  if (!current || current.ok === false) {
    return { commentsDelta: 0, scoreDelta: 0, gotEngagement: false, checkedAt, error: current?.error || 'unknown' }
  }
  const baselineComments = Number(match?.comments) || 0
  const baselineScore    = Number(match?.score)    || 0
  const commentsDelta = current.comments - baselineComments
  const scoreDelta    = current.score    - baselineScore
  return {
    commentsDelta,
    scoreDelta,
    gotEngagement: commentsDelta > 0,
    checkedAt,
    error: null,
  }
}

/**
 * Decide whether a match is eligible for an engagement check this sweep.
 * Skips: not-yet-posted, already-checked, < 24h since postedAt.
 */
export function isEligibleForCheck(match, now = Date.now()) {
  if (!match || !match.postedAt) return false
  if (match.engagement && match.engagement.checkedAt) return false
  const postedTs = new Date(match.postedAt).getTime()
  if (!Number.isFinite(postedTs)) return false
  return (now - postedTs) >= TWENTY_FOUR_HOURS_MS
}

/**
 * Walk every active monitor's recent matches and run engagement checks for
 * any that are eligible. Best-effort — per-match failures log but don't stop
 * the sweep. Designed to run from a cron hook in monitor-v2.
 *
 * @param {object} args
 * @param {object} args.redis
 * @param {Date}  [args.now]
 * @param {number} [args.delayBetweenMs]   throttle to be polite to platform APIs
 * @returns {Promise<{ scanned, eligible, ok, error, byError }>}
 */
export async function runEngagementSweep({ redis, now = new Date(), delayBetweenMs = 500 } = {}) {
  const stats = { scanned: 0, eligible: 0, ok: 0, error: 0, byError: {} }
  if (!redis) return stats
  const monitorIds = (await redis.smembers('insights:active_monitors')) || []
  const cutoffTs = now.getTime()
  for (const monitorId of monitorIds) {
    const matchIds = (await redis.lrange(`insights:matches:${monitorId}`, 0, 499)) || []
    for (const matchId of matchIds) {
      const matchKey = `insights:match:${monitorId}:${matchId}`
      const raw = await redis.get(matchKey)
      if (!raw) continue
      let match
      try { match = typeof raw === 'string' ? JSON.parse(raw) : raw }
      catch (_) { continue }
      stats.scanned++
      if (!isEligibleForCheck(match, cutoffTs)) continue
      stats.eligible++

      const current = await fetchEngagement(match)
      const engagement = computeEngagement(match, current, now)
      try {
        await redis.set(matchKey, JSON.stringify({ ...match, engagement }))
        if (engagement.error) {
          stats.error++
          stats.byError[engagement.error] = (stats.byError[engagement.error] || 0) + 1
        } else {
          stats.ok++
        }
      } catch (err) {
        // Redis write failed — log and move on; the next sweep will retry.
        console.warn(`[reply-tracker] failed to write engagement for ${matchId}: ${err.message}`)
        stats.error++
      }
      if (delayBetweenMs > 0) await new Promise(r => setTimeout(r, delayBetweenMs))
    }
  }
  return stats
}

// Test exports
export const _internals = {
  TWENTY_FOUR_HOURS_MS, ONE_HOUR_MS,
  SUPPORTED_PLATFORMS, FETCHERS,
  countDescendants,
}
