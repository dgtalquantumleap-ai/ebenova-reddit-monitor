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

import { Resend }  from 'resend'
import { Redis }   from '@upstash/redis'
import cron        from 'node-cron'
import { sendSlackAlert }  from './lib/slack.js'
import searchMedium        from './lib/scrapers/medium.js'
import searchSubstack      from './lib/scrapers/substack.js'
import searchQuora         from './lib/scrapers/quora.js'
import searchUpwork        from './lib/scrapers/upwork.js'
import searchFiverr        from './lib/scrapers/fiverr.js'
import { escapeHtml }      from './lib/html-escape.js'
import { sanitizeForPrompt } from './lib/llm-safe-prompt.js'
import { embeddingCacheKey } from './lib/embedding-cache.js'
import { makeCostCap } from './lib/cost-cap.js'
import { draftCall }   from './lib/draft-call.js'
import {
  isRedditAuthConfigured,
  redditAuthHeaders,
  redditOAuthHost,
  redditPublicHost,
  redditUserAgent,
  invalidateRedditToken,
} from './lib/reddit-auth.js'
import { generateUnsubscribeToken, buildEmailFooter } from './lib/account-deletion.js'

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
const FROM_EMAIL       = process.env.FROM_EMAIL || 'insights@ebenova.dev'
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
// Auth strategy: prefers OAuth client-credentials (oauth.reddit.com, ~600
// req/10min headroom) when REDDIT_CLIENT_ID + SECRET are set. Falls back to
// anonymous www.reddit.com endpoints when not configured (~60 req/min,
// rate-limited). On 401 we invalidate the token and retry once with a
// fresh one — covers the rare case Reddit rotates / revokes mid-cycle.
//
// Failure-mode logging: every non-2xx response is logged with status + URL
// so cycle logs make rate-limit problems visible (vs. silent in v1).
async function searchReddit(monitorId, keywordEntry) {
  const { keyword, subreddits = [] } = keywordEntry
  const results = []
  const encoded = encodeURIComponent(keyword)
  const useOAuth = isRedditAuthConfigured()
  const HOST = useOAuth ? redditOAuthHost() : redditPublicHost()

  // Path is the same for both hosts; OAuth uses the same /r/{sub}/search.json
  // shape with a Bearer token. Only the hostname differs.
  const paths = subreddits.length > 0
    ? subreddits.map(sr =>
        `/r/${sr}/search.json?q=${encoded}&sort=new&limit=10&t=day&restrict_sr=1`
      )
    : [`/search.json?q=${encoded}&sort=new&limit=10&t=day`]

  // Build headers. Anonymous: just User-Agent. OAuth: add Bearer token.
  async function buildHeaders() {
    if (useOAuth) {
      try {
        return await redditAuthHeaders()
      } catch (err) {
        console.warn(`[v2][reddit] OAuth token fetch failed (${err.message}) — falling back to anonymous for this cycle`)
        return { 'User-Agent': redditUserAgent() }
      }
    }
    return { 'User-Agent': redditUserAgent() }
  }

  let headers = await buildHeaders()

  for (const path of paths) {
    const url = HOST + path
    try {
      let res = await fetch(url, { headers })

      // Token might have rotated mid-cycle. One retry with fresh token covers
      // the common case before falling through to the error path.
      if (res.status === 401 && useOAuth) {
        console.warn(`[v2][reddit] 401 on "${keyword}" — refreshing token and retrying once`)
        invalidateRedditToken()
        try {
          headers = await buildHeaders()
          res = await fetch(url, { headers })
        } catch (err) {
          console.warn(`[v2][reddit] retry failed: ${err.message}`)
        }
      }

      if (!res.ok) {
        console.warn(`[v2][reddit] ${res.status} for "${keyword}" → ${url.slice(0, 100)}…`)
        await delay(3000)
        continue
      }
      const data = await res.json()
      const posts = data?.data?.children || []
      let newCount = 0
      let agedOut = 0

      for (const post of posts) {
        const p = post.data
        if (await hasSeenWithRedis(monitorId, p.id)) continue
        if (Date.now() - p.created_utc * 1000 > POST_MAX_AGE_MS) { agedOut++; continue }
        markSeen(monitorId, p.id)
        newCount++
        results.push({
          id:        p.id,
          title:     p.title || '(no title)',
          url:       `https://reddit.com${p.permalink}`,
          subreddit: p.subreddit,
          author:    p.author,
          score:     p.score,
          comments:  p.num_comments,
          body:      (p.selftext || '').slice(0, 600),
          createdAt: new Date(p.created_utc * 1000).toISOString(),
          keyword,
          source:    'reddit',
          approved:  APPROVED_SUBREDDITS.has(p.subreddit),
        })
      }
      // Always log per-URL so we can see whether Reddit is returning data.
      // Tag the auth mode so cycle logs make it obvious whether OAuth is
      // active when diagnosing "only Medium" complaints.
      const authTag = useOAuth ? 'oauth' : 'anon'
      console.log(`[v2][reddit:${authTag}] "${keyword}" → ${posts.length} fetched, ${newCount} new, ${agedOut} stale${posts.length === 0 ? ' (empty response — likely rate-limited)' : ''}`)
    } catch (err) {
      console.error(`[v2][reddit] fetch error "${keyword}":`, err.message)
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
async function generateReplyDraft(post, productContext, tone) {
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
  })
}

// ── Email builder — per-monitor, minimal ─────────────────────────────────────
function buildAlertEmail(monitor, matches) {
  const byKeyword = {}
  for (const m of matches) {
    if (!byKeyword[m.keyword]) byKeyword[m.keyword] = []
    byKeyword[m.keyword].push(m)
  }

  const keywordSections = Object.entries(byKeyword).map(([kw, posts]) => {
    const items = posts.map(p => `
      <div style="margin-bottom:18px;padding:14px;background:#f9f9f9;border-left:4px solid #FF6B35;border-radius:4px;">
        <div style="font-size:12px;color:#888;margin-bottom:5px;">
          ${p.source === 'hackernews' ? 'HN' : p.source === 'medium' ? '📰 Medium' : p.source === 'substack' ? '📧 Substack' : p.source === 'quora' ? '💬 Quora' : p.source === 'upwork' ? '💼 Upwork' : p.source === 'fiverr' ? '🟢 Fiverr' : `r/${escapeHtml(p.subreddit)}`} · u/${escapeHtml(p.author)} · ${escapeHtml(p.score)} upvotes
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
      </div>`).join('')
    return `
      <div style="margin-bottom:28px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#aaa;margin-bottom:10px;">"${escapeHtml(kw)}" (${posts.length})</div>
        ${items}
      </div>`
  }).join('')

  // Platform badges — surfaces which platforms are scanning so testers don't
  // wonder why they only see one source. Reads the monitor's include* flags.
  const platforms = [
    { on: true,                            label: 'Reddit',   emoji: '👽' },
    { on: monitor.includeMedium      !== false, label: 'Medium',   emoji: '📰' },
    { on: monitor.includeSubstack    !== false, label: 'Substack', emoji: '📧' },
    { on: monitor.includeQuora       !== false, label: 'Quora',    emoji: '💬' },
    { on: monitor.includeUpworkForum !== false, label: 'Upwork',   emoji: '💼' },
    { on: monitor.includeFiverrForum !== false, label: 'Fiverr',   emoji: '🟢' },
  ]
  const platformBadges = platforms
    .map(p => `<span style="display:inline-block;padding:3px 9px;margin:2px 3px 2px 0;background:${p.on ? 'rgba(255,107,53,.10)' : '#1f1f1f'};color:${p.on ? '#FF6B35' : '#666'};border:1px solid ${p.on ? 'rgba(255,107,53,.30)' : '#2a2a2a'};border-radius:11px;font-size:11px;font-weight:600;">${p.emoji} ${p.label}</span>`)
    .join('')

  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:32px 24px;background:#f5f5f5;color:#1a1a1a;">
    <div style="margin-bottom:24px;padding:20px;background:#0e0e0e;border-radius:8px;">
      <div style="font-size:18px;font-weight:700;color:#FF6B35;">📡 Ebenova Insights — ${escapeHtml(monitor.name)}</div>
      <div style="font-size:13px;color:#9a9690;margin-top:6px;">${matches.length} new mention${matches.length !== 1 ? 's' : ''} · ${new Date().toUTCString()}</div>
      <div style="margin-top:10px;">${platformBadges}</div>
    </div>
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
  const subject  = `Insights: ${matches.length} new mention${matches.length !== 1 ? 's' : ''} — ${keywords.slice(0, 3).join(', ')}${keywords.length > 3 ? '…' : ''}`

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

  try {
    await resend.emails.send({
      from:    `Ebenova Insights <${FROM_EMAIL}>`,
      to:      monitor.alertEmail,
      subject,
      html:    buildAlertEmail(monitor, matches),
    })
    console.log(`[v2][${monitor.id}] Alert sent to ${monitor.alertEmail} — ${matches.length} matches`)
  } catch (err) {
    console.error(`[v2][${monitor.id}] Failed to send alert:`, err.message)
  }
}

// ── Run a single monitor ──────────────────────────────────────────────────────
// Fetches all keywords for a monitor, searches Reddit + Nairaland,
// generates drafts, stores matches, sends alert if any found.
async function runMonitor(monitor) {
  const label = `[v2][${monitor.id}][${monitor.name}]`
  console.log(`${label} Starting — ${monitor.keywords.length} keywords`)
  const allMatches = []

  for (const kw of monitor.keywords) {
    // Merge per-keyword productContext with monitor-level context
    const ctx = kw.productContext || monitor.productContext || ''

    // Reddit — keyword search (always runs)
    const redditMatches = await searchReddit(monitor.id, kw)
    for (const m of redditMatches) {
      m.productContext = ctx
      allMatches.push(m)
    }
    if (redditMatches.length > 0) {
      console.log(`${label} Reddit "${kw.keyword}": ${redditMatches.length} new`)
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

  // ── Extended platform scrapers (per-monitor, respects plan) ──────────────
  const seenIds = { has: (id) => hasSeen(monitor.id, id), add: (id) => markSeen(monitor.id, id) }
  const maxAgeMs = 24 * 60 * 60 * 1000 // 24h for v2 monitors

  if (monitor.includeMedium !== false) {
    for (const kw of monitor.keywords) {
      const ctx = kw.productContext || monitor.productContext || ''
      const matches = await searchMedium(kw, { seenIds, delay, MAX_AGE_MS: maxAgeMs })
      matches.forEach(m => { m.productContext = ctx; allMatches.push(m) })
      if (matches.length) console.log(`${label} Medium "${kw.keyword}": ${matches.length} new`)
      await delay(1500)
    }
  }

  if (monitor.includeSubstack !== false) {
    for (const kw of monitor.keywords) {
      const ctx = kw.productContext || monitor.productContext || ''
      const matches = await searchSubstack(kw, { seenIds, delay, MAX_AGE_MS: maxAgeMs })
      matches.forEach(m => { m.productContext = ctx; allMatches.push(m) })
      if (matches.length) console.log(`${label} Substack "${kw.keyword}": ${matches.length} new`)
      await delay(1500)
    }
  }

  if (monitor.includeQuora !== false) {
    for (const kw of monitor.keywords) {
      const ctx = kw.productContext || monitor.productContext || ''
      const matches = await searchQuora(kw, { seenIds, delay, MAX_AGE_MS: maxAgeMs })
      matches.forEach(m => { m.productContext = ctx; allMatches.push(m) })
      if (matches.length) console.log(`${label} Quora "${kw.keyword}": ${matches.length} new`)
      await delay(2000)
    }
  }

  if (monitor.includeUpworkForum !== false) {
    for (const kw of monitor.keywords) {
      const ctx = kw.productContext || monitor.productContext || ''
      const matches = await searchUpwork(kw, { seenIds, delay, MAX_AGE_MS: maxAgeMs })
      matches.forEach(m => { m.productContext = ctx; allMatches.push(m) })
      if (matches.length) console.log(`${label} Upwork "${kw.keyword}": ${matches.length} new`)
      await delay(3000)
    }
  }

  if (monitor.includeFiverrForum !== false) {
    for (const kw of monitor.keywords) {
      const ctx = kw.productContext || monitor.productContext || ''
      const matches = await searchFiverr(kw, { seenIds, delay, MAX_AGE_MS: maxAgeMs })
      matches.forEach(m => { m.productContext = ctx; allMatches.push(m) })
      if (matches.length) console.log(`${label} Fiverr "${kw.keyword}": ${matches.length} new`)
      await delay(3000)
    }
  }

  if (allMatches.length === 0) {
    console.log(`${label} No new matches`)
    return
  }

  console.log(`${label} ${allMatches.length} total matches — generating drafts…`)

  // Generate drafts (max 3 concurrent to avoid rate limits)
  const CONCURRENCY = 3
  for (let i = 0; i < allMatches.length; i += CONCURRENCY) {
    const batch = allMatches.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async m => {
      const r = await generateReplyDraft(m, m.productContext, monitor.replyTone)
      m.draft = r.draft
      m.draftedBy = r.model
      if (m.draft) console.log(`${label} Draft by ${r.model}: "${m.title.slice(0, 50)}…"`)
    }))
    if (i + CONCURRENCY < allMatches.length) await delay(1000)
  }

  // Source priority — Reddit ranks first because it's the highest-traffic
  // platform with the strongest buying-intent signal. Lower = higher priority.
  const SOURCE_RANK = { reddit: 0, hackernews: 1, quora: 2, medium: 3, substack: 4, upwork: 5, fiverr: 6 }
  allMatches.sort((a, b) => {
    const ra = SOURCE_RANK[a.source] ?? 99
    const rb = SOURCE_RANK[b.source] ?? 99
    if (ra !== rb) return ra - rb
    // Within the same source, newer first
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
  } catch (err) {
    console.error(`${label} Redis store error:`, err.message)
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
  const cron_expr = `*/${POLL_MINUTES} * * * *`
  cron.schedule(cron_expr, poll)
  console.log(`[v2] Cron scheduled: ${cron_expr}`)
}
