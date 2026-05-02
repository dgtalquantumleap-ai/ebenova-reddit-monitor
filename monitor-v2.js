// reddit-monitor/monitor-v2.js
// Multi-tenant Insights worker — polls Redis for active monitors,
// runs keyword searches for each, stores matches, sends email alerts.
//
// Runs on Railway alongside the existing monitor.js (v1 = Skido's own keywords).
// Start with: node monitor-v2.js
// Env vars needed: REDIS_URL, RESEND_API_KEY, GROQ_API_KEY, FROM_EMAIL

import { loadEnv } from './lib/env.js'

// Load .env via shared loader (dotenv) — replaces hand-rolled parser.
loadEnv()

// Hotfix-narrowed env validation. Hard-required set is the four vars
// whose absence makes the worker nonfunctional. FROM_EMAIL and APP_URL
// have working inline fallbacks (ebenova.org), so they're warn-only —
// PR #43's hard-fail on these caused a production outage.
import { requireEnv, warnEnv } from './lib/env-required.js'
requireEnv([
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'RESEND_API_KEY', 'GROQ_API_KEY',
])
warnEnv([
  { name: 'FROM_EMAIL', reason: 'defaults to insights@ebenova.org' },
  { name: 'APP_URL',    reason: 'defaults to https://ebenova.org' },
])

import { Resend }  from 'resend'
import { Redis }   from '@upstash/redis'
import cron        from 'node-cron'
import { sendSlackAlert }  from './lib/slack.js'
import searchMedium        from './lib/scrapers/medium.js'
import searchSubstack      from './lib/scrapers/substack.js'
import searchQuora         from './lib/scrapers/quora.js'
import searchUpwork        from './lib/scrapers/upwork.js'
import searchFiverr        from './lib/scrapers/fiverr.js'
import searchHackerNews    from './lib/scrapers/hackernews.js'
import searchGitHub        from './lib/scrapers/github.js'
import searchProductHunt   from './lib/scrapers/producthunt.js'
import searchTwitter       from './lib/scrapers/twitter.js'
import searchJijiNg        from './lib/scrapers/jijing.js'
import searchYouTube       from './lib/scrapers/youtube.js'
import searchAmazonReviews from './lib/scrapers/amazon.js'
// LinkedIn scraper exists at lib/scrapers/linkedin.js but is parked: no
// reliable open search backend indexes linkedin.com/posts/ from a server.
// Re-import + re-add to platformRunners and SOURCE_RANK once we wire up
// a real source.
import { migrateLegacyPlatforms, PLATFORM_LABELS, PLATFORM_EMOJIS } from './lib/platforms.js'
import { escapeHtml }      from './lib/html-escape.js'
import { sanitizeForPrompt } from './lib/llm-safe-prompt.js'
import { embeddingCacheKey } from './lib/embedding-cache.js'
import { makeCostCap } from './lib/cost-cap.js'
import { draftCall, extractInjectedUtmUrl } from './lib/draft-call.js'
import { parseRedditRSS, buildRedditSearchUrl, parseRetryAfter } from './lib/reddit-rss.js'
import { generateUnsubscribeToken, buildEmailFooter } from './lib/account-deletion.js'
import { classifyMatch, intentPriority, isHighPriority } from './lib/classify.js'
import { recordAuthor } from './lib/author-profiles.js'
import { fireWebhook, buildPayload as buildWebhookPayload } from './lib/outbound-webhook.js'
import { runAllDigests } from './lib/weekly-digest.js'
import { runVisibilitySweep } from './lib/ai-visibility.js'
import { isoWeekLabel } from './lib/keyword-types.js'
import { runEngagementSweep, processPendingChecks } from './lib/reply-tracker.js'
import { isBuilderPost, extractTopics, recordBuilderProfile, getBuilderProfiles, sendBuilderDigest, PLATFORMS_WITH_REAL_USERNAMES } from './lib/builder-tracker.js'
import { getCorridor } from './lib/diaspora-corridors.js'
import { buildBulkEmailExtras } from './lib/email-headers.js'

// F14: lazy daily cost caps. Soft-fail so the worker degrades gracefully
// (skip-draft / skip-email / skip-embedding) rather than crashing.
let _groqCap, _resendCap, _embedCap
function getGroqCap() {
  if (!redis) return null
  if (!_groqCap) _groqCap = makeCostCap(redis, { resource: 'groq', dailyMax: parseInt(process.env.GROQ_DAILY_MAX || '5000') })
  return _groqCap
}
function getResendCap() {
  if (!redis) return null
  if (!_resendCap) _resendCap = makeCostCap(redis, { resource: 'resend', dailyMax: parseInt(process.env.RESEND_DAILY_MAX || '90') })
  return _resendCap
}
function getEmbedCap() {
  if (!redis) return null
  if (!_embedCap) _embedCap = makeCostCap(redis, { resource: 'openai-embedding', dailyMax: parseInt(process.env.OPENAI_EMBEDDING_DAILY_MAX || '10000') })
  return _embedCap
}

const RESEND_API_KEY   = process.env.RESEND_API_KEY
const GROQ_API_KEY     = process.env.GROQ_API_KEY
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY   // embeddings for semantic search
const VOYAGE_API_KEY   = process.env.VOYAGE_API_KEY   // alternative: cheaper than OpenAI
const FROM_EMAIL       = process.env.FROM_EMAIL || 'insights@ebenova.org'
const POLL_MINUTES     = parseInt(process.env.POLL_INTERVAL_MINUTES || '15')
const MAX_SEEN         = 50_000
const SEMANTIC_ENABLED = !!(OPENAI_API_KEY || VOYAGE_API_KEY)

// F11: max age for Reddit semantic-search posts. Was hardcoded 60 min.
// Defaults to 3h (matches monitor.js default). Tune via POST_MAX_AGE_HOURS env.
const POST_MAX_AGE_HOURS = (() => {
  const h = parseInt(process.env.POST_MAX_AGE_HOURS || '3')
  return Number.isFinite(h) && h > 0 ? h : 3
})()
const POST_MAX_AGE_MS = POST_MAX_AGE_HOURS * 60 * 60 * 1000

// ── Redis client ──────────────────────────────────────────────────────────────
// Upstash REST only (same as Signova's lib/redis.js).
// Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN in Railway vars.
// If missing, returns null and multi-tenant features are disabled.
function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL  || process.env.REDIS_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN
  if (!url) return null
  return new Redis({ url, token })
}

const redis = getRedis()
if (!redis) console.log('[v2] ⚠️  Redis not configured — multi-tenant features disabled')

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null

// ── Seen IDs (global, resets on restart) ─────────────────────────────────────
// We track by monitorId + postId so different monitors don't block each other
const seenMap = new Map() // key: `${monitorId}:${postId}` → true

function hasSeen(monitorId, postId) {
  return seenMap.has(`${monitorId}:${postId}`)
}

// Redis-backed seen check — backfills memory so restarts don't re-alert (3-day TTL)
async function hasSeenWithRedis(monitorId, postId) {
  if (hasSeen(monitorId, postId)) return true
  if (!redis) return false
  try {
    const r = await redis.get(`seen:v2:${monitorId}:${postId}`)
    if (r) { seenMap.set(`${monitorId}:${postId}`, true); return true }
  } catch (_) {}
  return false
}

function markSeen(monitorId, postId) {
  seenMap.set(`${monitorId}:${postId}`, true)
  if (redis) redis.setex(`seen:v2:${monitorId}:${postId}`, 60 * 60 * 24 * 3, '1').catch(() => {})
  if (seenMap.size > MAX_SEEN) {
    // Prune oldest 10k entries
    const keys = [...seenMap.keys()].slice(0, 10000)
    keys.forEach(k => seenMap.delete(k))
    console.log(`[v2] 🧹 Pruned ${keys.length} seen entries`)
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms))

// ── Approved subreddits — never draft a reply if not on this list ─────────────
// Mirrors v1 whitelist. Monitor owners cannot override this.
const APPROVED_SUBREDDITS = new Set([
  'freelance','freelancers','smallbusiness','Entrepreneur','EntrepreneurRideAlong',
  'SoloDevelopment','agency','agencynewbies','Nigeria','lagos','naija','nairaland',
  'LandlordLady','webdev','SaaS','startups','IndieHackers','buildinpublic',
  'androiddev','iOSProgramming','Teachers','education','Professors','PublicSpeaking',
  'churchtech','photography','eventplanning','Weddings','AV','hometheater',
  'techsupport','SubstituteTeachers','OnlineLearning','edtech','wedding',
  'weddingplanning','Christianity','church','Reformed','DIY','weddingphotography',
  'cleaning','housekeeping','recruiting','HR','artificial','ClaudeAI','LocalLLaMA',
  'LangChain','CursorIDE','legaltech','fintech','Africa','Kenya','Ghana',
  'CryptoCurrency','Upwork','Fiverr','tax','CleaningBusiness','HVAC',
  // ── AI Recruiting / Jobs (added for Insights clients in this space) ────────
  'cscareerquestions','cscareeradvice','ExperiencedDevs','forhire',
  'MachineLearning','learnmachinelearning','datascience','MLjobs',
  'recruitinghell','jobsearchhacks','jobs','remotework','techjobs',
  'YCombinator','venturecapital','angels','product_management','ProductManagement',
  // ── Freelancers Union audience ───────────────────────────────────────
  'freelance','freelancers','graphic_design','writing','copywriting',
  'photography','videography','webdev','marketing','socialmediamanagement',
  'malelivingspace','digitalnomad','workingdigitalnomad',
])

// ── Semantic search (V2) ─────────────────────────────────────────────────────
// Uses text-embedding-3-small (OpenAI) or voyage-lite-02-instruct (Voyage AI)
// to find posts by intent rather than exact keyword match.
// Falls back to keyword search if embeddings are unavailable.

const embeddingCache = new Map() // cache embeddings to save API calls

function setCacheWithSoftCap(key, vec) {
  // F12: soft LRU — drop oldest 1000 entries when cache exceeds 5000.
  // Map iterates in insertion order, so the first keys are the oldest.
  embeddingCache.set(key, vec)
  if (embeddingCache.size > 5000) {
    let i = 0
    for (const k of embeddingCache.keys()) {
      if (i++ >= 1000) break
      embeddingCache.delete(k)
    }
  }
}

async function getEmbedding(text) {
  const key = embeddingCacheKey(text)  // F12: hash full text, not slice(0, 100)
  if (embeddingCache.has(key)) return embeddingCache.get(key)

  // F14: daily embedding cost cap — return null (caller falls back to keyword-only)
  const ecap = getEmbedCap()
  if (ecap) {
    const r = await ecap()
    if (!r.allowed) {
      console.warn(`[v2][semantic] OpenAI embedding daily cap hit (${r.used}/${r.max}) — keyword-only mode`)
      return null
    }
  }

  try {
    if (OPENAI_API_KEY) {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 2000) }),
      })
      if (!res.ok) return null
      const data = await res.json()
      const vec = data?.data?.[0]?.embedding || null
      if (vec) setCacheWithSoftCap(key, vec)
      return vec
    }

    if (process.env.VOYAGE_API_KEY) {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}` },
        body: JSON.stringify({ model: 'voyage-lite-02-instruct', input: [text.slice(0, 2000)] }),
      })
      if (!res.ok) return null
      const data = await res.json()
      const vec = data?.data?.[0]?.embedding || null
      if (vec) setCacheWithSoftCap(key, vec)
      return vec
    }
  } catch (err) {
    console.error('[v2][semantic] Embedding error:', err.message)
  }
  return null
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// Fetch recent posts from a subreddit and score them semantically against the keyword intent.
async function semanticSearchSubreddit(monitorId, subreddit, keywordEntry, queryEmbedding) {
  const results = []
  const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=25`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ebenova-insights/2.0 (semantic)' },
    })
    if (!res.ok) return results
    const data = await res.json()
    const posts = data?.data?.children || []
    const THRESHOLD = parseFloat(process.env.SEMANTIC_THRESHOLD || '0.35')

    for (const post of posts) {
      const p = post.data
      if (await hasSeenWithRedis(monitorId, p.id)) continue
      if (Date.now() - p.created_utc * 1000 > POST_MAX_AGE_MS) continue

      const postText = `${p.title} ${(p.selftext || '').slice(0, 400)}`
      const postEmbedding = await getEmbedding(postText)
      const score = cosineSimilarity(queryEmbedding, postEmbedding)

      if (score >= THRESHOLD) {
        markSeen(monitorId, p.id)
        results.push({
          id: p.id, title: p.title || '(no title)',
          url: `https://reddit.com${p.permalink}`,
          subreddit: p.subreddit, author: p.author,
          score: p.score, comments: p.num_comments,
          body: (p.selftext || '').slice(0, 600),
          createdAt: new Date(p.created_utc * 1000).toISOString(),
          keyword: keywordEntry.keyword,
          source: 'reddit',
          approved: APPROVED_SUBREDDITS.has(p.subreddit),
          semanticScore: Math.round(score * 100) / 100,
          searchMode: 'semantic',
        })
      }
      await delay(200) // small delay between embedding calls
    }
  } catch (err) {
    console.error(`[v2][semantic] Error scanning r/${subreddit}:`, err.message)
  }
  return results
}

// ── Reddit search ─────────────────────────────────────────────────────────────
// Returns new posts (< POST_MAX_AGE_MS old) not yet seen for this monitor.
//
// Uses Reddit's public RSS endpoints — no OAuth, no client_id, no env vars.
// Trade-off vs the JSON API: RSS feeds don't include score or comments
// count — those default to 0 in the result. Title/URL/subreddit/author/
// body/published-date are all present.
//
// Rate-limit policy: respect Retry-After header when Reddit returns 429/503;
// otherwise the existing 2-second post-call delay handles cadence.
//
// Failure logging: every non-2xx is logged with status + URL so cycle logs
// surface problems immediately (vs. silently returning Medium-only).
async function searchReddit(monitorId, keywordEntry) {
  const { keyword, subreddits = [] } = keywordEntry
  const results = []

  // One URL per named subreddit, or a single global search if none are set.
  const urls = subreddits.length > 0
    ? subreddits.map(sr => buildRedditSearchUrl(keyword, sr))
    : [buildRedditSearchUrl(keyword, null)]

  // Plain headers — no Bearer, no client_id. UA is still polite to send;
  // Reddit's RSS endpoints don't gate on it the way the JSON API does.
  const headers = {
    'User-Agent': process.env.REDDIT_USER_AGENT || 'Mozilla/5.0 (compatible; EbenovaBot/2.0)',
    'Accept': 'application/atom+xml,application/rss+xml,application/xml;q=0.9,text/xml;q=0.8',
  }

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers })
      if (!res.ok) {
        const retryAfter = parseRetryAfter(res.headers)
        console.warn(`[v2][reddit:rss] ${res.status} for "${keyword}" → ${url.slice(0, 100)}…${retryAfter ? ` (Retry-After: ${retryAfter}s)` : ''}`)
        await delay((retryAfter || 3) * 1000)
        continue
      }
      const xml = await res.text()
      const entries = parseRedditRSS(xml)
      let newCount = 0
      let agedOut = 0

      for (const entry of entries) {
        if (await hasSeenWithRedis(monitorId, entry.id)) continue
        const ageMs = Date.now() - new Date(entry.createdAt).getTime()
        if (ageMs > POST_MAX_AGE_MS) { agedOut++; continue }
        markSeen(monitorId, entry.id)
        newCount++
        results.push({
          id:        entry.id,
          title:     entry.title || '(no title)',
          url:       entry.url,
          subreddit: entry.subreddit,
          author:    entry.author,
          score:     0,        // RSS doesn't include score
          comments:  0,        // RSS doesn't include comment count
          body:      entry.body || '',
          createdAt: entry.createdAt,
          keyword,
          source:    'reddit',
          approved:  APPROVED_SUBREDDITS.has(entry.subreddit),
        })
      }
      console.log(`[v2][reddit:rss] "${keyword}" → ${entries.length} fetched, ${newCount} new, ${agedOut} stale${entries.length === 0 ? ' (empty feed)' : ''}`)
    } catch (err) {
      console.error(`[v2][reddit:rss] fetch error "${keyword}":`, err.message)
    }
    await delay(2000)
  }
  return results
}


// ── AI reply draft ────────────────────────────────────────────────────────────
// Uses monitor's productContext + tone so each customer's drafts are tailored.
// Delegates to lib/draft-call.js so behavior matches the on-demand /v1/matches/draft
// endpoint and Olumide's own monitor.js — single source of truth for prompt,
// validation, AI-tell ban list, and stripMarkdown post-processing.
// Returns { draft, model } so the caller can attach `draftedBy` to the match.
async function generateReplyDraft(post, productContext, tone, utmConfig) {
  if (!productContext || !productContext.trim()) return { draft: null, model: null }
  if (!post.approved) return { draft: null, model: null }

  // F14: daily Groq cost cap — skip draft (post still gets through)
  const gcap = getGroqCap()
  if (gcap) {
    const r = await gcap()
    if (!r.allowed) {
      console.warn(`[v2] Groq daily cap hit (${r.used}/${r.max}) — skipping draft`)
      return { draft: null, model: null }
    }
  }

  return draftCall({
    title:          post.title,
    body:           post.body,
    subreddit:      post.subreddit,
    productContext,
    productName:    post.productName, // optional; usually not present in v2
    tone,
    // PR #22: UTM injection — empty/undefined utmConfig keeps drafts unchanged.
    productUrl:     utmConfig?.productUrl,
    utmSource:      utmConfig?.utmSource,
    utmMedium:      utmConfig?.utmMedium,
    utmCampaign:    utmConfig?.utmCampaign,
    // PR #28: competitor-mode prompt addendum for matches from competitor keywords.
    competitorMode: utmConfig?.competitorMode === true,
  })
}

// ── Sentiment + intent badges (rendered next to source line) ────────────────
const SENTIMENT_BADGE = {
  positive:    { bg: '#dcfce7', color: '#166534', label: '😊 Positive' },
  negative:    { bg: '#fee2e2', color: '#991b1b', label: '😠 Negative' },
  neutral:     { bg: '#f1f5f9', color: '#475569', label: '😐 Neutral' },
  frustrated:  { bg: '#fff7ed', color: '#9a3412', label: '😤 Frustrated' },
  questioning: { bg: '#eff6ff', color: '#1d4ed8', label: '🤔 Questioning' },
}
const INTENT_BADGE = {
  asking_for_tool: { bg: '#fef3c7', color: '#92400e', label: '🎯 Wants a Tool' },
  buying:          { bg: '#fef3c7', color: '#92400e', label: '💰 Buying Intent' },
  complaining:     { bg: '#fee2e2', color: '#991b1b', label: '⚠️ Complaint' },
  researching:     { bg: '#eff6ff', color: '#1d4ed8', label: '🔍 Researching' },
  venting:         { bg: '#f5f3ff', color: '#5b21b6', label: '💬 Venting' },
  recommending:    { bg: '#dcfce7', color: '#166534', label: '👍 Recommending' },
}
function renderBadge(spec) {
  if (!spec) return ''
  return `<span style="display:inline-block;padding:2px 8px;margin-left:6px;background:${spec.bg};color:${spec.color};border-radius:10px;font-size:10px;font-weight:700;letter-spacing:.2px;">${spec.label}</span>`
}

// ── Email builder — per-monitor, minimal ─────────────────────────────────────
function buildAlertEmail(monitor, matches) {
  const byKeyword = {}
  for (const m of matches) {
    if (!byKeyword[m.keyword]) byKeyword[m.keyword] = []
    byKeyword[m.keyword].push(m)
  }

  const keywordSections = Object.entries(byKeyword).map(([kw, posts]) => {
    const items = posts.map(p => {
      const sourceLabel =
        p.source === 'hackernews'  ? '🟠 HN'
      : p.source === 'medium'      ? '📰 Medium'
      : p.source === 'substack'    ? '📧 Substack'
      : p.source === 'quora'       ? '💬 Quora'
      : p.source === 'upwork'      ? '💼 Upwork'
      : p.source === 'fiverr'      ? '🟢 Fiverr'
      : p.source === 'github'      ? '🐙 GitHub'
      : p.source === 'producthunt' ? '🚀 Product Hunt'
      : `r/${escapeHtml(p.subreddit)}`
      const sentimentBadge = renderBadge(SENTIMENT_BADGE[p.sentiment])
      const intentBadge    = renderBadge(INTENT_BADGE[p.intent])
      const highPriBadge   = isHighPriority(p)
        ? `<span style="display:inline-block;padding:2px 8px;margin-left:6px;background:#fee2e2;color:#991b1b;border-radius:10px;font-size:10px;font-weight:800;letter-spacing:.3px;">🔥 HIGH PRIORITY</span>`
        : ''
      return `
      <div style="margin-bottom:18px;padding:14px;background:#f9f9f9;border-left:4px solid #FF6B35;border-radius:4px;">
        <div style="font-size:12px;color:#888;margin-bottom:5px;">
          ${sourceLabel} · u/${escapeHtml(p.author)} · ${escapeHtml(p.score)} upvotes${sentimentBadge}${intentBadge}${highPriBadge}
        </div>
        <a href="${escapeHtml(p.url)}" style="font-size:15px;font-weight:600;color:#1a1a1a;text-decoration:none;">${escapeHtml(p.title)}</a>
        ${p.body ? `<p style="font-size:13px;color:#555;margin:7px 0 0;line-height:1.5;">${escapeHtml(p.body)}${p.body.length >= 300 ? '…' : ''}</p>` : ''}
        <a href="${escapeHtml(p.url)}" style="display:inline-block;margin-top:8px;font-size:12px;color:#FF6B35;font-weight:600;">Open thread →</a>
        ${!p.approved ? `
        <div style="margin-top:8px;padding:6px 10px;background:#fdecea;border:1px solid #f5c6cb;border-radius:4px;font-size:12px;font-weight:700;color:#c0392b;">
          ⚠️ DO NOT POST — ${escapeHtml(p.subreddit)} is not an approved subreddit
        </div>` : ''}
        ${p.draft ? `
        <div style="margin-top:10px;padding:12px;background:#fffdf0;border:1px solid #e8d87a;border-radius:6px;">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#a08c00;margin-bottom:6px;">✏️ Suggested reply</div>
          <div style="font-size:13px;color:#333;line-height:1.6;white-space:pre-wrap;">${escapeHtml(p.draft)}</div>
        </div>` : ''}
      </div>`
    }).join('')
    return `
      <div style="margin-bottom:28px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#aaa;margin-bottom:10px;">"${escapeHtml(kw)}" (${posts.length})</div>
        ${items}
      </div>`
  }).join('')

  // Platform badges — only show platforms this monitor is actively scanning.
  // Pulled from monitor.platforms (or migrated from legacy includeXxx flags).
  const activePlatforms = migrateLegacyPlatforms(monitor)
  const platformBadges = activePlatforms
    .map(key => {
      const label = PLATFORM_LABELS[key] || key
      const emoji = PLATFORM_EMOJIS[key] || ''
      return `<span style="display:inline-block;padding:3px 9px;margin:2px 3px 2px 0;background:rgba(255,107,53,.10);color:#FF6B35;border:1px solid rgba(255,107,53,.30);border-radius:11px;font-size:11px;font-weight:600;">${emoji} ${label}</span>`
    })
    .join('')

  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:32px 24px;background:#f5f5f5;color:#1a1a1a;">
    <div style="margin-bottom:24px;padding:20px;background:#0e0e0e;border-radius:8px;">
      <div style="font-size:18px;font-weight:700;color:#FF6B35;">📡 Ebenova Insights — ${escapeHtml(monitor.name)}</div>
      <div style="font-size:13px;color:#9a9690;margin-top:6px;">${matches.length} new mention${matches.length !== 1 ? 's' : ''} · ${new Date().toUTCString()}</div>
      <div style="margin-top:10px;">${platformBadges}</div>
    </div>
    ${monitor._opportunitySummary ? `
    <div style="
      margin: 0 0 24px 0;
      padding: 16px 20px;
      background: #111827;
      border-left: 4px solid #f59e0b;
      border-radius: 6px;
    ">
      <div style="
        font-size: 11px;
        font-weight: 700;
        color: #f59e0b;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        margin-bottom: 8px;
      ">🎯 Opportunity Detected</div>
      <div style="
        font-size: 14px;
        color: #e5e7eb;
        line-height: 1.65;
      ">${escapeHtml(monitor._opportunitySummary)}</div>
    </div>
    ` : ''}
    ${keywordSections}
    ${buildEmailFooter(monitor.unsubscribeToken)}
  </body></html>`
}

// ── Store matches in Redis ─────────────────────────────────────────────────────
// Each match stored as insights:match:{monitorId}:{postId} with 7-day TTL.
// The list insights:matches:{monitorId} tracks all match IDs for that monitor.
async function storeMatches(redis, monitor, matches) {
  const TTL = 60 * 60 * 24 * 7 // 7 days
  const pipeline = []
  for (const m of matches) {
    const key = `insights:match:${monitor.id}:${m.id}`
    await redis.set(key, JSON.stringify({ ...m, monitorId: monitor.id, storedAt: new Date().toISOString() }))
    await redis.expire(key, TTL)
    await redis.lpush(`insights:matches:${monitor.id}`, m.id)
    await redis.expire(`insights:matches:${monitor.id}`, TTL)
  }
  // Trim the list to last 500 match IDs
  await redis.ltrim(`insights:matches:${monitor.id}`, 0, 499)
}

// ── Send alert email to monitor owner ────────────────────────────────────────
async function sendMonitorAlert(monitor, matches) {
  // Per-monitor email opt-out. The matches still get scanned, drafted, and
  // stored in Redis (dashboard still surfaces them) — only the email send
  // is skipped. Slack alerts continue if a webhook is configured.
  if (monitor.emailEnabled === false) {
    console.log(`[v2][${monitor.id}] email disabled for monitor ${monitor.id} — skipping alert`)
    return
  }
  if (!resend) {
    console.log(`[v2][${monitor.id}] No resend key — printing ${matches.length} matches to console`)
    matches.forEach(m => console.log(`  [${m.keyword}] ${m.title} — ${m.url}`))
    return
  }

  // Backfill: monitors created before the unsubscribe-token feature shipped
  // don't have a token. Generate one lazily here so every alert email has a
  // working unsub link from the first send forward.
  if (!monitor.unsubscribeToken && redis) {
    try {
      const token = generateUnsubscribeToken()
      monitor.unsubscribeToken = token
      await redis.set(`unsubscribe:${token}`, monitor.id)
      const fresh = await redis.get(`insights:monitor:${monitor.id}`)
      if (fresh) {
        const parsed = typeof fresh === 'string' ? JSON.parse(fresh) : fresh
        await redis.set(`insights:monitor:${monitor.id}`, JSON.stringify({ ...parsed, unsubscribeToken: token }))
      }
      console.log(`[v2][${monitor.id}] backfilled unsubscribeToken`)
    } catch (err) {
      console.warn(`[v2][${monitor.id}] token backfill failed: ${err.message}`)
    }
  }

  const keywords = [...new Set(matches.map(m => m.keyword))]
  // Subject signals high-value intent so the operator sees the best matches
  // before opening the email. 🎯 prefix when any match is asking_for_tool /
  // buying; otherwise plain.
  const highValueCount = matches.filter(m => m.intent === 'asking_for_tool' || m.intent === 'buying').length
  const prefix = highValueCount > 0 ? '🎯 ' : ''
  const intentNote = highValueCount > 0
    ? ` (${highValueCount} buying intent)`
    : ''
  const subject = `${prefix}Insights: ${matches.length} new mention${matches.length !== 1 ? 's' : ''}${intentNote} — ${keywords.slice(0, 3).join(', ')}${keywords.length > 3 ? '…' : ''}`

  // F14: daily Resend cost cap — skip send (matches still stored in Redis,
  // dashboard still shows them, Slack alert if configured still fires).
  const rcap = getResendCap()
  if (rcap) {
    const r = await rcap()
    if (!r.allowed) {
      console.warn(`[v2][${monitor.id}] Resend daily cap hit (${r.used}/${r.max}) — skipping email send`)
      return
    }
  }

  // FIX 5 — guard alertEmail. If a legacy monitor record is missing this
  // field, Resend gets to: undefined and throws. Skip the send instead;
  // matches still go to dashboard + Slack as configured.
  if (!monitor.alertEmail) {
    console.warn(`[v2][${monitor.id}] No alertEmail on monitor — skipping email`)
    return
  }
  try {
    const html = buildAlertEmail(monitor, matches)
    const appUrl = process.env.APP_URL
    const unsubUrl = monitor.unsubscribeToken
      ? `${appUrl}/unsubscribe?token=${encodeURIComponent(monitor.unsubscribeToken)}`
      : `${appUrl}/`
    await resend.emails.send({
      from:    `Ebenova Insights <${FROM_EMAIL}>`,
      to:      monitor.alertEmail,
      subject,
      html,
      ...buildBulkEmailExtras({ html, unsubscribeUrl: unsubUrl }),
    })
    console.log(`[v2][${monitor.id}] Alert sent to ${monitor.alertEmail} — ${matches.length} matches`)
  } catch (err) {
    console.error(`[v2][${monitor.id}] Failed to send alert:`, err.message)
  }
}

// ── Run a single monitor ──────────────────────────────────────────────────────
// Fetches all keywords for a monitor, searches Reddit + Nairaland,
// generates drafts, stores matches, sends alert if any found.
// PR #31: Builder Tracker mode constants. When monitor.mode === 'builder_tracker'
// these replace the user's keywords/subreddits — Builder Tracker is opinionated
// about what to look for ("people sharing what they're building"), not
// configurable on a per-monitor basis.
const BUILDER_KEYWORDS = [
  'building in public', 'buildinpublic', 'launched my',
  'shipped today', 'just launched', 'soft launch',
  'day 1 of building', 'week 1 of building',
  'my saas', 'my startup', 'side project update',
  'indie hacker', 'working on a product',
  'just released', 'MVP launch', 'product update',
]
const BUILDER_SUBREDDITS = [
  'buildinpublic', 'SideProject', 'startups',
  'IndieHackers', 'SaaS', 'webdev', 'entrepreneur',
]

async function runBuilderTrackerMonitor(monitor) {
  const label = `[v2][${monitor.id}][${monitor.name}][builder]`
  console.log(`${label} Starting Builder Tracker mode`)

  const allMatches = []
  const seenIds = { has: id => hasSeen(monitor.id, id), add: id => markSeen(monitor.id, id) }
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000   // 7 days — builder posts have longer relevance

  // Builder Tracker uses a hardcoded keyword + subreddit set. Each pseudo-
  // keyword carries the BUILDER_SUBREDDITS so Reddit RSS searches them.
  const builderKws = BUILDER_KEYWORDS.map(k => ({
    keyword: k,
    subreddits: BUILDER_SUBREDDITS,
    productContext: monitor.productContext || '',
    type: 'keyword',
  }))

  // Reddit
  for (const kw of builderKws) {
    const matches = await searchReddit(monitor.id, kw)
    matches.forEach(m => allMatches.push(m))
    await delay(2000)
  }

  // Other supported platforms — only the ones with real usernames per spec.
  const builderPlatformRunners = [
    { key: 'hackernews',  scraper: searchHackerNews,  delayMs: 1500 },
    { key: 'github',      scraper: searchGitHub,      delayMs: 2000 },
    { key: 'producthunt', scraper: searchProductHunt, delayMs: 2000 },
    { key: 'twitter',     scraper: searchTwitter,     delayMs: 2500 },
    { key: 'substack',    scraper: searchSubstack,    delayMs: 1500 },
  ]
  for (const { key, scraper, delayMs } of builderPlatformRunners) {
    if (!PLATFORMS_WITH_REAL_USERNAMES.includes(key)) continue
    for (const kw of builderKws) {
      const matches = await scraper(kw, { seenIds, delay, MAX_AGE_MS: maxAgeMs })
      matches.forEach(m => allMatches.push(m))
      await delay(delayMs)
    }
  }
  console.log(`${label} ${allMatches.length} candidate matches gathered`)

  // Cheap heuristic filter — drops complaint / help-seeking posts.
  const builderMatches = allMatches.filter(isBuilderPost)
  console.log(`${label} ${builderMatches.length} pass builder filter`)

  // Extract topics and record profiles. Best-effort: per-match failures
  // log inside the helpers but don't abort the cycle.
  const newProfiles = []
  let recorded = 0
  const redisClient = getRedis()
  for (const match of builderMatches) {
    if (!PLATFORMS_WITH_REAL_USERNAMES.includes(match.source)) continue
    const topics = await extractTopics(match)
    const r = await recordBuilderProfile({ redis: redisClient, monitorId: monitor.id, match, topics })
    if (r?.recorded) {
      recorded++
      if (r.isNew) {
        newProfiles.push({
          username: match.author, platform: match.source,
          postCount: r.postCount, consistency: r.consistency, topics,
          latestPostTitle: match.title, latestPostUrl: match.url,
          profileUrl: '',  // sendBuilderDigest renders without unless we look it up
        })
      }
    }
  }
  console.log(`${label} ${recorded} profiles recorded (${newProfiles.length} new)`)

  // Update monitor's lastPollAt + totalBuildersFound.
  try {
    if (redisClient) {
      const updatedMonitor = {
        ...monitor,
        lastPollAt: new Date().toISOString(),
        totalBuildersFound: (monitor.totalBuildersFound || 0) + newProfiles.length,
      }
      await redisClient.set(`insights:monitor:${monitor.id}`, JSON.stringify(updatedMonitor))
    }
  } catch (err) {
    console.error(`${label} Redis store error:`, err.message)
  }

  // Send digest only when we actually found new builders this cycle —
  // builders are time-sensitive but a "0 new" email trains users to ignore.
  if (newProfiles.length > 0 && resend) {
    const topProfiles = await getBuilderProfiles({ redis: redisClient, monitorId: monitor.id, limit: 3 })
    const r = await sendBuilderDigest({
      monitor, newProfiles, topProfiles, resend, fromEmail: FROM_EMAIL,
      appUrl: process.env.APP_URL,
    })
    if (r.sent) console.log(`${label} Builder digest sent — ${r.count} new`)
  }
}

// FIX 3 — Per-monitor daily cycle cap. One runaway monitor with 100
// keywords polled every 15 minutes can exhaust the global Groq budget for
// every other tenant. This cap fires at the top of runMonitor() and aborts
// the cycle if the monitor has already run 500 times today (≈ every poll
// for 5+ days at 15-minute intervals — generous, but a cliff for runaways).
let _perMonitorCap = null
function getPerMonitorCap() {
  if (!redis) return null
  if (!_perMonitorCap) {
    _perMonitorCap = (monitorId) => makeCostCap(redis, {
      resource: `monitor:${monitorId}`,
      dailyMax: parseInt(process.env.MONITOR_DAILY_CYCLE_MAX || '500'),
    })()
  }
  return _perMonitorCap
}

async function runMonitor(monitor) {
  // PR #31: Builder Tracker mode — completely separate processing path.
  // Skips classification + drafts + alerts; instead extracts topics and
  // records per-author profiles in Redis. Sends a builder-digest email
  // when new profiles are recorded.
  if (monitor.mode === 'builder_tracker') {
    return runBuilderTrackerMonitor(monitor)
  }

  // FIX 3 — per-monitor daily cycle cap. Cheap pre-check to abort early
  // if this monitor has already exhausted its daily allowance. The cap
  // INCRs on every check so the next call moves the counter forward.
  const capCheck = getPerMonitorCap()
  if (capCheck) {
    try {
      const r = await capCheck(monitor.id)
      if (!r.allowed) {
        console.warn(`[v2][${monitor.id}] daily cycle cap hit (${r.used}/${r.max}) — skipping cycle`)
        return
      }
    } catch (err) {
      console.warn(`[v2][${monitor.id}] per-monitor cap check failed: ${err.message}`)
    }
  }

  // Reply outcome tracking: drain this monitor's pending engagement-check
  // queue at the top of every cycle. Items scheduled at posted-time +24h
  // get fetched, written back, and removed; items not yet due get re-pushed.
  // Best-effort — failures are logged but never block the scrape pipeline.
  if (redis) {
    try {
      const r = await processPendingChecks({ redis, monitorId: monitor.id })
      if (r.scanned > 0) {
        console.log(`[v2][${monitor.id}][reply-tracker] scanned=${r.scanned} processed=${r.processed} ok=${r.ok} failed=${r.failed} deferred=${r.deferred}`)
      }
    } catch (err) {
      console.warn(`[v2][${monitor.id}][reply-tracker] processPending failed: ${err.message}`)
    }
  }

  const label = `[v2][${monitor.id}][${monitor.name}]`

  // PR #36 — diaspora corridor override. When set, we swap in the
  // corridor's keywords + platforms for THIS cycle only (don't mutate the
  // stored monitor record — the user can flip the corridor off and recover
  // their original config). Reddit subreddits are also swapped via a
  // corridor override consulted by searchReddit below.
  const corridor = getCorridor(monitor.diasporaCorridor)
  if (corridor) {
    monitor = {
      ...monitor,
      // searchReddit reads subreddits off the keyword entry, so attach the
      // corridor's subreddit list to every keyword for this cycle.
      keywords:   corridor.keywords.map(term => ({
        keyword:    term,
        type:       'keyword',
        subreddits: corridor.subreddits,
      })),
      platforms:  corridor.platforms,
    }
    console.log(`[v2][${monitor.id}] Diaspora corridor active: ${corridor.label}`)
  }

  // Resolve which platforms this monitor wants. New monitors set platforms[]
  // explicitly; legacy monitors (no platforms field) get migrated from their
  // includeXxx flags. See lib/platforms.js for the rules.
  const platforms = migrateLegacyPlatforms(monitor)
  console.log(`${label} Starting — ${monitor.keywords.length} keywords, ${platforms.length} platforms: ${platforms.join(', ')}`)
  const allMatches = []
  const seenIds = { has: (id) => hasSeen(monitor.id, id), add: (id) => markSeen(monitor.id, id) }
  const maxAgeMs = 24 * 60 * 60 * 1000 // 24h for v2 monitors

  // Reddit — explicitly opt-in per platforms array. No longer always-on.
  if (platforms.includes('reddit')) {
    for (const kw of monitor.keywords) {
      const ctx = kw.productContext || monitor.productContext || ''
      const kwType = kw.type || 'keyword'
      const redditMatches = await searchReddit(monitor.id, kw)
      for (const m of redditMatches) {
        m.productContext = ctx
        m.keywordType = kwType   // PR #28
        allMatches.push(m)
      }
      if (redditMatches.length > 0) {
        console.log(`${label} Reddit "${kw.keyword}"${kwType === 'competitor' ? ' [competitor]' : ''}: ${redditMatches.length} new`)
      }
      await delay(2000)

      // Reddit — semantic search (V2, runs if embeddings configured + monitor on growth/scale plan)
      const semanticEnabled = SEMANTIC_ENABLED && ['growth', 'scale'].includes(monitor.plan)
      if (semanticEnabled && kw.subreddits?.length > 0) {
        const queryEmbedding = await getEmbedding(
          `${kw.keyword} ${kw.productContext || monitor.productContext || ''}`.slice(0, 500)
        )
        if (queryEmbedding) {
          for (const sr of kw.subreddits.slice(0, 5)) {
            const semanticMatches = await semanticSearchSubreddit(monitor.id, sr, kw, queryEmbedding)
            for (const m of semanticMatches) {
              m.productContext = ctx
              m.keywordType = kwType   // PR #28
              allMatches.push(m)
            }
            if (semanticMatches.length > 0) {
              console.log(`${label} Semantic r/${sr} "${kw.keyword}": ${semanticMatches.length} new`)
            }
            await delay(1500)
          }
        }
      }
    }
  }

  // ── Other platforms ──────────────────────────────────────────────────────
  // Each entry pairs a platforms[] key with its scraper + post-call delay.
  // Order matters for cycle pacing and source-rank sort. Keep Reddit at top
  // (handled above), then HN, Quora, Medium, Substack, Upwork, Fiverr,
  // GitHub, ProductHunt — matches SOURCE_RANK below.
  const platformRunners = [
    { key: 'hackernews',  scraper: searchHackerNews,  delayMs: 1500 },
    { key: 'medium',      scraper: searchMedium,      delayMs: 1500 },
    { key: 'substack',    scraper: searchSubstack,    delayMs: 1500 },
    { key: 'quora',       scraper: searchQuora,       delayMs: 2000 },
    { key: 'upwork',      scraper: searchUpwork,      delayMs: 3000 },
    { key: 'fiverr',      scraper: searchFiverr,      delayMs: 3000 },
    { key: 'github',      scraper: searchGitHub,      delayMs: 2000 },
    { key: 'producthunt', scraper: searchProductHunt, delayMs: 2000 },
    { key: 'twitter',     scraper: searchTwitter,     delayMs: 2500 },
    // Jiji.ng — Nigerian classifieds. High signal for real-estate, fashion,
    // electronics, food, beauty verticals. Scraper does its own polite delay
    // when it returns results, so the runner-level delay is the lower bound.
    { key: 'jijing',      scraper: searchJijiNg,      delayMs: 2000 },
    // YouTube — Data API v3, video + comment matches. Self-throttles
    // between commentThreads calls; runner-level delayMs is the lower bound.
    { key: 'youtube',     scraper: searchYouTube,     delayMs: 1500 },
    // Amazon reviews — opt-in only. Aggressive rate limiter, 3s scraper-
    // internal throttle between requests; runner-level delayMs is the
    // upper bound between keywords. Never appears in default platform sets.
    { key: 'amazon',      scraper: searchAmazonReviews, delayMs: 3500 },
  ]

  for (const { key, scraper, delayMs } of platformRunners) {
    if (!platforms.includes(key)) continue
    for (const kw of monitor.keywords) {
      const ctx = kw.productContext || monitor.productContext || ''
      const kwType = kw.type || 'keyword'   // PR #28
      const matches = await scraper(kw, { seenIds, delay, MAX_AGE_MS: maxAgeMs })
      matches.forEach(m => { m.productContext = ctx; m.keywordType = kwType; allMatches.push(m) })
      if (matches.length) console.log(`${label} ${PLATFORM_LABELS[key] || key} "${kw.keyword}"${kwType === 'competitor' ? ' [competitor]' : ''}: ${matches.length} new`)
      await delay(delayMs)
    }
  }

  if (allMatches.length === 0) {
    console.log(`${label} No new matches`)
    return
  }

  // ── Classify sentiment + intent (best-effort, before drafting) ───────────
  // Why before drafting: priority sort uses intent. Why best-effort: classify
  // failure must never block storage or email. Cap-aware via shared groq cap.
  // FIX 8 — concurrency dropped from 5 to 2. Five concurrent Groq calls per
  // batch × 2 monitors-in-parallel = 10 concurrent Groq requests, which
  // bursts past Groq's free-tier 30/min ceiling. 2 × 2 = 4 keeps us safely
  // under and lets the cost-cap layer absorb the rest.
  const CLASSIFY_CONCURRENCY = 2
  const groqCapForClassify = getGroqCap()
  for (let i = 0; i < allMatches.length; i += CLASSIFY_CONCURRENCY) {
    const batch = allMatches.slice(i, i + CLASSIFY_CONCURRENCY)
    await Promise.all(batch.map(async m => {
      const result = await classifyMatch({
        title: m.title,
        body: m.body,
        source: m.source,
        costCapCheck: groqCapForClassify || undefined,
      })
      if (result) {
        m.sentiment = result.sentiment
        m.intent = result.intent
        m.intentConfidence = result.confidence
      }
    }))
    if (i + CLASSIFY_CONCURRENCY < allMatches.length) await delay(300)
  }
  // Cycle summary so operator can see the intent mix at a glance
  const highValue = allMatches.filter(m => m.intent === 'asking_for_tool' || m.intent === 'buying').length
  const complaining = allMatches.filter(m => m.intent === 'complaining').length
  const otherClassified = allMatches.filter(m => m.intent && m.intent !== 'asking_for_tool' && m.intent !== 'buying' && m.intent !== 'complaining').length
  console.log(`${label} Classified ${allMatches.length} matches: ${highValue} buying/asking_for_tool, ${complaining} complaining, ${otherClassified} other`)

  console.log(`${label} ${allMatches.length} total matches — generating drafts…`)

  // FIX 8 — draft concurrency dropped from 3 to 2 to match the classify
  // concurrency. Same Groq rate-limit math.
  const CONCURRENCY = 2
  for (let i = 0; i < allMatches.length; i += CONCURRENCY) {
    const batch = allMatches.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async m => {
      const r = await generateReplyDraft(m, m.productContext, monitor.replyTone, {
        productUrl:  monitor.productUrl,
        utmSource:   monitor.utmSource,
        utmMedium:   monitor.utmMedium,
        utmCampaign: monitor.utmCampaign,
        // PR #28: keyword-type aware draft prompt for competitor matches.
        competitorMode: m.keywordType === 'competitor',
      })
      m.draft = r.draft
      m.draftedBy = r.model
      // PR (deferred-fixes): persist the UTM-injected product URL alongside
      // the draft. This is the data foundation for click-tracking — a
      // redirect layer can read match.utmUrl directly instead of re-parsing
      // the draft on every page view. Null if no UTM URL was injected.
      if (m.draft && monitor.productUrl) {
        const utmUrl = extractInjectedUtmUrl({ draft: m.draft, productUrl: monitor.productUrl })
        if (utmUrl) {
          m.utmUrl = utmUrl
          m.utmInjectedAt = new Date().toISOString()
        }
      }
      if (m.draft) console.log(`${label} Draft by ${r.model}: "${m.title.slice(0, 50)}…"`)
    }))
    if (i + CONCURRENCY < allMatches.length) await delay(1000)
  }

  // Unanswered thread detection — replyCount=0 AND post is <2h old.
  // RSS feeds don't expose comment counts so replyCount defaults to 0
  // for all RSS sources; isUnanswered is most reliable for JSON-API sources.
  const _nowMs = Date.now()
  for (const m of allMatches) {
    m.replyCount = m.comments || 0
    const _ageMs = _nowMs - new Date(m.createdAt || 0).getTime()
    m.isUnanswered = m.replyCount === 0 && _ageMs < 2 * 60 * 60 * 1000
  }

  // Priority sort — unanswered tier first, then intent, then source rank, then recency.
  function _unansweredTier(m) {
    const ds = m.demandScore || 0
    if (m.isUnanswered && ds >= 8) return 0
    if (m.isUnanswered && ds >= 5) return 1
    if (ds >= 8)                   return 2
    return 3
  }
  const INTENT_BOOST = {
    asking_for_tool: 0,
    buying:          1,
    researching:     2,
    complaining:     3,
    recommending:    4,
    venting:         5,
  }
  const SOURCE_RANK = { reddit: 0, hackernews: 1, quora: 2, medium: 3, substack: 4, upwork: 5, fiverr: 6, twitter: 7, jijing: 8, youtube: 9, amazon: 10 }
  allMatches.sort((a, b) => {
    const ua = _unansweredTier(a), ub = _unansweredTier(b)
    if (ua !== ub) return ua - ub
    const ia = INTENT_BOOST[a.intent] ?? 6
    const ib = INTENT_BOOST[b.intent] ?? 6
    if (ia !== ib) return ia - ib
    const ra = SOURCE_RANK[a.source] ?? 99
    const rb = SOURCE_RANK[b.source] ?? 99
    if (ra !== rb) return ra - rb
    return new Date(b.createdAt) - new Date(a.createdAt)
  })

  // Store in Redis + send alert
  try {
    const redis = getRedis()
    await storeMatches(redis, monitor, allMatches)

    // Update monitor's lastPollAt + totalMatchesFound
    const updatedMonitor = {
      ...monitor,
      lastPollAt: new Date().toISOString(),
      totalMatchesFound: (monitor.totalMatchesFound || 0) + allMatches.length,
    }
    await redis.set(`insights:monitor:${monitor.id}`, JSON.stringify(updatedMonitor))

    // Record author profiles (PR #24). Best-effort: each call swallows its
    // own errors. Skips placeholder authors (unknown / platform-name fallbacks).
    let authorsRecorded = 0, authorsNew = 0
    for (const m of allMatches) {
      const r = await recordAuthor({ redis, monitorId: monitor.id, match: m })
      if (r?.recorded) {
        authorsRecorded++
        if (r.isNew) authorsNew++
      }
    }
    if (authorsRecorded > 0) {
      console.log(`${label} Author profiles: ${authorsNew} new, ${authorsRecorded - authorsNew} returning`)
    }

    // PR #28: share-of-voice counters per ISO week. own = matches from
    // 'keyword' types, competitor = matches from 'competitor' types. Two
    // INCRBY calls per cycle, 90-day TTL on each. Reads happen via
    // /v1/matches/intent-summary which fetches the current + previous
    // week's keys to compute trend.
    let ownDelta = 0, compDelta = 0
    for (const m of allMatches) {
      if (m.keywordType === 'competitor') compDelta++
      else ownDelta++
    }
    if (ownDelta > 0 || compDelta > 0) {
      const week = isoWeekLabel(new Date())
      const SOV_TTL = 90 * 24 * 60 * 60   // 90 days
      try {
        if (ownDelta > 0) {
          await redis.incrby(`sov:${monitor.id}:${week}:own`, ownDelta)
          await redis.expire(`sov:${monitor.id}:${week}:own`, SOV_TTL)
        }
        if (compDelta > 0) {
          await redis.incrby(`sov:${monitor.id}:${week}:competitor`, compDelta)
          await redis.expire(`sov:${monitor.id}:${week}:competitor`, SOV_TTL)
        }
        console.log(`${label} SoV ${week}: own +${ownDelta}, competitor +${compDelta}`)
      } catch (err) {
        console.warn(`${label} SoV write failed: ${err.message}`)
      }
    }
  } catch (err) {
    console.error(`${label} Redis store error:`, err.message)
  }

  // PR #23: outbound webhook (fire-and-forget) for approved matches. We
  // intentionally do NOT await — failed deliveries log a warning and the
  // cycle proceeds. Only matches with approved===true are sent so monitor
  // owners don't get a Zapier ping for posts where Slack/Email already
  // told us "do not engage".
  if (monitor.webhookUrl) {
    let fired = 0
    for (const m of allMatches) {
      if (!m.approved) continue
      fireWebhook(
        monitor.webhookUrl,
        buildWebhookPayload({ event: 'new_match', monitorId: monitor.id, match: m }),
        monitor.id,
      )
      fired++
    }
    if (fired > 0) console.log(`${label} Webhook: dispatched ${fired} payloads to ${monitor.webhookUrl}`)
  }

  await sendMonitorAlert(monitor, allMatches)

  // Slack alert (uses per-monitor webhook if set, falls back to global env var)
  const slackUrl = monitor.slackWebhookUrl || process.env.SLACK_WEBHOOK_URL
  if (slackUrl && allMatches.length > 0) {
    await sendSlackAlert(slackUrl, allMatches)
    console.log(`${label} Slack alert sent — ${allMatches.length} matches`)
  }
}

// ── Main poll cycle ───────────────────────────────────────────────────────────
// Loads all active monitor IDs from Redis, fetches each monitor's config,
// then runs them with a concurrency limit so we don't hammer Reddit.
//
// F9: isPolling guard prevents cron from stacking cycles on top of each other.
// If a previous poll() is still running when the cron tick fires, skip — don't
// double Reddit's load and risk rate-bans.
let isPolling = false

async function poll() {
  if (isPolling) {
    console.log('[v2] previous cycle still running, skipping this tick')
    return
  }
  isPolling = true
  try {
    return await pollInner()
  } finally {
    isPolling = false
  }
}

async function pollInner() {
  const cycleStart = Date.now()
  console.log(`\n[v2] ===== POLL START: ${new Date().toISOString()} =====`)

  let redis
  try {
    redis = getRedis()
  } catch (err) {
    console.error('[v2] Redis unavailable — skipping cycle:', err.message)
    return
  }

  // Load all active monitor IDs
  let monitorIds = []
  try {
    monitorIds = await redis.smembers('insights:active_monitors') || []
  } catch (err) {
    console.error('[v2] Failed to load monitor IDs:', err.message)
    return
  }

  if (monitorIds.length === 0) {
    console.log('[v2] No active monitors found — nothing to do')
    return
  }

  console.log(`[v2] ${monitorIds.length} active monitor(s) to run`)

  // FIX 11 — collect any poll-now flags so flagged monitors run FIRST in
  // this cycle. The endpoint sets `poll-now:{id}` with a 5-min TTL; we
  // delete the flag after queueing so the next cycle doesn't replay it.
  const priorityIds = new Set()
  for (const id of monitorIds) {
    try {
      const flag = await redis.get(`poll-now:${id}`)
      if (flag) {
        priorityIds.add(id)
        await redis.del(`poll-now:${id}`)
      }
    } catch (_) { /* best-effort */ }
  }
  if (priorityIds.size > 0) {
    console.log(`[v2] Priority queue: ${priorityIds.size} monitor(s) flagged via poll-now`)
  }

  // Fetch all monitor configs
  const monitors = []
  for (const id of monitorIds) {
    try {
      const raw = await redis.get(`insights:monitor:${id}`)
      if (!raw) { console.warn(`[v2] Monitor ${id} not found in Redis — skipping`); continue }
      const m = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!m.active) { console.log(`[v2] Monitor ${id} is inactive — skipping`); continue }
      monitors.push(m)
    } catch (err) {
      console.error(`[v2] Failed to load monitor ${id}:`, err.message)
    }
  }

  // FIX 11 — sort priority-queue monitors first.
  monitors.sort((a, b) => Number(priorityIds.has(b.id)) - Number(priorityIds.has(a.id)))

  // Run monitors — max 2 concurrently (each does multiple searches internally)
  const MONITOR_CONCURRENCY = 2
  for (let i = 0; i < monitors.length; i += MONITOR_CONCURRENCY) {
    const batch = monitors.slice(i, i + MONITOR_CONCURRENCY)
    await Promise.all(batch.map(m => runMonitor(m)))
    // 5s gap between batches so Reddit doesn't rate-limit
    if (i + MONITOR_CONCURRENCY < monitors.length) await delay(5000)
  }

  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1)
  console.log(`[v2] ===== POLL END: ${elapsed}s — next in ${POLL_MINUTES} min =====\n`)
}

// ── Startup ───────────────────────────────────────────────────────────────────
console.log('━'.repeat(60))
console.log('  Ebenova Insights Worker v2 — Multi-tenant Reddit Monitor')
console.log(`  Poll interval: ${POLL_MINUTES} minutes`)
console.log(`  AI drafts:      ${GROQ_API_KEY ? 'ON (Groq / Llama 3.3 70b)' : 'OFF — set GROQ_API_KEY'}`)
console.log(`  Semantic V2:    ${OPENAI_API_KEY ? 'ON (OpenAI text-embedding-3-small)' : process.env.VOYAGE_API_KEY ? 'ON (Voyage AI)' : 'OFF — set OPENAI_API_KEY or VOYAGE_API_KEY to enable'}`)
console.log(`  Semantic threshold: ${process.env.SEMANTIC_THRESHOLD || '0.35'} (adjust with SEMANTIC_THRESHOLD)`)
console.log(`  Email alerts:   ${RESEND_API_KEY ? 'ON (Resend)' : 'OFF — set RESEND_API_KEY'}`)
console.log(`  Redis: ${process.env.UPSTASH_REDIS_REST_URL ? 'Upstash REST' : '⚠️  UPSTASH_REDIS_REST_URL not set'}`)
console.log('  Monitors loaded from: insights:active_monitors (Redis set)')
console.log('━'.repeat(60))

if (!redis) {
  console.warn('[v2] ⚠️  Running without Redis — multi-tenant features disabled. Set UPSTASH_REDIS_REST_URL to enable.')
  // Keep process alive but skip polling
  setInterval(() => {
    console.log('[v2] ⏳ Idle — waiting for Redis to be configured…')
  }, 300_000)
} else {
  // Memory usage logging every 5 minutes
  setInterval(() => {
    const m = process.memoryUsage()
    console.log(`[v2] 📊 Memory: Heap ${Math.round(m.heapUsed/1024/1024)}/${Math.round(m.heapTotal/1024/1024)}MB | RSS ${Math.round(m.rss/1024/1024)}MB | Seen entries: ${seenMap.size}`)
  }, 300_000)

  // Run once on startup, then on cron
  poll()
  // Per-monitor poll. With POLL_MINUTES=15 (default) this resolves to
  // '*/15 * * * *' (fires at :00, :15, :30, :45 each hour).
  const POLL_EXPR = `*/${POLL_MINUTES} * * * *`
  if (!cron.validate(POLL_EXPR)) {
    throw new Error(`[v2] invalid POLL_MINUTES=${POLL_MINUTES} produced bad cron: ${POLL_EXPR}`)
  }
  cron.schedule(POLL_EXPR, poll)
  console.log(`[v2] Cron scheduled: ${POLL_EXPR}`)

  // PR #26: weekly digest cron — Mondays at 08:00 UTC. Best-effort: per-
  // monitor errors are isolated inside runAllDigests, so one bad record
  // never kills the cron. Toggleable via WEEKLY_DIGEST_ENABLED env (default on).
  const WEEKLY_DIGEST_EXPR = '0 8 * * 1'
  const weeklyEnabled = (process.env.WEEKLY_DIGEST_ENABLED || 'true').toLowerCase() !== 'false'
  if (weeklyEnabled) {
    if (!cron.validate(WEEKLY_DIGEST_EXPR)) {
      throw new Error(`[v2] invalid weekly digest cron: ${WEEKLY_DIGEST_EXPR}`)
    }
    cron.schedule(WEEKLY_DIGEST_EXPR, async () => {
      try {
        const r = await runAllDigests({ redis, resend, fromEmail: FROM_EMAIL })
        console.log(`[v2][digest] ran=${r.ran} sent=${r.sent} skipped=${r.skipped}`)
      } catch (err) {
        console.error(`[v2][digest] cron failed: ${err.message}`)
      }
      // PR #34 — AI visibility sweep. Runs alongside the weekly digest so
      // founders get the LLM-mention picture in the same weekly heartbeat.
      // Best-effort: a sweep crash never blocks future runs and never crashes
      // the worker. Toggleable via AI_VISIBILITY_ENABLED (default on).
      const visibilityEnabled = (process.env.AI_VISIBILITY_ENABLED || 'true').toLowerCase() !== 'false'
      if (visibilityEnabled) {
        try {
          const v = await runVisibilitySweep({ redis })
          console.log(`[v2][ai-visibility] eligible=${v.eligible} ran=${v.ran} stored=${v.stored} skipped=${v.skipped} failed=${v.failed}`)
        } catch (err) {
          console.error(`[v2][ai-visibility] sweep failed: ${err.message}`)
        }
      }
    }, { timezone: 'UTC' })
    console.log(`[v2] Weekly digest cron scheduled: Monday 08:00 UTC (${WEEKLY_DIGEST_EXPR})`)
  } else {
    console.log('[v2] Weekly digest disabled (WEEKLY_DIGEST_ENABLED=false)')
  }

  // PR #29: reply outcome tracking sweep — hourly at :07 past the hour.
  //
  // Why :07 and not :15? With POLL_MINUTES=15 (default) the per-monitor poll
  // also fires at :15 every hour, so the previous '15 * * * *' schedule was
  // racing the poll for Reddit / HN bandwidth. :07 is safely off any of
  // node-cron's `*/N` boundaries for N in {1, 5, 10, 15, 20, 30, 60}.
  // Toggleable via REPLY_TRACKING_ENABLED env (default on).
  const REPLY_TRACKING_EXPR = '7 * * * *'
  const trackingEnabled = (process.env.REPLY_TRACKING_ENABLED || 'true').toLowerCase() !== 'false'
  if (trackingEnabled) {
    if (!cron.validate(REPLY_TRACKING_EXPR)) {
      throw new Error(`[v2] invalid reply-tracking cron: ${REPLY_TRACKING_EXPR}`)
    }
    cron.schedule(REPLY_TRACKING_EXPR, async () => {
      try {
        const r = await runEngagementSweep({ redis })
        if (r.scanned > 0) {
          console.log(`[v2][reply-tracker] scanned=${r.scanned} eligible=${r.eligible} ok=${r.ok} error=${r.error}`)
        }
      } catch (err) {
        console.error(`[v2][reply-tracker] cron failed: ${err.message}`)
      }
    }, { timezone: 'UTC' })
    console.log(`[v2] Reply outcome tracking cron scheduled: hourly at :07 UTC (${REPLY_TRACKING_EXPR})`)
  } else {
    console.log('[v2] Reply outcome tracking disabled (REPLY_TRACKING_ENABLED=false)')
  }
}
