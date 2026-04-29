// lib/client-report.js — token-gated, white-label client report renderer.
//
// Public flow:
//   GET /report?token=xxx
//   → resolveReportToken(redis, token)
//   → gatherReportData(monitor, redis, days=30)
//   → buildExecutiveSummary({ monitor, stats })   [Claude via ai-router]
//   → renderReportHtml({ monitor, stats, summary })
//
// Branded as the monitor name, not "Ebenova Insights". The footer is the
// only Ebenova mention. White-label expectation: pass this URL to a client
// or post on a /share page; report is read-only and shows a 30-day window.
//
// Author profiles (PR #24) feed the "Author highlights" section. Empty when
// the monitor hasn't been running long enough for profiles to accumulate.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { routeAI } from './ai-router.js'
import { escapeHtml } from './html-escape.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_PATH = join(__dirname, '..', 'public', 'report-template.html')

let _templateCache = null
function loadTemplate() {
  if (_templateCache) return _templateCache
  _templateCache = readFileSync(TEMPLATE_PATH, 'utf8')
  return _templateCache
}
// Test hook — clear cache between cases so swap-in templates take effect.
export function _resetTemplateCache() { _templateCache = null }

const ONE_DAY_MS = 24 * 60 * 60 * 1000

const PLATFORM_LABEL = {
  reddit: 'Reddit', hackernews: 'Hacker News', medium: 'Medium', substack: 'Substack',
  quora: 'Quora', upwork: 'Upwork', fiverr: 'Fiverr', github: 'GitHub',
  producthunt: 'Product Hunt', twitter: 'Twitter/X', linkedin: 'LinkedIn',
}

const SENTIMENT_LABEL = {
  positive: 'Positive', negative: 'Negative', neutral: 'Neutral',
  frustrated: 'Frustrated', questioning: 'Questioning',
}
const INTENT_LABEL = {
  asking_for_tool: 'Wants a Tool', buying: 'Buying intent',
  complaining: 'Complaint', researching: 'Researching',
  venting: 'Venting', recommending: 'Recommending',
}

const HIGH_INTENTS = new Set(['asking_for_tool', 'buying'])

// ── Token storage ───────────────────────────────────────────────────────────

/**
 * Look up a monitor by its public share token. Returns the parsed monitor
 * record on success, null on any failure (missing token, missing key, deleted
 * monitor, malformed JSON).
 */
export async function resolveReportToken(redis, token) {
  if (!redis || !token || typeof token !== 'string') return null
  const clean = token.trim()
  if (clean.length < 8) return null    // sanity guard
  try {
    const monitorId = await redis.get(`report:token:${clean}`)
    if (!monitorId) return null
    const raw = await redis.get(`insights:monitor:${monitorId}`)
    if (!raw) return null
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (_) {
    return null
  }
}

// ── Data gathering ──────────────────────────────────────────────────────────

/**
 * Read the last N days of matches + author profiles for one monitor and
 * compute every stat the report renders.
 */
export async function gatherReportData(monitor, redis, days = 30) {
  const out = {
    monitorId: monitor?.id || '',
    days,
    total: 0,
    bySentiment: { positive: 0, negative: 0, neutral: 0, frustrated: 0, questioning: 0 },
    byIntent: { asking_for_tool: 0, buying: 0, complaining: 0, researching: 0, venting: 0, recommending: 0 },
    byPlatform: {},
    highIntent: 0,
    postedThisMonth: 0,
    platformsActive: 0,
    topMatches: [],
    authors: [],
    weeklyTrend: [],   // [{ weekLabel: '4 wks ago', count: N }, ..., { weekLabel: 'this week', count: N }]
  }
  if (!redis || !monitor?.id) return out

  const cutoff = Date.now() - days * ONE_DAY_MS
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

  // Sentiment, intent, platform counts
  for (const m of recent) {
    if (m.sentiment && Object.prototype.hasOwnProperty.call(out.bySentiment, m.sentiment)) {
      out.bySentiment[m.sentiment]++
    }
    if (m.intent && Object.prototype.hasOwnProperty.call(out.byIntent, m.intent)) {
      out.byIntent[m.intent]++
      if (HIGH_INTENTS.has(m.intent)) out.highIntent++
    }
    const platform = m.source || 'unknown'
    out.byPlatform[platform] = (out.byPlatform[platform] || 0) + 1
    if (m.postedAt) {
      const ts = new Date(m.postedAt).getTime()
      if (Number.isFinite(ts) && ts >= cutoff) out.postedThisMonth++
    }
  }
  out.platformsActive = Object.keys(out.byPlatform).length

  // Top 5 by intent priority (high-value first), then recency
  const INTENT_ORDER = { asking_for_tool: 0, buying: 1, researching: 2, complaining: 3, recommending: 4, venting: 5 }
  out.topMatches = recent.slice().sort((a, b) => {
    const ai = INTENT_ORDER[a.intent] ?? 99
    const bi = INTENT_ORDER[b.intent] ?? 99
    if (ai !== bi) return ai - bi
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  }).slice(0, 5)

  // Weekly trend: 4 buckets, each 7 days wide, oldest → newest
  const buckets = [0, 0, 0, 0]
  const now = Date.now()
  for (const m of recent) {
    const ts = new Date(m.createdAt || 0).getTime()
    if (!Number.isFinite(ts)) continue
    const ageDays = Math.floor((now - ts) / ONE_DAY_MS)
    if (ageDays < 7)       buckets[3]++
    else if (ageDays < 14) buckets[2]++
    else if (ageDays < 21) buckets[1]++
    else if (ageDays < 28) buckets[0]++
  }
  out.weeklyTrend = [
    { weekLabel: '4 wks ago',  count: buckets[0] },
    { weekLabel: '3 wks ago',  count: buckets[1] },
    { weekLabel: '2 wks ago',  count: buckets[2] },
    { weekLabel: 'this week',  count: buckets[3] },
  ]

  // Author highlights (top 3 by postCount). PR #24 author profiles are keyed
  // by author:profile:{monitorId}:{platform}:{username}; we list via the
  // author:list:{monitorId} set to avoid SCAN.
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
      const postCount = parseInt(hash.postCount, 10) || 0
      profiles.push({
        username,
        platform,
        postCount,
        firstSeen: hash.firstSeen || '',
        lastSeen: hash.lastSeen || '',
        consistency: classifyConsistency(postCount, hash.firstSeen, hash.lastSeen),
      })
    }
    profiles.sort((a, b) => b.postCount - a.postCount)
    out.authors = profiles.slice(0, 3)
  } catch (_) {
    out.authors = []   // best-effort — author profiles are optional
  }

  return out
}

function classifyConsistency(postCount, firstSeen, lastSeen) {
  if (postCount >= 5) return 'consistent'
  if (postCount >= 2) return 'occasional'
  return 'one-off'
}

// ── Executive summary (Claude via ai-router) ────────────────────────────────

const SUMMARY_SYSTEM = `You are writing a 3-sentence executive summary for a marketing report. Plain English, no jargon, no markdown, no bullet points, no greeting, no sign-off. Write for a marketing manager presenting to their client.`

function summaryUserPrompt(monitor, stats) {
  const platformList = Object.entries(stats.byPlatform).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([p, n]) => `${PLATFORM_LABEL[p] || p} (${n})`).join(', ') || 'none'
  const intentList = Object.entries(stats.byIntent).filter(([_, n]) => n > 0).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${INTENT_LABEL[k] || k}: ${n}`).join(', ') || 'no classified intents'
  const topPost = stats.topMatches[0]
  const example = topPost ? `Top post: "${(topPost.title || '').slice(0, 120)}" (${PLATFORM_LABEL[topPost.source] || topPost.source})` : 'No standout posts.'

  return `Monitor: ${monitor.name || '(untitled)'}
Product context: ${(monitor.productContext || '').slice(0, 400)}

30-day data:
- Total mentions: ${stats.total}
- Active platforms: ${platformList}
- Intent mix: ${intentList}
- High-intent leads (asking_for_tool + buying): ${stats.highIntent}
- Replies posted: ${stats.postedThisMonth}

${example}

Write the 3-sentence summary now.`
}

/**
 * Generate the AI executive summary. Falls back to a templated stat-based
 * paragraph if the router fails — never returns null so the report always
 * has a summary block.
 */
export async function buildExecutiveSummary({ monitor, stats }) {
  if (!stats || stats.total === 0) {
    return `${monitor.name || 'This monitor'} ran for the last ${stats?.days || 30} days but found no matches in that window. The watchers are running — most months see at least a handful of mentions, so the keyword set is the first thing worth a look.`
  }
  const r = await routeAI({
    task: 'generate_client_report',
    system: SUMMARY_SYSTEM,
    prompt: summaryUserPrompt(monitor, stats),
    maxTokens: 240,
    temperature: 0.6,
  })
  if (r.ok && r.text) return r.text.trim()
  // Fallback summary — stat-driven, three sentences.
  const platformCount = Object.keys(stats.byPlatform).length
  const intentTop = Object.entries(stats.byIntent).filter(([_, n]) => n > 0).sort((a, b) => b[1] - a[1])[0]
  const intentLine = intentTop ? `Most signals were classified as ${INTENT_LABEL[intentTop[0]] || intentTop[0]} (${intentTop[1]}).` : 'Intent classification covered most matches.'
  return `Over the last ${stats.days} days, ${monitor.name || 'this monitor'} surfaced ${stats.total} mentions across ${platformCount} platforms. ${intentLine} Of those, ${stats.highIntent} carried high-intent buying or tool-seeking signals worth a direct reply.`
}

// ── HTML rendering ──────────────────────────────────────────────────────────

function dateRangeLabel(days, now = new Date()) {
  const end = new Date(now); end.setUTCHours(0, 0, 0, 0)
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - days)
  const fmt = d => d.toISOString().slice(0, 10)
  return `${fmt(start)} → ${fmt(end)}`
}

function renderKpiTiles(stats) {
  const tiles = [
    { label: 'Total mentions',  value: stats.total,           cls: '' },
    { label: 'High-intent',     value: stats.highIntent,      cls: '' },
    { label: 'Replies posted',  value: stats.postedThisMonth, cls: 'success' },
    { label: 'Platforms active',value: stats.platformsActive, cls: '' },
  ]
  return tiles.map(t => `<div class="kpi"><div class="label">${t.label}</div><div class="value ${t.cls}">${t.value}</div></div>`).join('')
}

function renderBars(buckets, labelMap, totalCount) {
  const entries = Object.entries(buckets).filter(([_, n]) => n > 0)
  if (entries.length === 0) return '<div class="empty">No data in this window.</div>'
  // Sort by count desc so the dominant value is on top.
  entries.sort((a, b) => b[1] - a[1])
  const max = Math.max(...entries.map(([_, n]) => n))
  return entries.map(([key, n]) => {
    const pct = max > 0 ? Math.round((n / max) * 100) : 0
    return `<div class="bar-row">
      <div class="bar-label">${escapeHtml(labelMap[key] || key)}</div>
      <div class="bar-track"><div class="bar-fill ${escapeHtml(key)}" style="width: ${pct}%"></div></div>
      <div class="bar-count">${n}</div>
    </div>`
  }).join('')
}

function renderTopMatches(matches) {
  if (!matches || matches.length === 0) return '<div class="empty">No matches in the last 30 days.</div>'
  return matches.map(m => {
    const sourceLabel = PLATFORM_LABEL[m.source] || m.source || 'unknown'
    const subred = m.subreddit ? ` · ${escapeHtml(m.subreddit)}` : ''
    const intentChip = m.intent ? `<span class="badge" style="background:#FEF3C7;color:#92400E;">${escapeHtml(INTENT_LABEL[m.intent] || m.intent)}</span>` : ''
    const sentChip = m.sentiment ? `<span class="badge" style="background:#F1F5F9;color:#475569;">${escapeHtml(SENTIMENT_LABEL[m.sentiment] || m.sentiment)}</span>` : ''
    return `<div class="match">
      <div class="match-meta">${escapeHtml(sourceLabel)}${subred}${intentChip ? ' ' + intentChip : ''}${sentChip ? ' ' + sentChip : ''}</div>
      <a class="match-title" href="${escapeHtml(m.url || '#')}" target="_blank" rel="noreferrer">${escapeHtml(m.title || '(no title)')}</a>
    </div>`
  }).join('')
}

function renderAuthorHighlights(authors) {
  if (!authors || authors.length === 0) return '<div class="empty">Author tracking populates over time. Check back next month.</div>'
  return `<div class="author-grid">${authors.map(a => {
    const platform = PLATFORM_LABEL[a.platform] || a.platform
    return `<div class="author">
      <div class="name">${escapeHtml(a.username)}</div>
      <div class="meta">${escapeHtml(platform)} · ${a.postCount} post${a.postCount === 1 ? '' : 's'}</div>
      <span class="consistency">${escapeHtml(a.consistency)}</span>
    </div>`
  }).join('')}</div>`
}

function renderWeeklyTrend(trend) {
  const max = Math.max(1, ...trend.map(t => t.count))
  return `<div class="trend">${trend.map(t => {
    const pct = max > 0 ? Math.round((t.count / max) * 100) : 0
    return `<div class="trend-col">
      <div class="trend-count">${t.count}</div>
      <div class="trend-bar" style="height: ${pct}%"></div>
      <div class="trend-label">${escapeHtml(t.weekLabel)}</div>
    </div>`
  }).join('')}</div>`
}

/**
 * Substitute placeholders in the static template with the report's data.
 */
export function renderReportHtml({ monitor, stats, summary, appUrl, now = new Date() }) {
  const tpl = loadTemplate()
  const baseUrl = appUrl || process.env.APP_URL || 'https://ebenova.org'
  const unsubUrl = monitor.unsubscribeToken
    ? `${baseUrl.replace(/\/+$/, '')}/unsubscribe?token=${encodeURIComponent(monitor.unsubscribeToken)}`
    : `${baseUrl.replace(/\/+$/, '')}/`

  const subs = {
    MONITOR_NAME:      escapeHtml(monitor.name || 'Untitled monitor'),
    REPORT_LABEL:      `Performance report · ${stats.days}-day window`,
    DATE_RANGE:        dateRangeLabel(stats.days, now),
    EXECUTIVE_SUMMARY: escapeHtml(summary),
    KPI_TILES:         renderKpiTiles(stats),
    SENTIMENT_BARS:    renderBars(stats.bySentiment, SENTIMENT_LABEL),
    INTENT_BARS:       renderBars(stats.byIntent, INTENT_LABEL),
    TOP_MATCHES:       renderTopMatches(stats.topMatches),
    AUTHOR_HIGHLIGHTS: renderAuthorHighlights(stats.authors),
    WEEKLY_TREND:      renderWeeklyTrend(stats.weeklyTrend),
    UNSUB_URL:         escapeHtml(unsubUrl),
  }

  return tpl.replace(/\{\{(\w+)\}\}/g, (full, key) => {
    return Object.prototype.hasOwnProperty.call(subs, key) ? subs[key] : full
  })
}

// Internal exports for tests
export const _internals = {
  classifyConsistency, dateRangeLabel,
  renderKpiTiles, renderBars, renderTopMatches, renderAuthorHighlights, renderWeeklyTrend,
  PLATFORM_LABEL, SENTIMENT_LABEL, INTENT_LABEL,
}
