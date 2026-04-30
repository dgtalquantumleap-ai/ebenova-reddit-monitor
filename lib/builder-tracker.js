// lib/builder-tracker.js — Builder Tracker mode (Roadmap PR #31).
//
// "No competitor has it" feature. When a monitor is configured with
// mode === 'builder_tracker', the cycle does NOT generate reply drafts.
// Instead, it filters matches that look like someone publicly sharing
// what they're building, extracts 1-3 topic strings via Groq 8b, and
// records a per-author profile in Redis with consistency scoring.
//
// Real customer waiting: Steven Musielski, $50/month, USA. The CSV export
// of these profiles is the headline deliverable he's paying for.
//
// Storage:
//   builder:{monitorId}:{platform}:{username}    Hash with profile fields
//   builder:list:{monitorId}                      Set of "{platform}:{username}"
//   60-day TTL on both — long enough for monthly review cycles to surface
//   returning posters; short enough that an abandoned monitor's data clears.

import { routeAI } from './ai-router.js'
import { toCsv, escapeCsvField } from './csv-export.js'
import { escapeHtml } from './html-escape.js'
import { buildEmailFooter } from './account-deletion.js'

// ── Builder-post heuristic ──────────────────────────────────────────────────
// Cheap, fast, no API call. The signal list intentionally errs inclusive —
// we'd rather extract topics on a borderline-builder post than miss the one
// post a real builder happened to phrase awkwardly. Anti-signals only veto
// when there's NO matching positive signal.

const BUILDER_SIGNALS = [
  'building', 'launched', 'shipped', 'just released', 'just launched',
  'soft launch', 'side project', 'mvp',
  'my saas', 'my startup', 'indie hacker', 'buildinpublic', 'building in public',
  'working on', 'i made', 'i built', 'i\'m building', 'i am building',
  'product update', 'startup update',
]

const BUILDER_DAY_PATTERN = /\b(?:day|week|month)\s+\d+\s+of\b/i

const ANTI_SIGNALS = [
  'help', 'problem', 'issue', 'error', 'bug',
  'how do i', 'how can i', 'anyone know', 'recommend',
  'looking for', 'best tool for',
]

/**
 * Returns true if the post looks like someone publicly sharing what they're
 * building. False if it looks like a complaint or help-seeking post.
 *
 * Tie-breaker: if BOTH a builder signal and an anti-signal match, prefer
 * the builder interpretation (inclusive filter, per spec).
 */
export function isBuilderPost(match) {
  if (!match) return false
  const haystack = `${match.title || ''}\n${match.body || ''}`.toLowerCase()
  if (haystack.trim().length === 0) return false

  let positive = false
  for (const s of BUILDER_SIGNALS) {
    if (haystack.includes(s)) { positive = true; break }
  }
  if (!positive && BUILDER_DAY_PATTERN.test(haystack)) positive = true

  if (positive) return true   // inclusive — builder signal wins ties

  // No positive signal. Check if it's clearly a help/complaint post.
  for (const s of ANTI_SIGNALS) {
    if (haystack.includes(s)) return false
  }
  // Ambiguous — no positive AND no negative — return true per spec
  // ("If ambiguous, returns true"). We'd rather try than skip.
  return true
}

// ── Topic extraction (Groq 8b via ai-router) ────────────────────────────────

const TOPICS_SYSTEM = `You analyze posts where someone is sharing what they are building. List 1-3 short topic phrases describing what they are building. Examples: "SaaS tool", "mobile app", "newsletter", "e-commerce store", "developer tool", "AI startup", "side project".

Respond with a JSON array of 1-3 strings. No markdown. No explanation. Just the array.`

function topicsUserPrompt(match) {
  return `Title: ${match.title || ''}
Body: ${(match.body || '').slice(0, 500)}

Return JSON array of 1-3 topic strings.`
}

function parseTopicsResponse(text) {
  if (!text || typeof text !== 'string') return []
  // Try direct parse first
  try {
    const parsed = JSON.parse(text.trim())
    if (Array.isArray(parsed)) return parsed.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()).slice(0, 3)
  } catch (_) {}
  // Try extracting JSON array from prose
  const m = text.match(/\[[\s\S]*?\]/)
  if (m) {
    try {
      const parsed = JSON.parse(m[0])
      if (Array.isArray(parsed)) return parsed.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()).slice(0, 3)
    } catch (_) {}
  }
  return []
}

/**
 * Extract 1-3 topic strings describing what the post's author is building.
 * Best-effort: returns [] on any failure — never throws.
 */
export async function extractTopics(match) {
  if (!match || !match.title) return []
  const r = await routeAI({
    task: 'extract_builder_topics',
    system: TOPICS_SYSTEM,
    prompt: topicsUserPrompt(match),
    maxTokens: 80,
    temperature: 0.3,
    jsonMode: true,
  })
  if (!r.ok || !r.text) return []
  return parseTopicsResponse(r.text)
}

// ── Consistency scoring ─────────────────────────────────────────────────────

/**
 * Bucket an author into 'daily' / 'weekly' / 'occasional' based on raw
 * postCount and the number of days between firstSeen and lastSeen.
 *
 * Thresholds (per spec):
 *   postCount >= 5 AND daySpan <= 7   → 'daily'
 *   postCount >= 2 AND daySpan <= 14  → 'weekly'
 *   else                              → 'occasional'
 */
export function scoreConsistency(postCount, daySpan) {
  const n = Number(postCount) || 0
  const span = Number(daySpan) || 0
  if (n >= 5 && span <= 7)  return 'daily'
  if (n >= 2 && span <= 14) return 'weekly'
  return 'occasional'
}

// ── Profile storage ────────────────────────────────────────────────────────

// Platforms whose `author` field is a real human handle. The Builder Tracker
// only writes profiles for these — quora/upwork/fiverr/medium/substack/
// linkedin all hardcode the platform name as `author`, which would corrupt
// the dataset.
export const PLATFORMS_WITH_REAL_USERNAMES = ['reddit', 'hackernews', 'github', 'producthunt', 'twitter', 'substack']

const BUILDER_TTL_SECONDS = 60 * 24 * 60 * 60   // 60 days

function profileUrl(platform, username) {
  switch (platform) {
    case 'reddit':      return `https://reddit.com/u/${username}`
    case 'hackernews':  return `https://news.ycombinator.com/user?id=${username}`
    case 'github':      return `https://github.com/${username}`
    case 'producthunt': return `https://www.producthunt.com/@${username}`
    case 'twitter':     return `https://x.com/${username}`
    // Substack profiles live on per-publication subdomains, no canonical URL.
    case 'substack':    return ''
    default:            return ''
  }
}

function daySpan(firstSeenIso, lastSeenIso) {
  const a = new Date(firstSeenIso || 0).getTime()
  const b = new Date(lastSeenIso  || 0).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0
  return Math.floor((b - a) / (24 * 60 * 60 * 1000))
}

/**
 * Write or update a builder profile from a single match. Returns the resulting
 * profile shape for the caller's logging convenience.
 *
 * Skips silently when:
 *   - platform isn't in PLATFORMS_WITH_REAL_USERNAMES (placeholder author)
 *   - author is missing / empty
 */
export async function recordBuilderProfile({ redis, monitorId, match, topics = [] } = {}) {
  if (!redis || !monitorId || !match) return { recorded: false, reason: 'missing-args' }
  const platform = String(match.source || '').toLowerCase()
  if (!PLATFORMS_WITH_REAL_USERNAMES.includes(platform)) {
    return { recorded: false, reason: 'platform-not-supported' }
  }
  const username = String(match.author || '').trim()
  if (!username) return { recorded: false, reason: 'no-author' }

  const key = `builder:${monitorId}:${platform}:${username}`
  const indexKey = `builder:list:${monitorId}`
  const now = match.createdAt || new Date().toISOString()

  try {
    const existing = (await redis.hgetall(key)) || {}
    const isNew = Object.keys(existing).length === 0

    const firstSeen = existing.firstSeen || now
    const lastSeen  = now
    const postCount = (parseInt(existing.postCount, 10) || 0) + 1

    // Topics: union with existing, dedupe, preserve insertion order, cap at 6.
    let prevTopics = []
    try { prevTopics = JSON.parse(existing.topics || '[]') } catch (_) {}
    if (!Array.isArray(prevTopics)) prevTopics = []
    const seenTopics = new Set(prevTopics.map(t => String(t).toLowerCase()))
    for (const t of topics) {
      const k = String(t).toLowerCase()
      if (!seenTopics.has(k)) { seenTopics.add(k); prevTopics.push(t) }
    }
    const mergedTopics = prevTopics.slice(0, 6)

    const consistency = scoreConsistency(postCount, daySpan(firstSeen, lastSeen))

    const fields = {
      username, platform,
      firstSeen, lastSeen,
      postCount: String(postCount),
      consistency,
      topics: JSON.stringify(mergedTopics),
      latestPostTitle: (match.title || '').slice(0, 240),
      latestPostUrl:   match.url || '',
      profileUrl:      profileUrl(platform, username),
    }
    await redis.hset(key, fields)
    await redis.expire(key, BUILDER_TTL_SECONDS)
    await redis.sadd(indexKey, `${platform}:${username}`)
    await redis.expire(indexKey, BUILDER_TTL_SECONDS)
    return { recorded: true, isNew, postCount, consistency }
  } catch (err) {
    console.warn(`[builder-tracker] recordBuilderProfile error for ${username}@${platform}: ${err.message}`)
    return { recorded: false, reason: 'redis-error', error: err.message }
  }
}

// ── Reading profiles ───────────────────────────────────────────────────────

/**
 * Read all tracked builders for a monitor, sorted by postCount desc.
 * Best-effort: errors / missing keys → empty array.
 */
export async function getBuilderProfiles({ redis, monitorId, limit = 50 } = {}) {
  if (!redis || !monitorId) return []
  try {
    const indexKey = `builder:list:${monitorId}`
    const members = (await redis.smembers(indexKey)) || []
    const profiles = []
    for (const member of members) {
      const idx = member.indexOf(':')
      if (idx === -1) continue
      const platform = member.slice(0, idx)
      const username = member.slice(idx + 1)
      const hash = await redis.hgetall(`builder:${monitorId}:${platform}:${username}`)
      if (!hash || Object.keys(hash).length === 0) continue
      let topics = []
      try { topics = JSON.parse(hash.topics || '[]') } catch (_) {}
      if (!Array.isArray(topics)) topics = []
      profiles.push({
        username:        hash.username || username,
        platform:        hash.platform || platform,
        firstSeen:       hash.firstSeen || '',
        lastSeen:        hash.lastSeen  || '',
        postCount:       parseInt(hash.postCount, 10) || 0,
        consistency:     hash.consistency || 'occasional',
        topics,
        latestPostTitle: hash.latestPostTitle || '',
        latestPostUrl:   hash.latestPostUrl   || '',
        profileUrl:      hash.profileUrl      || '',
      })
    }
    profiles.sort((a, b) => b.postCount - a.postCount)
    return profiles.slice(0, limit)
  } catch (err) {
    console.warn(`[builder-tracker] getBuilderProfiles error: ${err.message}`)
    return []
  }
}

// ── CSV export ─────────────────────────────────────────────────────────────

export const BUILDER_CSV_COLUMNS = [
  'platform', 'username', 'profileUrl', 'firstSeen', 'lastSeen',
  'postCount', 'consistency', 'topics',
  'latestPostTitle', 'latestPostUrl',
]

/**
 * Serialize a list of profiles to RFC 4180 CSV. Topics are joined with " | "
 * since CSV cells are flat strings. Empty profiles list → header-only CSV.
 */
export function buildersToCSV(profiles) {
  const rows = (profiles || []).map(p => ({
    platform:        p.platform || '',
    username:        p.username || '',
    profileUrl:      p.profileUrl || '',
    firstSeen:       p.firstSeen || '',
    lastSeen:        p.lastSeen || '',
    postCount:       p.postCount ?? '',
    consistency:     p.consistency || '',
    topics:          Array.isArray(p.topics) ? p.topics.join(' | ') : '',
    latestPostTitle: p.latestPostTitle || '',
    latestPostUrl:   p.latestPostUrl || '',
  }))
  return toCsv(BUILDER_CSV_COLUMNS, rows)
}

// ── Builder digest email (sent every cycle that finds NEW builders) ───────
//
// Builders are time-sensitive — a "shipped today" post from someone who
// just launched is worth seeing within hours, not waiting for Monday.
// So the digest fires on every poll cycle that recorded at least one new
// profile (not weekly like the keyword-mode digest).

const PLATFORM_LABEL = {
  reddit: 'Reddit', hackernews: 'Hacker News', github: 'GitHub',
  producthunt: 'Product Hunt', twitter: 'Twitter/X', substack: 'Substack',
}

/**
 * Render the builder-digest HTML email body. Pure: no I/O, no AI calls.
 *
 * @param {object} args
 * @param {object} args.monitor         monitor record (uses name, alertEmail, unsubscribeToken)
 * @param {Array}  args.newProfiles     freshly-recorded profiles from this cycle
 *                                       each: { username, platform, postCount, consistency, latestPostTitle, latestPostUrl, profileUrl }
 * @param {Array}  args.topProfiles     top 3 by postCount across all time (read separately)
 * @param {string} [args.appUrl]        for the "View all builders" link
 * @returns {{ subject: string, html: string }}
 */
export function renderBuilderDigest({ monitor, newProfiles, topProfiles, appUrl }) {
  const baseUrl = appUrl || process.env.APP_URL || 'https://ebenova.org'
  const dashboardUrl = `${baseUrl.replace(/\/+$/, '')}/dashboard?monitor=${encodeURIComponent(monitor.id || '')}`
  const newCount = newProfiles?.length || 0
  const subject = `${newCount} new builder${newCount === 1 ? '' : 's'} found — ${monitor.name || 'Builder Tracker'}`

  const newSamples = (newProfiles || []).slice(0, 5).map(p => `
    <div style="margin-bottom:14px;padding:12px;background:#f9f9f9;border-left:4px solid #FF6B35;border-radius:4px;">
      <div style="font-size:12px;color:#888;margin-bottom:5px;">
        ${escapeHtml(PLATFORM_LABEL[p.platform] || p.platform || '?')} · ${escapeHtml(p.consistency || '')}${p.postCount ? ` · ${p.postCount} post${p.postCount === 1 ? '' : 's'}` : ''}
      </div>
      <div style="font-size:14px;font-weight:600;color:#1a1a1a;margin-bottom:4px;">${escapeHtml(p.username || '')}</div>
      ${p.latestPostTitle ? `<a href="${escapeHtml(p.latestPostUrl || '#')}" style="font-size:13px;color:#475569;text-decoration:none;display:block;">${escapeHtml(p.latestPostTitle)}</a>` : ''}
      ${p.profileUrl ? `<a href="${escapeHtml(p.profileUrl)}" style="font-size:11px;color:#FF6B35;font-weight:600;display:inline-block;margin-top:6px;">Open profile →</a>` : ''}
    </div>`).join('')

  const topRows = (topProfiles || []).slice(0, 3).map(p => `
    <tr>
      <td style="padding:6px 12px 6px 0;color:#0F172A;font-weight:600;font-size:13px;">${escapeHtml(p.username || '')}</td>
      <td style="padding:6px 12px 6px 0;color:#475569;font-size:12px;">${escapeHtml(PLATFORM_LABEL[p.platform] || p.platform || '?')}</td>
      <td style="padding:6px 12px 6px 0;color:#475569;font-size:12px;">${escapeHtml(p.consistency || '')}</td>
      <td style="padding:6px 0;color:#0F172A;font-size:13px;font-variant-numeric:tabular-nums;text-align:right;">${p.postCount || 0}</td>
    </tr>`).join('')

  const html = `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:32px 24px;background:#f5f5f5;color:#1a1a1a;">
    <div style="margin-bottom:24px;padding:20px;background:#0e0e0e;border-radius:8px;">
      <div style="font-size:18px;font-weight:700;color:#FF6B35;">👥 Builder Tracker — ${escapeHtml(monitor.name || 'your monitor')}</div>
      <div style="font-size:13px;color:#9a9690;margin-top:6px;">${newCount} new builder${newCount === 1 ? '' : 's'} found this cycle · ${new Date().toUTCString()}</div>
    </div>

    <div style="margin-bottom:24px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#94A3B8;text-transform:uppercase;margin-bottom:12px;">Newly tracked</div>
      ${newSamples || '<div style="color:#94A3B8;font-size:13px;font-style:italic;">No new builders this cycle.</div>'}
    </div>

    ${topRows ? `<div style="margin-bottom:24px;padding:14px 18px;background:#fff;border:1px solid #E2E8F0;border-radius:8px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#94A3B8;text-transform:uppercase;margin-bottom:10px;">Top builders this monitor</div>
      <table style="width:100%;border-collapse:collapse;">${topRows}</table>
    </div>` : ''}

    <div style="margin-bottom:24px;text-align:center;">
      <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:#FF6B35;color:#fff;font-weight:600;padding:11px 22px;border-radius:6px;text-decoration:none;font-size:14px;">View all builders →</a>
    </div>

    ${buildEmailFooter(monitor.unsubscribeToken)}
  </body></html>`

  return { subject, html }
}

/**
 * Send the builder digest via Resend. Best-effort: returns { sent: bool,
 * reason }. Honors emailEnabled=false and missing alertEmail.
 */
export async function sendBuilderDigest({ monitor, newProfiles, topProfiles, resend, fromEmail, appUrl }) {
  if (!monitor || !monitor.id) return { sent: false, reason: 'no-monitor' }
  if (monitor.emailEnabled === false) return { sent: false, reason: 'email-disabled' }
  if (!resend || !monitor.alertEmail) return { sent: false, reason: 'no-resend-or-recipient' }
  if (!newProfiles || newProfiles.length === 0) return { sent: false, reason: 'no-new-builders' }

  const { subject, html } = renderBuilderDigest({ monitor, newProfiles, topProfiles, appUrl })
  try {
    await resend.emails.send({
      from: `Ebenova Insights <${fromEmail}>`,
      to: monitor.alertEmail,
      subject, html,
    })
    return { sent: true, count: newProfiles.length }
  } catch (err) {
    console.warn(`[builder-digest][${monitor.id}] send failed: ${err.message}`)
    return { sent: false, reason: 'send-failed', error: err.message }
  }
}

// Test-only exports
export const _internals = {
  BUILDER_SIGNALS, BUILDER_DAY_PATTERN, ANTI_SIGNALS,
  parseTopicsResponse, daySpan, profileUrl,
  BUILDER_TTL_SECONDS, PLATFORM_LABEL,
}
