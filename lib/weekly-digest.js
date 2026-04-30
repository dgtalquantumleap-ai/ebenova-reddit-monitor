// lib/weekly-digest.js — Monday-morning weekly digest per monitor.
//
// Fires from monitor-v2's cron at 08:00 UTC every Monday. For each active
// monitor (emailEnabled !== false), reads the last 7 days of matches from
// Redis, computes a stat block, asks DeepSeek for a narrative summary
// paragraph, and — if there were any high-intent matches — asks Claude to
// re-draft the top lead so the user opens the email and sees their best
// possible reply on their best possible match. Then sends one email.
//
// Best-effort: every step is wrapped so a single monitor failing (Resend
// outage, AI router timeout, malformed match record) logs and continues.
// The cron must never crash the worker.
//
// AI routing (PR #26)
//   - Pattern summary  → routeAI({ task: 'weekly_pattern_summary' })  // DeepSeek
//   - Best-lead redraft → routeAI({ task: 'generate_premium_reply' })  // Claude
// The router's fallback chain (GROQ_QUALITY → GROQ_FAST) ensures the
// digest still fires even if DeepSeek or Anthropic is down — the
// fallback content will just be less narrative.

import { routeAI } from './ai-router.js'
import { escapeHtml } from './html-escape.js'
import { buildEmailFooter } from './account-deletion.js'
import { isHighPriority } from './classify.js'

// ── Stat-gathering ──────────────────────────────────────────────────────────

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Read the last 7 days of matches for one monitor and compute the stat
 * block the digest renders + summarizes.
 *
 * `allMatches` is the full window — exposed (rather than just topMatches)
 * so the intelligence briefing (PR #30) can reason over the same set
 * without re-walking the match-list.
 *
 * @returns {Promise<{
 *   total: number,
 *   byIntent: Record<string, number>,
 *   byPlatform: Record<string, number>,
 *   postedCount: number,
 *   engagedCount: number,
 *   topMatches: Array<object>,
 *   bestLead: object | null,
 *   allMatches: Array<object>,
 * }>}
 */
export async function gatherDigestData(monitor, redis) {
  const out = {
    total: 0,
    byIntent: {
      asking_for_tool: 0, buying: 0, complaining: 0,
      researching: 0, venting: 0, recommending: 0, unclassified: 0,
    },
    byPlatform: {},
    postedCount: 0,
    engagedCount: 0,   // PR #29 — replies that got engagement (commentsDelta > 0)
    topMatches: [],
    bestLead: null,
    allMatches: [],    // PR #30 — exposed for the intelligence briefing
  }
  if (!redis || !monitor?.id) return out

  const cutoff = Date.now() - ONE_WEEK_MS
  const ids = (await redis.lrange(`insights:matches:${monitor.id}`, 0, 499)) || []
  const recent = []
  for (const matchId of ids) {
    const raw = await redis.get(`insights:match:${monitor.id}:${matchId}`)
    if (!raw) continue
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw
    const ts = new Date(m.createdAt || m.storedAt || 0).getTime()
    if (!Number.isFinite(ts) || ts < cutoff) continue
    recent.push(m)
  }

  out.total = recent.length
  for (const m of recent) {
    if (m.intent && Object.prototype.hasOwnProperty.call(out.byIntent, m.intent)) {
      out.byIntent[m.intent]++
    } else {
      out.byIntent.unclassified++
    }
    const platform = m.source || 'unknown'
    out.byPlatform[platform] = (out.byPlatform[platform] || 0) + 1
    if (m.postedAt) {
      const pTs = new Date(m.postedAt).getTime()
      if (Number.isFinite(pTs) && pTs >= cutoff) {
        out.postedCount++
        // PR #29 — engagement is recorded by lib/reply-tracker.js's sweep
        // ~24h after a post is marked posted. Count only matches where the
        // sweep saw a real comments-delta increase.
        if (m.engagement?.gotEngagement === true) out.engagedCount++
      }
    }
  }

  // Top 3: high-priority first (intent buying / asking_for_tool, sentiment != venting),
  // then by intent priority order, then by recency.
  const INTENT_ORDER = { asking_for_tool: 0, buying: 1, researching: 2, complaining: 3, recommending: 4, venting: 5 }
  const sorted = recent.slice().sort((a, b) => {
    const aHigh = isHighPriority(a) ? 0 : 1
    const bHigh = isHighPriority(b) ? 0 : 1
    if (aHigh !== bHigh) return aHigh - bHigh
    const ai = INTENT_ORDER[a.intent] ?? 99
    const bi = INTENT_ORDER[b.intent] ?? 99
    if (ai !== bi) return ai - bi
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  })
  out.topMatches = sorted.slice(0, 3)
  out.bestLead = sorted.find(m => isHighPriority(m)) || null
  out.allMatches = recent
  return out
}

// ── Author-profile gathering for the intelligence briefing (PR #30) ────────
// Reads PR #24's author:profile:* hashes via the per-monitor index set.
// Returns top N by postCount. Best-effort — errors return [].
export async function gatherAuthorProfilesForDigest(monitor, redis, limit = 10) {
  if (!redis || !monitor?.id) return []
  try {
    const indexKey = `author:list:${monitor.id}`
    const members = (await redis.smembers(indexKey)) || []
    const profiles = []
    for (const member of members) {
      const idx = member.indexOf(':')
      if (idx === -1) continue
      const platform = member.slice(0, idx)
      const username = member.slice(idx + 1)
      const hash = await redis.hgetall(`author:profile:${monitor.id}:${platform}:${username}`)
      if (!hash || Object.keys(hash).length === 0) continue
      profiles.push({
        username, platform,
        postCount:       parseInt(hash.postCount, 10) || 0,
        firstSeen:       hash.firstSeen || '',
        lastSeen:        hash.lastSeen  || '',
        latestPostTitle: hash.latestPostTitle || '',
        latestPostUrl:   hash.latestPostUrl   || '',
      })
    }
    profiles.sort((a, b) => b.postCount - a.postCount)
    return profiles.slice(0, limit)
  } catch (_) {
    return []
  }
}

// ── Narrative summary (DeepSeek via ai-router) ──────────────────────────────

const SUMMARY_SYSTEM = `You are a concise analyst writing a Monday-morning brief for a founder. One paragraph, plain English, 3-5 sentences. Surface the most actionable signal, name what changed week-over-week if data suggests it, and end with one specific next step. No greetings, no sign-off, no markdown, no bullet points. Lead with the substance, not "this week" preamble.`

function summaryUserPrompt(monitor, stats) {
  const { total, byIntent, byPlatform, postedCount } = stats
  const intentLines = Object.entries(byIntent)
    .filter(([_, n]) => n > 0)
    .map(([k, n]) => `  ${k}: ${n}`)
    .join('\n')
  const platformLines = Object.entries(byPlatform)
    .map(([k, n]) => `  ${k}: ${n}`)
    .join('\n')
  return `Monitor: ${monitor.name || '(untitled)'}
Product context: ${(monitor.productContext || '').slice(0, 400)}

This week's data:
  Total matches: ${total}
  Replies posted: ${postedCount}

By intent:
${intentLines || '  (no classified matches)'}

By platform:
${platformLines || '  (no platform data)'}

Write the one-paragraph brief now.`
}

/**
 * Ask the router for a narrative summary. Falls back to a plain stats line
 * when the router fails so the email still has SOMETHING in the summary slot.
 */
export async function buildPatternSummary({ monitor, stats }) {
  if (!stats || stats.total === 0) {
    return 'No matches landed this week. The watchers are running — most weeks see at least a handful, so this is worth a look at the keyword set.'
  }
  const r = await routeAI({
    task: 'weekly_pattern_summary',
    system: SUMMARY_SYSTEM,
    prompt: summaryUserPrompt(monitor, stats),
    maxTokens: 320,
    temperature: 0.6,
  })
  if (r.ok && r.text) return r.text.trim()
  // Fallback: stat-driven one-liner. Better than empty.
  const high = (stats.byIntent.asking_for_tool || 0) + (stats.byIntent.buying || 0)
  return `${stats.total} matches landed this week across ${Object.keys(stats.byPlatform).length} platforms${high > 0 ? `, with ${high} high-intent signals worth looking at first` : ''}. Replies posted: ${stats.postedCount}.`
}

// ── Strategic intelligence briefing (DeepSeek via ai-router) ───────────────
// PR #30. The briefing is appended to the weekly digest as 5 specific
// bullet points: dominant pain point, competitor opportunity, best
// unanswered thread, top lead, recommended focus next week.
//
// Skipped on light-data weeks (< 5 matches) — a 5-bullet strategic briefing
// off a single match wastes a Claude/DeepSeek call and produces hand-wavy
// fluff. Threshold of 5 is empirical, not principled.

const BRIEFING_MIN_MATCHES = 5

const BRIEFING_SYSTEM = `You are a sales intelligence analyst writing a Monday-morning briefing for a busy founder. Plain English. No markdown. No preamble. No greetings, no sign-off.

Output exactly 5 bullet lines, one per line, each starting with "•" and a single space. Each bullet is one or two sentences. Format:
• Dominant pain point: [theme that appeared most this week]
• Competitor opportunity: [which competitor got complaints? are any threads still unanswered?]
• Best unanswered thread: [title — url, still open to reply]
• Top lead this week: [author username · platform — why they matter]
• Recommended focus next week: [one concrete action the founder should take]

Stick to what the data shows. If a section has no data ("no competitor matches"), say so plainly in that bullet — don't invent.`

function trimMatchForPrompt(m) {
  return {
    title:         (m.title || '').slice(0, 200),
    url:           m.url,
    source:        m.source,
    subreddit:     m.subreddit,
    author:        m.author,
    keyword:       m.keyword,
    keywordType:   m.keywordType || 'keyword',
    sentiment:     m.sentiment   || null,
    intent:        m.intent      || null,
    postedAt:      m.postedAt    || null,
    gotEngagement: !!m.engagement?.gotEngagement,
  }
}

function briefingUserPrompt(monitor, stats, competitorMatches, authorProfiles) {
  const recentMatches = (stats.allMatches || []).slice(0, 30).map(trimMatchForPrompt)
  const competitorSummary = competitorMatches.slice(0, 10).map(trimMatchForPrompt)
  const authorSummary = authorProfiles.slice(0, 10).map(a => ({
    username: a.username, platform: a.platform,
    postCount: a.postCount, latestPostTitle: a.latestPostTitle,
  }))
  return `Monitor: ${monitor.name || '(untitled)'}
Product context: ${(monitor.productContext || '').slice(0, 400)}

Stats this week:
- Total matches: ${stats.total}
- Replies posted: ${stats.postedCount}
- Replies that got engagement: ${stats.engagedCount || 0}

Recent matches: ${JSON.stringify(recentMatches)}

Competitor matches: ${JSON.stringify(competitorSummary)}

Author profiles (people who posted multiple times): ${JSON.stringify(authorSummary)}

Write exactly 5 bullet points as specified.`
}

/**
 * Generate the strategic intelligence briefing via DeepSeek (routed through
 * ai-router with task='weekly_intelligence_briefing'). Returns null when:
 *   - The week had fewer than BRIEFING_MIN_MATCHES matches (skip threshold)
 *   - The router fails (digest still sends without the section)
 */
export async function buildIntelligenceBriefing({ monitor, stats, competitorMatches = [], authorProfiles = [] }) {
  if (!stats || stats.total < BRIEFING_MIN_MATCHES) return null
  const r = await routeAI({
    task: 'weekly_intelligence_briefing',
    system: BRIEFING_SYSTEM,
    prompt: briefingUserPrompt(monitor, stats, competitorMatches, authorProfiles),
    maxTokens: 600,
    temperature: 0.5,
  })
  if (r.ok && r.text) return r.text.trim()
  return null
}

/**
 * Split a raw briefing string into rendered bullet lines. Tolerant of:
 *   - Lines beginning with "•", "-", "*", or no prefix
 *   - Extra blank lines from the model
 *   - More or fewer than 5 lines (caps at 5)
 */
export function parseBriefingBullets(text) {
  if (!text) return []
  return text.split(/\r?\n+/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => line.replace(/^[•\-*]\s*/, ''))
    .slice(0, 5)
}

// ── Best-lead premium re-draft (Claude via ai-router) ───────────────────────

const REDRAFT_SYSTEM = `You are writing a single reply (2-4 sentences) on behalf of a founder. The post you're replying to is shown below, along with the founder's product context. Write a reply that sounds like a member of the community, not an ad. Mention the founder's product only if it's a natural fit — otherwise just be helpful. No markdown, no greetings ("Hey there!"), no sign-offs, no em-dashes.`

function redraftUserPrompt(match, monitor) {
  return `Founder's product context:
${(monitor.productContext || '').slice(0, 600)}

Post the founder might reply to:
Source: ${match.source || ''}${match.subreddit ? ' / ' + match.subreddit : ''}
Title: ${match.title || ''}
Body:  ${(match.body || '').slice(0, 600)}

Write the reply now.`
}

/**
 * Generate a fresh, premium-tier reply for the week's best lead. Returns
 * null if the router fails — caller should just omit the section in the
 * email rather than show a placeholder.
 */
export async function buildBestLeadDraft({ monitor, match }) {
  if (!match) return null
  const r = await routeAI({
    task: 'generate_premium_reply',
    system: REDRAFT_SYSTEM,
    prompt: redraftUserPrompt(match, monitor),
    maxTokens: 360,
    temperature: 0.7,
  })
  if (r.ok && r.text) return r.text.trim()
  return null
}

// ── Email rendering ─────────────────────────────────────────────────────────

const PLATFORM_LABEL = {
  reddit: 'Reddit', hackernews: 'Hacker News', medium: 'Medium', substack: 'Substack',
  quora: 'Quora', upwork: 'Upwork', fiverr: 'Fiverr', github: 'GitHub',
  producthunt: 'Product Hunt', twitter: 'Twitter/X', linkedin: 'LinkedIn',
}

const INTENT_LABEL = {
  asking_for_tool: 'Wants a Tool', buying: 'Buying Intent', complaining: 'Complaint',
  researching: 'Researching', venting: 'Venting', recommending: 'Recommending',
  unclassified: 'Unclassified',
}

const INTENT_COLOR = {
  asking_for_tool: '#92400e', buying: '#92400e', complaining: '#991b1b',
  researching: '#1d4ed8', venting: '#5b21b6', recommending: '#166534',
}

function dateRangeLabel(now = new Date()) {
  const end = new Date(now); end.setUTCHours(0, 0, 0, 0)
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 7)
  const fmt = d => d.toISOString().slice(0, 10)
  return `${fmt(start)} → ${fmt(end)}`
}

export function digestSubject(monitor, now = new Date()) {
  return `Your week on ${monitor.name || 'your monitor'} — ${dateRangeLabel(now)}`
}

/**
 * Render the digest HTML. Pure: no I/O, no AI calls. Inputs are the stat
 * block + (already-resolved) summary + (already-resolved) best-lead draft.
 */
export function renderDigestEmail({ monitor, stats, summary, bestLeadDraft, briefing, now = new Date() }) {
  const intentRows = Object.entries(stats.byIntent)
    .filter(([_, n]) => n > 0)
    .map(([k, n]) => `<tr><td style="padding:4px 12px 4px 0;color:${INTENT_COLOR[k] || '#475569'};font-weight:600;">${escapeHtml(INTENT_LABEL[k] || k)}</td><td style="padding:4px 0;color:#0F172A;font-variant-numeric:tabular-nums;">${n}</td></tr>`)
    .join('')

  const platformRows = Object.entries(stats.byPlatform)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<tr><td style="padding:4px 12px 4px 0;color:#475569;">${escapeHtml(PLATFORM_LABEL[k] || k)}</td><td style="padding:4px 0;color:#0F172A;font-variant-numeric:tabular-nums;">${n}</td></tr>`)
    .join('')

  const topMatchItems = stats.topMatches.map(m => {
    const intentChip = m.intent
      ? `<span style="display:inline-block;padding:2px 8px;background:#fef3c7;color:${INTENT_COLOR[m.intent] || '#475569'};border-radius:10px;font-size:10px;font-weight:700;letter-spacing:.2px;">${escapeHtml(INTENT_LABEL[m.intent] || m.intent)}</span>`
      : ''
    return `<div style="margin-bottom:14px;padding:12px;background:#f9f9f9;border-left:4px solid #FF6B35;border-radius:4px;">
      <div style="font-size:12px;color:#888;margin-bottom:5px;">
        ${escapeHtml(PLATFORM_LABEL[m.source] || m.source || '?')}${m.subreddit ? ' · ' + escapeHtml(m.subreddit) : ''}${intentChip ? ' ' + intentChip : ''}
      </div>
      <a href="${escapeHtml(m.url || '#')}" style="font-size:14px;font-weight:600;color:#1a1a1a;text-decoration:none;">${escapeHtml(m.title || '(no title)')}</a>
    </div>`
  }).join('')

  const bestLead = stats.bestLead
  const bestLeadBlock = (bestLead && bestLeadDraft)
    ? `<div style="margin:24px 0;padding:18px;background:#fffdf0;border:1px solid #e8d87a;border-radius:8px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#9A3412;margin-bottom:10px;">🎯 Best lead this week — suggested reply</div>
        <a href="${escapeHtml(bestLead.url || '#')}" style="display:block;font-size:14px;font-weight:600;color:#1a1a1a;text-decoration:none;margin-bottom:6px;">${escapeHtml(bestLead.title || '(no title)')}</a>
        <div style="font-size:12px;color:#888;margin-bottom:12px;">${escapeHtml(PLATFORM_LABEL[bestLead.source] || bestLead.source || '?')}${bestLead.subreddit ? ' · ' + escapeHtml(bestLead.subreddit) : ''}</div>
        <div style="font-size:13px;color:#333;line-height:1.65;white-space:pre-wrap;">${escapeHtml(bestLeadDraft)}</div>
      </div>`
    : ''

  // PR #30: 5-bullet strategic intelligence briefing block. Rendered above
  // the KPI tiles so the most actionable strategic context is the second
  // thing the founder reads (after the pattern summary).
  const briefingBullets = parseBriefingBullets(briefing)
  const briefingBlock = briefingBullets.length > 0
    ? `<div style="margin:0 0 24px;padding:18px 20px;background:#0F172A;color:#F1F5F9;border-radius:8px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#FF6B35;margin-bottom:12px;">⚡ This week's intelligence</div>
        ${briefingBullets.map(b => `<div style="font-size:13.5px;line-height:1.6;margin-bottom:8px;color:#E2E8F0;"><span style="color:#FF6B35;margin-right:8px;">•</span>${escapeHtml(b)}</div>`).join('')}
      </div>`
    : ''

  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:32px 24px;background:#f5f5f5;color:#1a1a1a;">
    <div style="margin-bottom:24px;padding:20px;background:#0e0e0e;border-radius:8px;">
      <div style="font-size:18px;font-weight:700;color:#FF6B35;">📡 Ebenova Insights — ${escapeHtml(monitor.name || 'your monitor')}</div>
      <div style="font-size:13px;color:#9a9690;margin-top:6px;">Weekly digest · ${dateRangeLabel(now)}</div>
    </div>

    <div style="padding:0 4px 16px;font-size:14px;color:#334155;line-height:1.65;">${escapeHtml(summary)}</div>

    ${briefingBlock}

    <div style="display:flex;flex-wrap:wrap;gap:16px;padding:16px 0;border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0;margin-bottom:24px;">
      <div style="flex:1;min-width:120px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#94A3B8;text-transform:uppercase;">Total matches</div>
        <div style="font-size:24px;font-weight:700;color:#0F172A;font-variant-numeric:tabular-nums;">${stats.total}</div>
      </div>
      <div style="flex:1;min-width:120px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#94A3B8;text-transform:uppercase;">Replies posted</div>
        <div style="font-size:24px;font-weight:700;color:#16A34A;font-variant-numeric:tabular-nums;">${stats.postedCount}</div>
      </div>
      ${stats.postedCount > 0 ? `<div style="flex:1;min-width:120px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#94A3B8;text-transform:uppercase;">Got engagement</div>
        <div style="font-size:24px;font-weight:700;color:#FF6B35;font-variant-numeric:tabular-nums;">${stats.engagedCount || 0}</div>
        <div style="font-size:10px;color:#94A3B8;font-family:'JetBrains Mono',monospace;letter-spacing:.5px;margin-top:2px;">${Math.round(((stats.engagedCount || 0) / stats.postedCount) * 100)}% reply rate</div>
      </div>` : ''}
    </div>

    ${intentRows ? `<div style="margin-bottom:24px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#94A3B8;text-transform:uppercase;margin-bottom:8px;">By intent</div>
      <table style="border-collapse:collapse;font-size:13px;">${intentRows}</table>
    </div>` : ''}

    ${platformRows ? `<div style="margin-bottom:24px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#94A3B8;text-transform:uppercase;margin-bottom:8px;">By platform</div>
      <table style="border-collapse:collapse;font-size:13px;">${platformRows}</table>
    </div>` : ''}

    ${bestLeadBlock}

    ${topMatchItems ? `<div style="margin-bottom:24px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#94A3B8;text-transform:uppercase;margin-bottom:10px;">Top matches</div>
      ${topMatchItems}
    </div>` : ''}

    ${buildEmailFooter(monitor.unsubscribeToken)}
  </body></html>`
}

// ── Orchestration ───────────────────────────────────────────────────────────

/**
 * Run the digest for a single monitor: gather data, build summary + best-lead
 * draft (if applicable), render email, send via Resend. Best-effort — any
 * failure logs and returns { sent: false, reason }.
 */
export async function runMonitorDigest({ monitor, redis, resend, fromEmail, now = new Date() }) {
  if (!monitor || !monitor.id) return { sent: false, reason: 'no-monitor' }
  if (monitor.emailEnabled === false) return { sent: false, reason: 'email-disabled' }
  if (!resend || !monitor.alertEmail) return { sent: false, reason: 'no-resend-or-recipient' }

  let stats
  try { stats = await gatherDigestData(monitor, redis) }
  catch (err) { console.warn(`[digest][${monitor.id}] gather failed: ${err.message}`); return { sent: false, reason: 'gather-failed' } }

  if (stats.total === 0) {
    // Skip the email entirely on a zero-match week. We don't want to ship
    // empty digests every Monday — that trains users to ignore them.
    console.log(`[digest][${monitor.id}] zero matches this week — skipping send`)
    return { sent: false, reason: 'zero-matches' }
  }

  const summary = await buildPatternSummary({ monitor, stats })
  const bestLeadDraft = stats.bestLead ? await buildBestLeadDraft({ monitor, match: stats.bestLead }) : null

  // PR #30: 5-bullet strategic intelligence briefing. Best-effort — null
  // result (light-data weeks or router failure) just means the briefing
  // section is omitted from the email.
  const competitorMatches = (stats.allMatches || []).filter(m => m.keywordType === 'competitor')
  const authorProfiles    = await gatherAuthorProfilesForDigest(monitor, redis)
  const briefing          = await buildIntelligenceBriefing({ monitor, stats, competitorMatches, authorProfiles })

  const html = renderDigestEmail({ monitor, stats, summary, bestLeadDraft, briefing, now })
  const subject = digestSubject(monitor, now)

  try {
    await resend.emails.send({
      from: `Ebenova Insights <${fromEmail}>`,
      to: monitor.alertEmail,
      subject,
      html,
    })
    console.log(`[digest][${monitor.id}] sent to ${monitor.alertEmail} — ${stats.total} matches, best-lead-draft=${bestLeadDraft ? 'yes' : 'no'}, briefing=${briefing ? 'yes' : 'no'}`)
    return { sent: true, total: stats.total, hadBestLead: !!bestLeadDraft, hadBriefing: !!briefing }
  } catch (err) {
    console.warn(`[digest][${monitor.id}] send failed: ${err.message}`)
    return { sent: false, reason: 'send-failed', error: err.message }
  }
}

/**
 * Loop all active monitors and run the digest for each. Per-monitor errors
 * are isolated — one bad monitor never crashes the cron.
 *
 * @returns {Promise<{ ran: number, sent: number, skipped: number }>}
 */
export async function runAllDigests({ redis, resend, fromEmail, now = new Date() }) {
  if (!redis) return { ran: 0, sent: 0, skipped: 0 }
  const stats = { ran: 0, sent: 0, skipped: 0 }
  let monitorIds = []
  try { monitorIds = (await redis.smembers('insights:active_monitors')) || [] }
  catch (err) { console.warn(`[digest] failed to load active monitors: ${err.message}`); return stats }

  for (const id of monitorIds) {
    stats.ran++
    let monitor
    try {
      const raw = await redis.get(`insights:monitor:${id}`)
      if (!raw) { stats.skipped++; continue }
      monitor = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!monitor.active) { stats.skipped++; continue }
    } catch (err) {
      console.warn(`[digest] failed to load monitor ${id}: ${err.message}`)
      stats.skipped++; continue
    }
    try {
      const r = await runMonitorDigest({ monitor, redis, resend, fromEmail, now })
      if (r.sent) stats.sent++; else stats.skipped++
    } catch (err) {
      // Defensive — runMonitorDigest catches its own errors but if anything
      // slips through here we still continue to the next monitor.
      console.warn(`[digest][${id}] uncaught: ${err.message}`)
      stats.skipped++
    }
  }
  return stats
}
