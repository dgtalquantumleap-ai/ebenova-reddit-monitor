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

/**
 * Public delta API. Returns the engagement delta for a single match, or null
 * for unsupported platforms (e.g. Twitter, which requires paid API access
 * for engagement data).
 *
 * Why this wrapper exists: callers that just want "did this Reddit post pick
 * up engagement?" don't need to know about the fetch + compute split. They
 * also don't want to handle the unsupported-platform case as an error string —
 * `null` is a cleaner "skip this" signal.
 *
 * Never throws. Returns `null` on:
 *   - Twitter / unsupported platforms
 *   - Network failures
 *   - URL parse failures
 *   - Empty/dead post fetches
 *
 * @param {object} match  must have at least { source, url, score, comments }
 * @param {Date}   [now]  for deterministic tests
 * @returns {Promise<{ scoreDelta: number, commentsDelta: number, checkedAt: string } | null>}
 */
export async function fetchEngagementDelta(match, now = new Date()) {
  if (!match) return null
  const platform = String(match.source || '').toLowerCase()
  // Twitter / X requires paid API access for post-level engagement. Until
  // that's wired up, callers should treat Twitter matches as not-yet-trackable
  // (null) rather than as an error case.
  if (platform === 'twitter' || platform === 'x') return null
  if (!FETCHERS[platform]) return null
  if (!match.url) return null
  try {
    const current = await FETCHERS[platform](match.url)
    if (!current || current.ok === false) return null
    const baselineComments = Number(match.comments) || 0
    const baselineScore    = Number(match.score)    || 0
    return {
      scoreDelta:    current.score    - baselineScore,
      commentsDelta: current.comments - baselineComments,
      checkedAt:     now.toISOString(),
    }
  } catch (_) {
    // Defense-in-depth: any FETCHER that throws (instead of returning ok:false)
    // is still treated as "skip" rather than crashing the sweep.
    return null
  }
}

// ── Per-monitor pending-check queue (Roadmap "Reply Outcome Tracking") ────
//
// Sits parallel to the global hourly sweep (runEngagementSweep). When a user
// marks a match as posted (PATCH /v1/matches/posted), we push a pending
// check onto this monitor's queue with scheduledFor = +24h. Each poll cycle
// drains the head of the queue for this monitor — checks that are ready get
// fetched and written back; checks that aren't yet ready get re-pushed.
//
// Why per-monitor queues instead of one global queue?
//   - A poll cycle already holds the monitor's record + scrapers in scope,
//     so processing this monitor's checks adds zero context-switch cost.
//   - Per-monitor failure isolation matches the rest of the cycle pipeline.
//   - The queue length reads as a per-monitor health signal (long queue =
//     user is actively posting replies; empty queue = monitor is dormant).
//
// Storage:
//   engagement:pending:{monitorId}   Redis list, rpush + lrange/lset/lrem
//   48-hour TTL (refreshed on every push)
//
// Field convention: this flow writes match.engagementDelta + match.gotEngagement
// at the top level of the match record. The pre-existing global sweep
// (runEngagementSweep) writes match.engagement.gotEngagement. Both are
// honored by the digest + endpoint readers — we union them via
// matchGotEngagement(match).

const PENDING_TTL_SECONDS = 48 * 60 * 60          // 48h
const PENDING_DELAY_MS    = TWENTY_FOUR_HOURS_MS  // 24h after posted
const PENDING_BATCH_SIZE  = 10                     // max items per poll cycle

function pendingKey(monitorId) {
  return `engagement:pending:${monitorId}`
}

/**
 * Returns true if the match has a verified engagement signal from either
 * the per-monitor pending flow OR the global hourly sweep. Single source of
 * truth for digests, reports, and the outcomes endpoint.
 */
export function matchGotEngagement(match) {
  if (!match) return false
  if (match.gotEngagement === true) return true
  if (match.engagement?.gotEngagement === true) return true
  return false
}

/**
 * Push a pending engagement check for a posted match. Idempotent-ish: a
 * caller that schedules the same match twice will see two entries on the
 * queue, but processPendingChecks short-circuits if the match already has
 * an engagement record, so the second drain is a no-op.
 *
 * @returns {Promise<{ scheduled: boolean, reason?: string }>}
 */
export async function scheduleEngagementCheck({ redis, monitorId, match, now = Date.now() } = {}) {
  if (!redis || !monitorId || !match || !match.id) {
    return { scheduled: false, reason: 'missing-args' }
  }
  const item = {
    matchId:        match.id,
    url:            match.url || '',
    source:         match.source || '',
    subreddit:      match.subreddit || '',
    storedScore:    Number(match.score) || 0,
    storedComments: Number(match.comments) || 0,
    scheduledFor:   now + PENDING_DELAY_MS,
    monitorId,
  }
  try {
    await redis.rpush(pendingKey(monitorId), JSON.stringify(item))
    await redis.expire(pendingKey(monitorId), PENDING_TTL_SECONDS)
    return { scheduled: true, scheduledFor: item.scheduledFor }
  } catch (err) {
    console.warn(`[reply-tracker] schedule failed for ${monitorId}:${match.id}: ${err.message}`)
    return { scheduled: false, reason: 'redis-error', error: err.message }
  }
}

/**
 * Drain up to PENDING_BATCH_SIZE items from this monitor's pending queue.
 * Items not yet due (scheduledFor > now) are re-pushed to the tail; items
 * that are due get fetched + written back to the match record. Each drained
 * item is removed regardless of whether the fetch succeeded — a permanent
 * failure (deleted post, bad URL) shouldn't tie up the queue indefinitely.
 *
 * Best-effort: never throws. Returns aggregate stats for the cycle log line.
 *
 * @returns {Promise<{ scanned, processed, ok, failed, deferred }>}
 */
export async function processPendingChecks({ redis, monitorId, now = Date.now() } = {}) {
  const stats = { scanned: 0, processed: 0, ok: 0, failed: 0, deferred: 0 }
  if (!redis || !monitorId) return stats
  const key = pendingKey(monitorId)
  let raws
  try {
    raws = (await redis.lrange(key, 0, PENDING_BATCH_SIZE - 1)) || []
  } catch (err) {
    console.warn(`[reply-tracker] lrange ${key}: ${err.message}`)
    return stats
  }
  if (raws.length === 0) return stats
  stats.scanned = raws.length

  // We trim the head we read, then re-push any items that aren't due. This
  // keeps the queue ordered roughly oldest-first. ltrim with stop=N removes
  // [0..N], so we ltrim away the items we just read and rebuild from there.
  try {
    await redis.ltrim(key, raws.length, -1)
  } catch (err) {
    console.warn(`[reply-tracker] ltrim ${key}: ${err.message}`)
    return stats
  }

  for (const raw of raws) {
    let item
    try { item = typeof raw === 'string' ? JSON.parse(raw) : raw }
    catch (_) { continue }
    if (!item || !item.matchId) continue

    if (Number(item.scheduledFor) > now) {
      // Not yet due — push back to the tail and stop processing earlier
      // items in this batch (they're younger than this one anyway).
      stats.deferred++
      try { await redis.rpush(key, JSON.stringify(item)) } catch (_) {}
      continue
    }

    stats.processed++
    const matchKey = `insights:match:${monitorId}:${item.matchId}`
    let match
    try {
      const matchRaw = await redis.get(matchKey)
      if (!matchRaw) { stats.failed++; continue }
      match = typeof matchRaw === 'string' ? JSON.parse(matchRaw) : matchRaw
    } catch (err) {
      console.warn(`[reply-tracker] read ${matchKey}: ${err.message}`)
      stats.failed++
      continue
    }

    // Build a synthetic-baseline match record so fetchEngagementDelta uses
    // the score/comments captured at schedule time (not the current values).
    const probe = {
      ...match,
      score:    item.storedScore,
      comments: item.storedComments,
    }
    let delta
    try { delta = await fetchEngagementDelta(probe, new Date(now)) }
    catch (_) { delta = null }
    if (!delta) {
      // null = unsupported / fetch failed / post deleted. Drop without retry.
      stats.failed++
      continue
    }

    const gotEngagement = delta.commentsDelta > 0 || delta.scoreDelta > 2
    try {
      await redis.set(matchKey, JSON.stringify({
        ...match,
        engagementDelta: delta,
        gotEngagement,
      }))
      stats.ok++
    } catch (err) {
      console.warn(`[reply-tracker] write ${matchKey}: ${err.message}`)
      stats.failed++
    }
  }

  // Refresh the TTL on the queue so a busy monitor doesn't expire mid-flight.
  try { await redis.expire(key, PENDING_TTL_SECONDS) } catch (_) {}
  return stats
}

/**
 * Read posted matches in the last `days` window and assemble the outcomes
 * shape used by both the API endpoint and the digest section. Pure-ish:
 * only reads from Redis, no writes.
 *
 * Returns:
 *   { posted, engaged, rateLabel, recent: Match[], topPerforming: Match[] }
 *
 * `recent` is newest-first (up to N), `topPerforming` is sorted by commentsDelta.
 */
export async function getRecentOutcomes({ redis, monitorId, days = 30, now = Date.now(), recentLimit = 10, topLimit = 3 } = {}) {
  const out = { posted: 0, engaged: 0, rateLabel: '0%', recent: [], topPerforming: [] }
  if (!redis || !monitorId) return out
  const cutoff = now - days * 24 * 60 * 60 * 1000
  let ids
  try { ids = (await redis.lrange(`insights:matches:${monitorId}`, 0, 499)) || [] }
  catch (_) { return out }

  const posted = []
  for (const id of ids) {
    try {
      const raw = await redis.get(`insights:match:${monitorId}:${id}`)
      if (!raw) continue
      const m = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!m.postedAt) continue
      const ts = new Date(m.postedAt).getTime()
      if (!Number.isFinite(ts) || ts < cutoff) continue
      posted.push(m)
    } catch (_) { /* skip */ }
  }

  out.posted = posted.length
  out.engaged = posted.filter(matchGotEngagement).length
  out.rateLabel = posted.length > 0
    ? `${Math.round((out.engaged / posted.length) * 100)}%`
    : '0%'

  const sortedByPosted = posted.slice()
    .sort((a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0))
  out.recent = sortedByPosted.slice(0, recentLimit).map(m => ({
    matchId:       m.id,
    title:         m.title || '',
    url:           m.url || '',
    postedAt:      m.postedAt,
    commentsDelta: deltaCommentsOf(m),
    scoreDelta:    deltaScoreOf(m),
    gotEngagement: matchGotEngagement(m),
  }))

  const withDelta = posted
    .map(m => ({ m, c: deltaCommentsOf(m), s: deltaScoreOf(m) }))
    .filter(x => x.c > 0 || x.s > 0)
    .sort((a, b) => (b.c - a.c) || (b.s - a.s))
  out.topPerforming = withDelta.slice(0, topLimit).map(({ m, c, s }) => ({
    matchId: m.id,
    title:   m.title || '',
    url:     m.url || '',
    commentsDelta: c,
    scoreDelta:    s,
  }))

  return out
}

function deltaCommentsOf(m) {
  if (m?.engagementDelta?.commentsDelta != null) return Number(m.engagementDelta.commentsDelta) || 0
  if (m?.engagement?.commentsDelta      != null) return Number(m.engagement.commentsDelta)      || 0
  return 0
}
function deltaScoreOf(m) {
  if (m?.engagementDelta?.scoreDelta != null) return Number(m.engagementDelta.scoreDelta) || 0
  if (m?.engagement?.scoreDelta      != null) return Number(m.engagement.scoreDelta)      || 0
  return 0
}

// Test exports
export const _internals = {
  TWENTY_FOUR_HOURS_MS, ONE_HOUR_MS,
  SUPPORTED_PLATFORMS, FETCHERS,
  countDescendants,
  PENDING_TTL_SECONDS, PENDING_DELAY_MS, PENDING_BATCH_SIZE,
  pendingKey, deltaCommentsOf, deltaScoreOf,
}
