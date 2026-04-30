// lib/ai-visibility.js — "what do LLMs say about this brand?" (Roadmap PR #34)
//
// Meltwater charges enterprise prices for LLM brand tracking (their GenAI
// Lens product). We do the same job with three Claude calls per week per
// monitor. Routes through ai-router so the cost cap + fallback behavior
// applies just like any other Claude task.
//
// The output (VisibilityReport) gives the founder three signals:
//   - Did Claude name your brand at all when asked about your category?
//   - Where in the response — first thing mentioned, or buried at the end?
//   - Which competitors got named alongside (or instead of) you?
//
// Storage:
//   ai-visibility:{monitorId}:{YYYY-Www}  →  JSON of the full VisibilityReport
//   180-day TTL — half a year of weekly history is enough to spot a
//   declining or improving trend without wedging Redis with stale data.
//
// Run schedule: hooked into monitor-v2's existing Monday-08:00-UTC cron
// alongside the weekly digest. One-shot per monitor per week, best-effort
// (logs failures, never blocks the digest).

import { routeAI } from './ai-router.js'
import { isoWeekLabel, previousIsoWeekLabel } from './keyword-types.js'

const VISIBILITY_TTL_SECONDS = 180 * 24 * 60 * 60   // 180 days

// ── Query templates ─────────────────────────────────────────────────────────
//
// Three angles. Each one isolates a different failure mode for brand
// visibility — a brand can be invisible on direct recommendation queries
// yet known when asked by name, or vice versa.

function buildQueries({ brandName, keywords }) {
  const kws = (keywords || []).filter(Boolean).slice(0, 3).join(', ')
  const description = kws || 'tools in this space'
  // Best-effort category guess for query 3 — joining the first 2 keywords
  // usually reads as a category description ("project management software").
  const category = (keywords || []).slice(0, 2).join(' ') || 'this category'
  return [
    {
      kind: 'direct_recommendation',
      question: `If someone asked you to recommend a tool for ${description}, what would you suggest? List your top 3 recommendations.`,
    },
    {
      kind: 'brand_awareness',
      question: `What do you know about ${brandName}? Is it a tool you would recommend?`,
    },
    {
      kind: 'competitor_landscape',
      question: `What are the best tools for ${category}? Compare the top options.`,
    },
  ]
}

// ── Response parsing ────────────────────────────────────────────────────────

/**
 * Mention position in the response. "first" means the brand appears in the
 * first sentence (and that sentence is reasonably short); "early" means in
 * the first paragraph; "late" later; "not_mentioned" when absent.
 *
 * Why the 150-char cap on "first": some LLMs return a single comma-spliced
 * paragraph with one period at the end. Without the cap, ANY brand mention
 * would be classified as "first sentence". The cap mirrors the intent of
 * the bonus — "first thing Claude said" — by requiring the sentence to
 * actually be sentence-shaped.
 */
const FIRST_SENTENCE_CAP = 150
const FIRST_PARAGRAPH_CAP = 400

export function detectMentionPosition(response, brandName) {
  if (!response || !brandName) return 'not_mentioned'
  const text  = String(response)
  const lower = text.toLowerCase()
  const lname = String(brandName).toLowerCase().trim()
  if (!lname) return 'not_mentioned'
  const idx = lower.indexOf(lname)
  if (idx === -1) return 'not_mentioned'
  // First sentence: first period/?/! followed by space, capped at 150 chars
  // so a comma-spliced wall-of-text doesn't trivially count as "first".
  const sentenceMatch = text.slice(0, FIRST_SENTENCE_CAP + 50).match(/[.!?](\s|$)/)
  const firstSentenceEnd = sentenceMatch
    ? Math.min(sentenceMatch.index, FIRST_SENTENCE_CAP)
    : -1
  if (firstSentenceEnd >= 0 && idx <= firstSentenceEnd) return 'first'
  // First paragraph: '\n\n' break or 400-char cap, whichever comes first.
  const breakIdx = text.indexOf('\n\n')
  const firstParaEnd = (breakIdx >= 0 && breakIdx <= FIRST_PARAGRAPH_CAP)
    ? breakIdx
    : Math.min(FIRST_PARAGRAPH_CAP, text.length)
  if (idx <= firstParaEnd) return 'early'
  return 'late'
}

// Triggers that introduce a list of named alternatives. After matching a
// trigger we walk the comma/and-separated list of Capitalized phrases that
// follows, stopping at sentence-end punctuation.
const COMPETITOR_LIST_TRIGGER = /\b(?:like|such as|including|alternatives?(?: include)?(?:\s*:)?)\s+/gi

// Standalone "X is a tool" / "X is another option" pattern — captures
// individual mentions outside of a list context.
const COMPETITOR_STANDALONE = /\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)?)\s+(?:is\s+a\s+(?:popular\s+)?tool|is\s+another\s+option)/g

// Common false-positive Capitalized words at the start of a sentence /
// list item — drop them so a list like "1. Slack ..." doesn't surface
// "Slack" but a leading "Try Slack ..." doesn't surface "Try".
const COMPETITOR_STOPWORDS = new Set([
  'I', 'You', 'We', 'They', 'It', 'This', 'That', 'These', 'Those',
  'The', 'A', 'An', 'And', 'Or', 'But', 'If', 'Then',
  'Try', 'Use', 'Consider', 'Some', 'Many', 'Most', 'Other', 'Others',
  'Yes', 'No', 'Tool', 'Tools', 'Option', 'Options',
])

// Per-item shape inside a list — one or two Capitalized words.
const LIST_ITEM_RE = /^([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)?)/

/**
 * Pull capitalized product/tool names out of the response, excluding the
 * brand itself. De-dupes case-insensitively while preserving the first
 * casing seen. Caps at 8 to keep the report compact.
 *
 * Walks two patterns:
 *   1. List trigger ("such as", "including", "like", "alternatives include")
 *      followed by a comma/and-separated list of Capitalized items.
 *   2. Standalone "X is a popular tool" / "X is another option".
 */
export function extractCompetitors(response, brandName) {
  if (!response) return []
  const text = String(response)
  const lname = String(brandName || '').toLowerCase().trim()
  const seen = new Set()
  const out = []
  const push = (raw) => {
    if (out.length >= 8) return
    const candidate = (raw || '').trim()
    if (!candidate) return
    const lc = candidate.toLowerCase()
    if (lname && lc === lname) return                     // skip the brand
    if (COMPETITOR_STOPWORDS.has(candidate.split(/\s+/)[0])) return
    if (seen.has(lc)) return
    seen.add(lc)
    out.push(candidate)
  }

  // Pattern 1: list following a trigger. Walk forward from the trigger,
  // splitting on commas and the word "and", until a sentence terminator.
  COMPETITOR_LIST_TRIGGER.lastIndex = 0
  let m
  while ((m = COMPETITOR_LIST_TRIGGER.exec(text)) !== null) {
    const start = m.index + m[0].length
    // Slice from list-start to the next sentence terminator (or 200 chars).
    const tail = text.slice(start, start + 200)
    const stop = tail.search(/[.!?\n]/)
    const listChunk = stop >= 0 ? tail.slice(0, stop) : tail
    // Items separated by commas or " and " — both acceptable English glue.
    const items = listChunk.split(/,\s*|\s+and\s+/i)
    for (const item of items) {
      const itemMatch = item.match(LIST_ITEM_RE)
      if (itemMatch) push(itemMatch[1])
    }
  }

  // Pattern 2: standalone "X is a tool" mentions outside a list.
  COMPETITOR_STANDALONE.lastIndex = 0
  while ((m = COMPETITOR_STANDALONE.exec(text)) !== null) {
    push(m[1])
  }

  return out
}

// Sentiment heuristic. Cheap word-list scoring — if you want better,
// route the response back through Claude. Most calls are clear-cut and a
// keyword pass is fine.
const POSITIVE_WORDS = [
  'recommend', 'recommended', 'great', 'excellent', 'popular',
  'powerful', 'love', 'favorite', 'leading', 'top', 'best',
  'reliable', 'trusted', 'solid',
]
const NEGATIVE_WORDS = [
  'avoid', 'poor', 'bad', 'limited', 'lacks', 'lacking',
  'expensive', 'overpriced', 'outdated', 'deprecated',
  'unreliable', 'buggy', 'frustrating', 'do not recommend', "don't recommend",
]

/**
 * Sentiment around the brand mention. Looks at a 200-char window centered on
 * the brand name; classifies based on positive vs. negative keyword count.
 * Returns 'not_mentioned' if the brand doesn't appear.
 */
export function detectSentiment(response, brandName) {
  if (!response || !brandName) return 'not_mentioned'
  const lower = String(response).toLowerCase()
  const lname = String(brandName).toLowerCase().trim()
  if (!lname) return 'not_mentioned'
  const idx = lower.indexOf(lname)
  if (idx === -1) return 'not_mentioned'
  const start = Math.max(0, idx - 100)
  const end   = Math.min(lower.length, idx + lname.length + 100)
  const window = lower.slice(start, end)
  let pos = 0, neg = 0
  for (const w of POSITIVE_WORDS) if (window.includes(w)) pos++
  for (const w of NEGATIVE_WORDS) if (window.includes(w)) neg++
  if (pos > neg) return 'positive'
  if (neg > pos) return 'negative'
  return 'neutral'
}

/**
 * Score one query result. Returns the per-query record that goes in the
 * VisibilityReport.queries array.
 */
export function scoreQuery({ kind, question, response, brandName }) {
  const text = response || ''
  const lower = text.toLowerCase()
  const lname = String(brandName || '').toLowerCase().trim()
  const brandMentioned = !!lname && lower.includes(lname)
  return {
    kind,
    question,
    response: text,
    brandMentioned,
    mentionPosition: detectMentionPosition(text, brandName),
    competitorsMentioned: extractCompetitors(text, brandName),
    sentiment: brandMentioned ? detectSentiment(text, brandName) : 'not_mentioned',
  }
}

// ── Score + trend ──────────────────────────────────────────────────────────

// Spec'd weights: q1 (direct recommendation) carries the most weight because
// it's the hardest test — Claude wasn't even asked about your brand yet.
const QUERY_WEIGHTS = {
  direct_recommendation: 40,
  brand_awareness:       30,
  competitor_landscape:  20,
}

/**
 * Compute the 0-100 overall score from a list of scored queries. Adds a
 * position bonus (+10 'first', +5 'early') based on the highest-weighted
 * query the brand appears in.
 */
export function computeOverallScore(queries) {
  if (!Array.isArray(queries) || queries.length === 0) return 0
  let score = 0
  let bestPosition = null
  let bestWeight   = -1
  for (const q of queries) {
    const w = QUERY_WEIGHTS[q.kind] || 0
    if (q.brandMentioned) {
      score += w
      // Position bonus comes from the highest-weighted query the brand
      // shows up in — best-foot-forward, not a sum across all three.
      if (w > bestWeight && (q.mentionPosition === 'first' || q.mentionPosition === 'early')) {
        bestWeight   = w
        bestPosition = q.mentionPosition
      }
    }
  }
  if (bestPosition === 'first') score += 10
  if (bestPosition === 'early') score += 5
  return Math.max(0, Math.min(100, score))
}

/**
 * Compare a current score to a previous one to bucket the trend. Spec:
 *   delta > +10  → 'improving'
 *   delta < -10  → 'declining'
 *   abs(delta) <= 10 → 'stable'
 *   no previous record → 'new'
 */
export function computeTrend(currentScore, previousScore) {
  if (previousScore == null) return 'new'
  const delta = (Number(currentScore) || 0) - (Number(previousScore) || 0)
  if (delta > 10)  return 'improving'
  if (delta < -10) return 'declining'
  return 'stable'
}

// ── Brand-name resolution ──────────────────────────────────────────────────

/**
 * Choose a brand name for a monitor. Prefers an explicit `brandName` field
 * (PR #34 schema addition); falls back to the first keyword's text. Returns
 * null if neither is usable — callers should skip the AI visibility check
 * rather than ask Claude about an empty string.
 */
export function resolveBrandName(monitor) {
  if (!monitor) return null
  const explicit = (monitor.brandName || '').trim()
  if (explicit) return explicit
  const firstKw = Array.isArray(monitor.keywords)
    ? (monitor.keywords[0]?.keyword || monitor.keywords[0] || '').toString().trim()
    : ''
  return firstKw || null
}

// ── Public API: checkAIVisibility ──────────────────────────────────────────

/**
 * Run the three Claude queries for a monitor, parse responses, score, and
 * compute trend (against last week's stored report if present). Best-effort
 * — returns null on any failure (no Claude key, all 3 queries failed, no
 * brandName resolvable). Caller should log + skip, not crash.
 *
 * @param {object} args
 * @param {object} args.monitor    must have at least { id, keywords }
 * @param {object} [args.redis]    optional — used to look up last week's
 *                                  score for trend; if omitted, trend = 'new'
 * @param {Date}   [args.now]      for deterministic tests
 * @param {Function} [args.routeAIFn]  test seam — defaults to real routeAI
 * @returns {Promise<VisibilityReport | null>}
 */
export async function checkAIVisibility({ monitor, redis, now = new Date(), routeAIFn = routeAI } = {}) {
  if (!monitor || !monitor.id) return null
  const brandName = resolveBrandName(monitor)
  if (!brandName) return null

  const keywords = Array.isArray(monitor.keywords)
    ? monitor.keywords.map(k => (typeof k === 'string' ? k : (k?.keyword || '')))
    : []
  const queries = buildQueries({ brandName, keywords })

  const scored = []
  let anySucceeded = false
  for (const q of queries) {
    const r = await routeAIFn({
      task: 'check_ai_visibility',
      prompt: q.question,
      maxTokens: 500,
      temperature: 0.3,
    })
    if (r?.ok && r.text) {
      anySucceeded = true
      scored.push(scoreQuery({ kind: q.kind, question: q.question, response: r.text, brandName }))
    } else {
      // Record the question as "not_mentioned" so the report shape is
      // consistent — but with empty response so the caller can tell.
      scored.push(scoreQuery({ kind: q.kind, question: q.question, response: '', brandName }))
    }
  }
  if (!anySucceeded) return null

  const overallScore = computeOverallScore(scored)
  let previousScore = null
  if (redis) {
    try {
      const prevWk = previousIsoWeekLabel(now)
      const prevRaw = await redis.get(`ai-visibility:${monitor.id}:${prevWk}`)
      if (prevRaw) {
        const prev = typeof prevRaw === 'string' ? JSON.parse(prevRaw) : prevRaw
        if (prev && typeof prev.overallScore === 'number') previousScore = prev.overallScore
      }
    } catch (err) {
      console.warn(`[ai-visibility] previous-score lookup failed: ${err.message}`)
    }
  }
  const trend = computeTrend(overallScore, previousScore)

  return {
    checkedAt: now.toISOString(),
    brandName,
    queries: scored,
    overallScore,
    trend,
  }
}

// ── Storage ────────────────────────────────────────────────────────────────

/**
 * Persist a VisibilityReport keyed by ISO week. Best-effort: returns
 * { stored: false } on any Redis error (caller may log; the cron is
 * already fire-and-forget).
 */
export async function storeVisibilityReport({ redis, monitorId, report, now = new Date() } = {}) {
  if (!redis || !monitorId || !report) return { stored: false, reason: 'missing-args' }
  const week = isoWeekLabel(now)
  const key  = `ai-visibility:${monitorId}:${week}`
  try {
    await redis.set(key, JSON.stringify(report))
    await redis.expire(key, VISIBILITY_TTL_SECONDS)
    return { stored: true, key, week }
  } catch (err) {
    console.warn(`[ai-visibility] store failed: ${err.message}`)
    return { stored: false, reason: 'redis-error', error: err.message }
  }
}

/**
 * Read up to N most recent weekly reports for a monitor (newest first).
 * Walks back from the current ISO week. Returns [] on no Redis or all-misses.
 */
export async function getRecentReports({ redis, monitorId, weeks = 4, now = new Date() } = {}) {
  if (!redis || !monitorId) return []
  const out = []
  let cursor = new Date(now)
  for (let i = 0; i < weeks; i++) {
    const wk = isoWeekLabel(cursor)
    try {
      const raw = await redis.get(`ai-visibility:${monitorId}:${wk}`)
      if (raw) {
        const r = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (r && typeof r === 'object') out.push(r)
      }
    } catch (err) {
      console.warn(`[ai-visibility] read for ${wk} failed: ${err.message}`)
    }
    cursor = new Date(cursor.getTime() - 7 * 24 * 60 * 60 * 1000)
  }
  return out
}

/**
 * Aggregate top competitors mentioned across a list of reports. Counts
 * occurrences case-insensitively, returns up to 5 most-frequent.
 */
export function topCompetitorsAcross(reports) {
  if (!Array.isArray(reports) || reports.length === 0) return []
  const tally = new Map()
  for (const r of reports) {
    if (!r?.queries) continue
    for (const q of r.queries) {
      for (const c of (q.competitorsMentioned || [])) {
        const key = String(c).toLowerCase()
        if (!tally.has(key)) tally.set(key, { name: c, count: 0 })
        tally.get(key).count++
      }
    }
  }
  return [...tally.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(e => e.name)
}

// ── Sweep — runs from monitor-v2 weekly cron ────────────────────────────────

/**
 * Run checkAIVisibility for every active keyword-mode monitor with a
 * resolvable brand name. Best-effort per monitor; no monitor's failure
 * blocks any other. Returns aggregate stats for the cron's log line.
 */
export async function runVisibilitySweep({ redis, now = new Date() } = {}) {
  const stats = { eligible: 0, ran: 0, stored: 0, skipped: 0, failed: 0 }
  if (!redis) return stats
  let monitorIds = []
  try {
    monitorIds = (await redis.smembers('insights:active_monitors')) || []
  } catch (err) {
    console.warn(`[ai-visibility][sweep] could not list monitors: ${err.message}`)
    return stats
  }
  for (const id of monitorIds) {
    let monitor = null
    try {
      const raw = await redis.get(`insights:monitor:${id}`)
      if (!raw) { stats.skipped++; continue }
      monitor = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch (err) {
      console.warn(`[ai-visibility][sweep] read ${id}: ${err.message}`)
      stats.skipped++
      continue
    }
    if (!monitor.active) { stats.skipped++; continue }
    if (monitor.mode === 'builder_tracker') { stats.skipped++; continue }
    if (!resolveBrandName(monitor)) { stats.skipped++; continue }
    stats.eligible++
    try {
      const report = await checkAIVisibility({ monitor, redis, now })
      if (!report) { stats.failed++; continue }
      stats.ran++
      const w = await storeVisibilityReport({ redis, monitorId: id, report, now })
      if (w.stored) stats.stored++
    } catch (err) {
      console.warn(`[ai-visibility][sweep] ${id} failed: ${err.message}`)
      stats.failed++
    }
  }
  return stats
}

// Test-only exports for direct inspection
export const _internals = {
  buildQueries, QUERY_WEIGHTS, VISIBILITY_TTL_SECONDS,
  POSITIVE_WORDS, NEGATIVE_WORDS, COMPETITOR_STOPWORDS,
}
