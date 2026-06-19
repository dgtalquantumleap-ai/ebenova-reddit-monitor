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
import searchStackOverflow from './lib/scrapers/stackoverflow.js'
import searchIndieHackers  from './lib/scrapers/indiehackers.js'
import searchG2             from './lib/scrapers/g2.js'
import searchGitHub        from './lib/scrapers/github.js'
import searchProductHunt   from './lib/scrapers/producthunt.js'
import searchTwitter       from './lib/scrapers/twitter.js'
import searchJijiNg        from './lib/scrapers/jijing.js'
import searchYouTube       from './lib/scrapers/youtube.js'
import searchAmazonReviews from './lib/scrapers/amazon.js'
import searchRSS      from './lib/scrapers/rss.js'
import searchTelegram from './lib/scrapers/telegram.js'
// LinkedIn scraper exists at lib/scrapers/linkedin.js but is parked: no
// reliable open search backend indexes linkedin.com/posts/ from a server.
// Re-import + re-add to platformRunners and SOURCE_RANK once we wire up
// a real source.
import { migrateLegacyPlatforms, PLATFORM_LABELS, PLATFORM_EMOJIS, PLATFORM_DISABLED, isPlatformDisabled } from './lib/platforms.js'
import { escapeHtml }      from './lib/html-escape.js'
import { sanitizeForPrompt } from './lib/llm-safe-prompt.js'
import { embeddingCacheKey } from './lib/embedding-cache.js'
import { makeCostCap } from './lib/cost-cap.js'
import { draftCall, extractInjectedUtmUrl } from './lib/draft-call.js'
import { parseRedditRSS, buildRedditSearchUrl, parseRetryAfter, resolveKeyword } from './lib/reddit-rss.js'
import { paceRedditRequest, pushCooldown, cooldownRemainingMs, recordReddit429, recordRedditSuccess, isRedditBreakerOpen, breakerRemainingMs } from './lib/reddit-pacer.js'
import { makeRedditCache } from './lib/reddit-cache.js'
import { generateUnsubscribeToken, buildEmailFooter } from './lib/account-deletion.js'
import { classifyMatch, intentPriority, isHighPriority } from './lib/classify.js'
import { recordAuthor } from './lib/author-profiles.js'
import { fireWebhook, buildPayload as buildWebhookPayload } from './lib/outbound-webhook.js'
import { runAllDigests } from './lib/weekly-digest.js'
import { runVisibilitySweep } from './lib/ai-visibility.js'
import { normalizeKeywordList, isoWeekLabel } from './lib/keyword-types.js'
import { runEngagementSweep, processPendingChecks } from './lib/reply-tracker.js'
import { isBuilderPost, extractTopics, recordBuilderProfile, getBuilderProfiles, sendBuilderDigest, PLATFORMS_WITH_REAL_USERNAMES } from './lib/builder-tracker.js'
import { passesRelevanceCheck } from './lib/relevance.js'
import { groundingContext, groundIntent } from './lib/intent-grounding.js'
import { updateKeywordHealth } from './lib/keyword-health.js'
import { buildCompetitorKeywords } from './lib/competitor-tracker.js'
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
const SEMANTIC_ENABLED = !!(OPENAI_API_KEY || VOYAGE_API_KEY)
if (SEMANTIC_ENABLED) console.log(`[v2] Semantic V2: ON (${VOYAGE_API_KEY ? 'Voyage AI' : 'OpenAI'})`)

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

// ── Seen IDs (cycle-scoped, reset at the start of every poll) ────────────────
// Module-level so hasSeen/markSeen helpers can reference it without threading
// a parameter through every scraper call. Replaced with a fresh Set at the top
// of pollInner() each cycle so it never accumulates across cycles.
// Cross-cycle dedup is handled by Redis seen:v2:{monitorId}:{postId} (3-day TTL).
let _cycleSeenIds = new Set() // key: `${monitorId}:${postId}`

function hasSeen(monitorId, postId) {
  return _cycleSeenIds.has(`${monitorId}:${postId}`)
}

// Redis-backed seen check — cross-cycle dedup via 3-day TTL keys.
// The cycle-scoped Set is checked first (fast path, no network).
async function hasSeenWithRedis(monitorId, postId) {
  if (hasSeen(monitorId, postId)) return true
  if (!redis) return false
  try {
    const r = await redis.get(`seen:v2:${monitorId}:${postId}`)
    if (r) { _cycleSeenIds.add(`${monitorId}:${postId}`); return true }
  } catch (_) {}
  return false
}

function markSeen(monitorId, postId) {
  _cycleSeenIds.add(`${monitorId}:${postId}`)
  if (redis) redis.setex(`seen:v2:${monitorId}:${postId}`, 60 * 60 * 24 * 3, '1').catch(() => {})
}

// ── Utility ───────────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms))

// ── Approved subreddits — never draft a reply if not on this list ─────────────
// Global whitelist. Organised by vertical so additions are easy to find.
// Rule: if a monitor keyword could plausibly surface a post in a subreddit
// where a founder reply would be welcome, it belongs here.
const APPROVED_SUBREDDITS = new Set([

  // ── SaaS / Startups / Entrepreneurship ────────────────────────────────────
  'SaaS','startups','Entrepreneur','EntrepreneurRideAlong','SoloDevelopment',
  'IndieHackers','buildinpublic','indiebiz','microsaas','SideProject',
  'entj','smallbusiness','agency','agencynewbies','consulting',
  'growthHacking','GrowthHacking','ProductLed','ProductLedGrowth',
  'YCombinator','venturecapital','angels','FounderHub',

  // ── Product / No-code / Tools ──────────────────────────────────────────────
  'product_management','ProductManagement','ProductDesign','UXDesign',
  'nocode','lowcode','webflow','bubble','zapier','n8n','makeautomation',
  'automation','ArtificialIntelligence','artificial','ChatGPT','ClaudeAI',
  'LocalLLaMA','LangChain','CursorIDE','OpenAI','MachineLearning',
  'learnmachinelearning','datascience','MLjobs','deeplearning',

  // ── Software Development ───────────────────────────────────────────────────
  'webdev','web_design','Frontend','reactjs','vuejs','nextjs','node',
  'javascript','typescript','Python','golang','rust','programming',
  'softwaredevelopment','gamedev','androiddev','iOSProgramming',
  'devops','docker','kubernetes','aws','googlecloud','azure',
  'github','opensource','learnprogramming','cscareerquestions',
  'cscareeradvice','ExperiencedDevs','coding','API','Backend',

  // ── Freelance / Remote Work / Jobs ────────────────────────────────────────
  'freelance','freelancers','Upwork','Fiverr','forhire',
  'remotework','digitalnomad','workingdigitalnomad','techsupport',
  'recruiting','HR','recruitinghell','jobsearchhacks','jobs','techjobs',
  'graphic_design','writing','copywriting','videography',
  'socialmediamanagement','marketing','SEO','content_marketing',

  // ── Legal / Finance / Compliance ──────────────────────────────────────────
  'legaltech','legaladvice','law','LawSchool','contracts',
  'fintech','personalfinance','investing','CryptoCurrency','tax',
  'accounting','smallbusinessfinance','LandlordLady','realestate',

  // ── Sales / Marketing / CRM ───────────────────────────────────────────────
  'sales','salestechniques','b2bmarketing','emailmarketing','cold_outreach',
  'CustomerSuccess','CRM','hubspot','salesforce','outreach',
  'digital_marketing','PPC','SEO','analytics','growthhacking',

  // ── Education / EdTech ────────────────────────────────────────────────────
  'Teachers','education','Professors','OnlineLearning','edtech',
  'SubstituteTeachers','elearning','udemy','coursera','LMS',

  // ── Design / Creative ─────────────────────────────────────────────────────
  'Design','graphic_design','UI_Design','UXDesign','logodesign',
  'photography','weddingphotography','videography','Filmmakers',
  'AV','hometheater','podcasting','streaming',

  // ── Events / Services / Home ──────────────────────────────────────────────
  'eventplanning','Weddings','weddingplanning','wedding','DIY',
  'cleaning','CleaningBusiness','housekeeping','HVAC','HomeImprovement',
  'handyman','landscaping','petbusiness',

  // ── Health / Fitness / Wellness ───────────────────────────────────────────
  'fitness','personaltraining','nutrition','mentalhealth','therapy',
  'coaching','LifeCoach','wellness','yoga','meditation',

  // ── Creator Economy / Communities ─────────────────────────────────────────
  'NewTubers','youtubers','Twitch','TwitchStreaming','podcast',
  'blogging','newsletter','substack','ContentCreators','OnlineBusiness',
  'PassiveIncome','affiliatemarketing','dropship','ecommerce','Shopify',
  'AmazonFBA','etsy','printOnDemand',

  // ── Communities by geography (global) ─────────────────────────────────────
  // Kept where the subreddit has active business/tech discussion.
  'Nigeria','lagos','naija','nairaland','Africa','Kenya','Ghana',
  'india','indianstartups','AusFinance','ukbusiness','CanadaSmallBusiness',
  'brasil','LATAM','singapore','SEABusinesses','dubai','southafrica',

  // ── Faith / Niche verticals ───────────────────────────────────────────────
  'Christianity','church','Reformed','churchtech',
  'PublicSpeaking','malelivingspace',
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

  // Redis embedding cache — 24h TTL, cross-restart persistence
  if (redis) {
    try {
      const redisKey = `embed:${key}`
      const cached = await redis.get(redisKey)
      if (cached) {
        const vec = typeof cached === 'string' ? JSON.parse(cached) : cached
        if (Array.isArray(vec)) {
          setCacheWithSoftCap(key, vec)
          return vec
        }
      }
    } catch (_) {}
  }

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
      if (vec) {
        setCacheWithSoftCap(key, vec)
        if (redis) redis.setex(`embed:${key}`, 86400, JSON.stringify(vec)).catch(() => {})
      }
      return vec
    }

    if (process.env.VOYAGE_API_KEY) {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}` },
        body: JSON.stringify({ model: 'voyage-3-lite', input: [text.slice(0, 2000)] }),
      })
      if (!res.ok) return null
      const data = await res.json()
      const vec = data?.data?.[0]?.embedding || null
      if (vec) {
        setCacheWithSoftCap(key, vec)
        if (redis) redis.setex(`embed:${key}`, 86400, JSON.stringify(vec)).catch(() => {})
      }
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
    // Global Reddit IP-pacer — see lib/reddit-pacer.js. Prevents two
    // monitors-in-parallel from cumulatively bursting past the anonymous
    // ceiling.
    await paceRedditRequest()
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
//
// Per-monitor request budget: to prevent one heavy monitor (27 keywords ×
// 5 subreddits = 135 URLs) from monopolizing the global pacer queue and
// starving other monitors for minutes, each monitor gets a cap of
// MONITOR_REDDIT_URL_CAP (default 40) URLs per cycle. Excess URLs are
// skipped with a warning. This is per-searchReddit-invocation total, shared
// via the requestsUsed counter passed in opts.
// Dynamic subreddit-intel fan-out per keyword. Reddit rate-limits aggressive
// RSS fan-out, so cap the suggested-subreddit list; combined with the circuit
// breaker this keeps request volume under the anonymous ceiling. Env-tunable.
const REDDIT_INTEL_FANOUT = parseInt(process.env.REDDIT_INTEL_FANOUT || '3')

async function searchReddit(monitorId, keywordEntry, opts = {}) {
  const keyword = resolveKeyword(keywordEntry)
  const { subreddits = [] } = keywordEntry
  const _isDynamic = !!keywordEntry._dynamicSubreddits
  const results = []

  // Per-monitor request budget — shared counter across all searchReddit calls
  // for one monitor cycle. Passed in via opts.requestBudget = { used, max }.
  // When the budget is exhausted, remaining URLs are skipped so this monitor
  // doesn't monopolize the global pacer queue.
  const budget = opts.requestBudget || null

  // One URL per named subreddit, or a single global search if none are set.
  // Pass keyword type so phrase keywords get force-quoted in the Reddit query.
  // Pair each URL with its subreddit so 404 handling can blacklist the bad name.
  const kwType = keywordEntry.type || 'keyword'
  const urlPairs = subreddits.length > 0
    ? subreddits.map(sr => [sr, buildRedditSearchUrl(keyword, sr, { type: kwType })])
    : [[null, buildRedditSearchUrl(keyword, null, { type: kwType })]]
  // Monitors with many subreddits hit 429s more frequently.
  // Wider base gap keeps us inside Reddit's anonymous rate limit.
  // Dynamically suggested (subreddit-intel) calls get a floor of 3000ms because
  // those URLs hit a fresh, unwarmed CDN edge and 429 sooner than approved subs.
  const _baseDelay = subreddits.length > 5 ? 4000 : 2500
  const interDelay = _isDynamic ? Math.max(_baseDelay, 3000) : _baseDelay

  // Plain headers — no Bearer, no client_id. UA is still polite to send;
  // Reddit's RSS endpoints don't gate on it the way the JSON API does.
  const headers = {
    'User-Agent': process.env.REDDIT_USER_AGENT || 'Mozilla/5.0 (compatible; EbenovaBot/2.0)',
    'Accept': 'application/atom+xml,application/rss+xml,application/xml;q=0.9,text/xml;q=0.8',
  }

  // Short-TTL result cache (lib/reddit-cache.js): a cache hit skips the fetch,
  // the pacer, AND the per-monitor budget — proactively cutting the request
  // volume that triggers Reddit's anonymous-IP 429s. Misses fall through to a
  // live fetch which then populates the cache.
  const cache = makeRedditCache(redis)
  let _breakerSkipLogged = false

  // Shared consumer for parsed RSS entries — used by BOTH the live-fetch and
  // cache-hit paths so seen/age dedup behaves identically. Pushes new matches
  // onto `results` (closed over above).
  const processEntries = async (entries, { cached } = {}) => {
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
    console.log(`[v2][reddit:rss] "${keyword}" → ${entries.length} fetched, ${newCount} new, ${agedOut} stale${entries.length === 0 ? ' (empty feed)' : ''}${cached ? ' (cached)' : ''}`)
  }

  for (const [sr, url] of urlPairs) {
    const cacheParams = { keyword, subreddit: sr, type: kwType }

    // 1) Serve from cache when fresh — no fetch, no pacer, no budget spend.
    //    The seen/age filter in processEntries still runs, so a cache hit never
    //    re-emits a match that was already surfaced.
    const cachedEntries = await cache.get(cacheParams)
    if (cachedEntries) {
      await processEntries(cachedEntries, { cached: true })
      continue
    }

    // 2) Circuit breaker — once repeated 429s trip it, skip ALL Reddit fetching
    //    until it closes (~25 min, cross-cycle). This is what stops a hot IP
    //    from stretching a poll cycle to hours; other platforms are unaffected.
    //    Logged once per searchReddit call to avoid spam.
    if (isRedditBreakerOpen()) {
      if (!_breakerSkipLogged) {
        console.warn(`[v2][reddit:rss] circuit-breaker open (~${Math.ceil(breakerRemainingMs() / 60000)}m left) — skipping Reddit, other platforms continue`)
        _breakerSkipLogged = true
      }
      continue
    }

    // 3) Per-monitor budget — only real fetches (not cache hits / breaker
    //    skips) count against it.
    if (budget) {
      if (budget.used >= budget.max) {
        console.warn(`[v2][reddit:rss] "${keyword}" — per-monitor request budget exhausted (${budget.used}/${budget.max}), skipping remaining subreddits`)
        break
      }
      budget.used++
    }
    try {
      // Global Reddit IP-pacer — see lib/reddit-pacer.js. The per-monitor
      // interDelay above prevents one monitor from bursting; this prevents
      // multiple monitors-in-parallel from cumulatively bursting against
      // the same outbound IP. Dynamically-suggested subreddits hit fresh,
      // unwarmed CDN edges and 429 sooner than approved subs, so they ask the
      // global pacer for a wider gap (3000ms) than the default (1500ms).
      await paceRedditRequest(_isDynamic ? 3000 : undefined)
      const res = await fetch(url, { headers })
      if (!res.ok) {
        const retryAfter = parseRetryAfter(res.headers)
        const is429 = res.status === 429
        // Suppress per-URL logs for 429s that arrive while a cooldown is
        // already active. During a rate-limit burst every request 429s, and
        // logging each one floods the cycle log with hundreds of identical
        // lines (the original cause of the unreadable production logs). Real
        // failures (404/403/5xx) and the FIRST 429 that opens a cooldown
        // window are still logged in full.
        const alreadyCoolingDown = is429 && cooldownRemainingMs() > 0
        if (!alreadyCoolingDown) {
          console.warn(`[v2][reddit:rss] ${res.status} for "${keyword}" → ${url.slice(0, 100)}…${retryAfter ? ` (Retry-After: ${retryAfter}s)` : ''}`)
        }
        // 404 OR 403 → permanently bad subreddit; blacklist for 30d.
        // Applies to BOTH dynamic AND explicit subreddit lists — Reddit
        // saying "this sub doesn't exist / is private" is ground truth
        // regardless of how the sub ended up on the keyword's list.
        // Operator can remove from explicit lists via the dashboard.
        // 403 typically means private/quarantined and won't recover;
        // 404 means it doesn't exist. 30d TTL retries after a month.
        if ((res.status === 404 || res.status === 403) && sr && redis) {
          const _badSubKey = `subreddit:404:${String(sr).toLowerCase().replace(/^r\//, '')}`
          await redis.set(_badSubKey, '1', { ex: 2592000 }).catch(() => {})
        }
        // 429 → tell the global pacer that the IP is hot; ALL Reddit fetches
        // across all monitors will pause for the Retry-After (or default 30s).
        // Without this, the next keyword's first request fires after only the
        // baseline 1500ms gap and we hammer the still-hot IP.
        if (is429) {
          const cooldownMs = Math.max((retryAfter || 30) * 1000, 30000)
          // Log only the 429 that OPENS a cooldown window; subsequent 429s in
          // the same burst extend it silently (see alreadyCoolingDown above).
          if (!alreadyCoolingDown) {
            console.warn(`[v2][reddit:rss] 429 → global pacer cooldown ~${Math.ceil(cooldownMs / 1000)}s (further 429s suppressed until it clears)`)
          }
          pushCooldown(cooldownMs)
          // Feed the circuit breaker. After REDDIT_BREAKER_THRESHOLD consecutive
          // 429s it opens and the checks above skip Reddit for the cooldown.
          if (recordReddit429()) {
            console.warn(`[v2][reddit:rss] ⛔ circuit-breaker OPEN ~${Math.ceil(breakerRemainingMs() / 60000)}m after repeated 429s — pausing Reddit (other platforms unaffected)`)
          }
        }
        // Always wait at least interDelay after a non-2xx so the next URL in the
        // loop doesn't fire immediately. The continue below skips the interDelay
        // at the bottom, so we must apply it here.
        await delay(Math.max((retryAfter || 5) * 1000, interDelay))
        continue
      }
      const xml = await res.text()
      const entries = parseRedditRSS(xml)
      recordRedditSuccess()                  // IP responded — reset the 429 streak
      await cache.set(cacheParams, entries)  // populate the short-TTL result cache
      await processEntries(entries, { cached: false })
    } catch (err) {
      console.error(`[v2][reddit:rss] fetch error "${keyword}":`, err.message)
    }
    await delay(interDelay)
  }
  return results
}


// ── AI reply draft ────────────────────────────────────────────────────────────
// Uses monitor's productContext + tone so each customer's drafts are tailored.
// Delegates to lib/draft-call.js so behavior matches the on-demand /v1/matches/draft
// endpoint and Olumide's own monitor.js — single source of truth for prompt,
// validation, AI-tell ban list, and stripMarkdown post-processing.
// Returns { draft, model } so the caller can attach `draftedBy` to the match.
//
// May 2026 — the v1-era `!post.approved` gate was removed here. That gate
// short-circuited drafting for any Reddit match whose subreddit wasn't in
// the hardcoded APPROVED_SUBREDDITS whitelist, which silently dropped ~77
// of every 100 undrafted matches in production despite those matches
// passing intent classification + minIntentScore. The AI-driven subreddit-
// intel feature (PR #62) routes monitors to subreddits OUTSIDE that
// whitelist on purpose, so the whitelist gate fought the rest of the
// pipeline. Quality control is now handled by:
//   - lib/relevance.js (passesRelevanceCheck) — relevance gate
//   - minIntentScore (default 40) — drops low-signal matches
//   - lib/classify.js — intent scoring 0-100
//   - lib/draft-prompt.js validateDraft + AI-tell ban list — output filter
// To restore strict whitelist behaviour, gate by APPROVED_SUBREDDITS at
// the search layer instead.
async function generateReplyDraft(post, productContext, tone, utmConfig) {
  if (!productContext || !productContext.trim()) return { draft: null, model: null }

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
function buildAlertEmail(monitor, matches, appUrl = 'https://ebenova.org') {
  const compMatches = matches.filter(m => m.matchType === 'competitor')
  const regularMatches = matches.filter(m => m.matchType !== 'competitor')

  const byKeyword = {}
  for (const m of regularMatches) {
    if (!byKeyword[m.keyword]) byKeyword[m.keyword] = []
    byKeyword[m.keyword].push(m)
  }

  const competitorSection = compMatches.length > 0 ? `
  <div style="margin-bottom:28px;padding:20px;background:#1a0a0a;border:2px solid #ff4444;border-radius:8px;">
    <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:#ff6666;margin-bottom:14px;">🎯 Competitor Activity (${compMatches.length})</div>
    ${compMatches.map(p => {
      const _cfbBase = `${appUrl}/v1/email-feedback?match_id=${encodeURIComponent(p.id)}&monitor_id=${encodeURIComponent(monitor.id)}`
      return `
      <div style="margin-bottom:12px;padding:12px;background:#2a1010;border-left:3px solid #ff4444;border-radius:4px;">
        <div style="font-size:11px;color:#ff8888;margin-bottom:4px;">via "${escapeHtml(p.competitorKeyword || p.keyword)}"</div>
        <a href="${escapeHtml(p.url)}" style="font-size:14px;font-weight:600;color:#ffcccc;text-decoration:none;">${escapeHtml(p.title)}</a>
        ${p.body ? `<p style="font-size:12px;color:#cc9999;margin:5px 0 0;">${escapeHtml(p.body.slice(0, 200))}${p.body.length > 200 ? '…' : ''}</p>` : ''}
        <a href="${escapeHtml(p.url)}" style="display:inline-block;margin-top:6px;font-size:11px;color:#ff8888;">Open thread →</a>
        <div style="margin-top:8px;padding-top:6px;border-top:1px solid #3a1515;font-size:11px;color:#996666;">Was this match useful?&nbsp;<a href="${_cfbBase}&v=yes" style="color:#4ade80;font-weight:700;text-decoration:none;">👍 Yes</a>&nbsp;·&nbsp;<a href="${_cfbBase}&v=no" style="color:#f87171;font-weight:700;text-decoration:none;">👎 No</a></div>
      </div>`
    }).join('')}
  </div>` : ''

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
      const scoreBadge = typeof p.intentScore === 'number'
        ? `<span style="display:inline-block;padding:2px 8px;margin-left:6px;background:#f0f9ff;color:#0369a1;border-radius:10px;font-size:10px;font-weight:700;">[Score: ${p.intentScore}]</span>`
        : ''
      const _fbBase = `${appUrl}/v1/email-feedback?match_id=${encodeURIComponent(p.id)}&monitor_id=${encodeURIComponent(monitor.id)}`
      return `
      <div style="margin-bottom:18px;padding:14px;background:#f9f9f9;border-left:4px solid #FF6B35;border-radius:4px;">
        <div style="font-size:12px;color:#888;margin-bottom:5px;">
          ${sourceLabel} · u/${escapeHtml(p.author)} · ${escapeHtml(p.score)} upvotes${sentimentBadge}${intentBadge}${highPriBadge}${scoreBadge}
        </div>
        ${p.matchExplanation ? `<div style="font-size:11px;color:#aaa;margin-bottom:6px;font-style:italic;">${escapeHtml(p.matchExplanation)}</div>` : ''}
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
        ${p._hunterEnrichment ? `
        <div style="margin-top:10px;padding:8px 12px;background:#f8f9fa;border:1px solid #e2e8f0;border-radius:6px;">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#64748b;margin-bottom:5px;">🔍 Lead intel</div>
          <div style="font-size:11px;color:#475569;line-height:1.6;">
            ${p._hunterEnrichment.company ? `<span style="margin-right:10px;">🏢 ${escapeHtml(p._hunterEnrichment.company)}</span>` : ''}
            ${p._hunterEnrichment.email ? `<a href="mailto:${escapeHtml(p._hunterEnrichment.email)}" style="color:#3b82f6;margin-right:10px;">✉️ ${escapeHtml(p._hunterEnrichment.email)}</a>` : ''}
            ${p._hunterEnrichment.linkedinUrl ? `<a href="${escapeHtml(p._hunterEnrichment.linkedinUrl)}" style="color:#3b82f6;margin-right:10px;">🔗 LinkedIn</a>` : ''}
            ${typeof p._hunterEnrichment.confidence === 'number' ? `<span style="color:#94a3b8;">${p._hunterEnrichment.confidence}% confidence</span>` : ''}
          </div>
        </div>` : ''}
        <div style="margin-top:10px;padding-top:8px;border-top:1px solid #eaeaea;font-size:12px;color:#999;">Was this match useful?&nbsp;<a href="${_fbBase}&v=yes" style="color:#16a34a;font-weight:700;text-decoration:none;">👍 Yes</a>&nbsp;·&nbsp;<a href="${_fbBase}&v=no" style="color:#dc2626;font-weight:700;text-decoration:none;">👎 No</a></div>
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
    ${competitorSection}
    ${keywordSections}
    ${buildEmailFooter(monitor.unsubscribeToken)}
  </body></html>`
}

// ── Store matches in Redis ─────────────────────────────────────────────────────
// Each match stored as insights:match:{monitorId}:{postId} with 7-day TTL.
// The list insights:matches:{monitorId} tracks all match IDs for that monitor.
async function storeMatches(redis, monitor, matches) {
  const TTL = 60 * 60 * 24 * 7 // 7 days
  for (const m of matches) {
    const key = `insights:match:${monitor.id}:${m.id}`
    // Only lpush when this is a genuinely new match. Existing keys mean the
    // ID is already in the list — re-pushing after a restart would create
    // duplicate list entries because the cycle-scoped _cycleSeenIds resets each
    // poll cycle while the 7-day match TTL keeps entries alive longer than the
    // 3-day seen:v2 TTL.
    const isNew = !(await redis.exists(key))
    await redis.set(key, JSON.stringify({ ...m, monitorId: monitor.id, storedAt: new Date().toISOString() }))
    await redis.expire(key, TTL)
    if (isNew) {
      await redis.lpush(`insights:matches:${monitor.id}`, m.id)
      await redis.expire(`insights:matches:${monitor.id}`, TTL)
    }
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
    const appUrl = process.env.APP_URL
    // Attach any cached Hunter enrichment data to matches before building the email.
    // Best-effort: Redis failure just means no lead intel pill in this email.
    if (redis) {
      for (const m of matches) {
        if (m.source !== 'reddit' || !m.author) continue
        try {
          const enrichKey = `author:enrichment:${monitor.id}:${m.source}:${m.author}`
          const raw = await redis.get(enrichKey)
          if (raw) {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
            if (parsed && (parsed.email || parsed.company || parsed.linkedinUrl)) {
              m._hunterEnrichment = parsed
            }
          }
        } catch (_) {}
      }
    }
    const html = buildAlertEmail(monitor, matches, appUrl)
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
    // Stamp lastEmailSentAt so the admin diagnostics endpoint can surface it.
    if (redis) {
      try {
        const _fresh = await redis.get(`insights:monitor:${monitor.id}`)
        if (_fresh) {
          const _parsed = typeof _fresh === 'string' ? JSON.parse(_fresh) : _fresh
          await redis.set(`insights:monitor:${monitor.id}`, JSON.stringify({ ..._parsed, lastEmailSentAt: new Date().toISOString() }))
        }
      } catch (_) {}
    }
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

  // Per-monitor Reddit request budget — same cap as the keyword-monitor cycle.
  // Builder Tracker's subreddit fan-out (BUILDER_KEYWORDS × BUILDER_SUBREDDITS)
  // is the original 429 culprit called out in lib/reddit-pacer.js, so it draws
  // from the same shared pool to avoid monopolizing the global pacer queue.
  const _redditBudget = { used: 0, max: parseInt(process.env.MONITOR_REDDIT_URL_CAP || '40') }

  // Reddit
  for (const kw of builderKws) {
    const matches = await searchReddit(monitor.id, kw, { requestBudget: _redditBudget })
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
    // Honour PLATFORM_DISABLED so the Builder Tracker doesn't burn cycle time
    // on platforms that are knocked out upstream (currently: twitter).
    if (isPlatformDisabled(key)) {
      console.log(`${label} [builder] Skipping disabled platform: ${key} (${PLATFORM_DISABLED[key]})`)
      continue
    }
    for (const kw of builderKws) {
      const matches = await scraper(kw, { seenIds, delay, MAX_AGE_MS: maxAgeMs })
      matches.forEach(m => allMatches.push(m))
      await delay(delayMs)
    }
  }
  console.log(`${label} ${allMatches.length} candidate matches gathered`)

  // Cheap heuristic filter — drops complaint / help-seeking posts.
  const _minComments = monitor.minComments || 0
  const builderMatches = allMatches.filter(m =>
    isBuilderPost(m) && m.comments >= _minComments
  )
  console.log(`${label} ${builderMatches.length} pass builder filter`)

  // Cap AI calls to top 10 by score — prevents burning groq-quality TPD
  // (100k/day) in a single cycle when 50+ builder posts arrive at once.
  const _builderCandidates = builderMatches
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 10)
  console.log(`${label} Builder: processing top ${_builderCandidates.length} of ${builderMatches.length} candidates (capped at 10)`)

  // Extract topics and record profiles. Best-effort: per-match failures
  // log inside the helpers but don't abort the cycle.
  const newProfiles = []
  let recorded = 0
  const redisClient = redis
  for (const match of _builderCandidates) {
    if (!PLATFORMS_WITH_REAL_USERNAMES.includes(match.source)) continue

    // Cache check — skip AI call if topics already extracted for this match ID.
    // Key: builder:topic:{match.id}, TTL 7 days. Failure is silently ignored.
    const _topicCacheKey = `builder:topic:${match.id}`
    let topics
    const _cachedRaw = redisClient
      ? await redisClient.get(_topicCacheKey).catch(() => null)
      : null
    if (_cachedRaw !== null && _cachedRaw !== undefined) {
      try {
        topics = typeof _cachedRaw === 'string' ? JSON.parse(_cachedRaw) : _cachedRaw
        if (!Array.isArray(topics)) topics = []
      } catch (_) { topics = [] }
    } else {
      topics = await extractTopics(match)
      if (Array.isArray(topics) && topics.length && redisClient) {
        redisClient.setex(_topicCacheKey, 604800, JSON.stringify(topics)).catch(() => {})
      }
    }

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

  // Keyword[0] diagnostic log — tells us immediately if keywords are stored as
  // objects (correct) or strings (very old), and whether keyword.keyword is a
  // string (correct) or a nested object (the [object Object] bug).
  {
    const kw0 = monitor.keywords?.[0]
    console.log(`[v2][${monitor.id}] Keyword[0] type: ${typeof kw0}, value: ${JSON.stringify(kw0)}`)
  }

  // Keyword migration: if any keyword entry has a non-string .keyword field
  // (monitors created before normalizeKeyword was enforced, or via older API
  // clients that sent { keyword: { term: '...', type: '...' } }), re-normalize
  // the whole keywords array in-place and write the fix back to Redis so the
  // next cycle doesn't repeat the migration.
  if (monitor.keywords?.some(k => typeof k !== 'string' && typeof k?.keyword !== 'string')) {
    console.log(`[v2][${monitor.id}] ⚠️  Keyword format needs migration — normalizing now`)
    const normalized = normalizeKeywordList(monitor.keywords)
    monitor = { ...monitor, keywords: normalized }
    try {
      const _r = getRedis()
      if (_r) {
        const _fresh = await _r.get(`insights:monitor:${monitor.id}`)
        if (_fresh) {
          const _parsed = typeof _fresh === 'string' ? JSON.parse(_fresh) : _fresh
          await _r.set(`insights:monitor:${monitor.id}`, JSON.stringify({ ..._parsed, keywords: normalized }))
          console.log(`[v2][${monitor.id}] ✅ Keywords migrated and written back to Redis (${normalized.length} keywords)`)
        }
      }
    } catch (_migErr) {
      console.warn(`[v2][${monitor.id}] Keyword migration write failed: ${_migErr.message}`)
    }
  }

  // Resolve which platforms this monitor wants. New monitors set platforms[]
  // explicitly; legacy monitors (no platforms field) get migrated from their
  // includeXxx flags. See lib/platforms.js for the rules.
  const platforms = migrateLegacyPlatforms(monitor)
  console.log(`${label} Starting — ${monitor.keywords.length} keywords, ${platforms.length} platforms: ${platforms.join(', ')}`)

  // Load expanded keywords from Redis and append to search (source: 'expanded')
  // Lazy-fill rationale: api-server.js fires expandKeywords + suggestSubreddits
  // as fire-and-forget at create time. If the AI provider is rate-limited or
  // briefly unavailable the cache never gets written and the monitor scans
  // only the user's literal keywords forever. Belt-and-suspenders: if either
  // cache is missing AND the monitor is more than LAZY_FILL_GRACE_MS old
  // (i.e. the create-time call had a fair chance), populate the cache here
  // before reading it. Operator-visible via the [lazy-fill] log lines so we
  // can see how often the create-time path is failing.
  const LAZY_FILL_GRACE_MS = 5 * 60 * 1000
  const monitorAgeMs = monitor.createdAt ? (Date.now() - new Date(monitor.createdAt).getTime()) : Infinity
  const _eligibleForLazyFill = redis && Number.isFinite(monitorAgeMs) && monitorAgeMs > LAZY_FILL_GRACE_MS

  let expandedKeywords = []
  if (redis) {
    let _raw = null
    try { _raw = await redis.get(`monitor:${monitor.id}:expanded_keywords`) } catch (_) {}
    if (!_raw && _eligibleForLazyFill && (monitor.keywords?.length || monitor.productContext)) {
      try {
        const { expandKeywords } = await import('./lib/keyword-expander.js')
        const expanded = await expandKeywords(monitor.keywords || [], monitor.productContext || '')
        if (expanded.length > 0) {
          await redis.setex(`monitor:${monitor.id}:expanded_keywords`, 86400 * 7, JSON.stringify(expanded))
          console.log(`${label} [lazy-fill] Populated expanded_keywords cache (${expanded.length} variants) — create-time call had failed`)
          _raw = JSON.stringify(expanded)
        }
      } catch (err) {
        console.warn(`${label} [lazy-fill] expanded_keywords failed: ${err.message}`)
      }
    }
    if (_raw) {
      try {
        const _arr = typeof _raw === 'string' ? JSON.parse(_raw) : _raw
        if (Array.isArray(_arr)) {
          expandedKeywords = _arr.map(k => ({ keyword: k, type: 'keyword', subreddits: [], source: 'expanded', productContext: monitor.productContext || '' }))
        }
      } catch (_) {}
    }
  }
  // Load suggested subreddits and attach to keywords that have none.
  // Capped at REDDIT_INTEL_FANOUT (default 3) — Reddit rate-limits aggressive
  // RSS fan-out, and returns diminish past the top-ranked few suggestions per
  // keyword. Combined with the circuit breaker this keeps request volume under
  // the anonymous ceiling.
  let suggestedSubreddits = []
  if (redis) {
    let _raw = null
    try { _raw = await redis.get(`monitor:${monitor.id}:suggested_subreddits`) } catch (_) {}
    if (!_raw && _eligibleForLazyFill && (monitor.keywords?.length || monitor.productContext)) {
      try {
        const { suggestSubreddits } = await import('./lib/subreddit-suggester.js')
        const suggested = await suggestSubreddits(monitor.productContext || '', monitor.keywords || [])
        if (suggested.length > 0) {
          await redis.setex(`monitor:${monitor.id}:suggested_subreddits`, 86400 * 7, JSON.stringify(suggested))
          console.log(`${label} [lazy-fill] Populated suggested_subreddits cache (${suggested.length} subs) — create-time call had failed`)
          _raw = JSON.stringify(suggested)
        }
      } catch (err) {
        console.warn(`${label} [lazy-fill] suggested_subreddits failed: ${err.message}`)
      }
    }
    if (_raw) {
      try {
        const _arr = typeof _raw === 'string' ? JSON.parse(_raw) : _raw
        if (Array.isArray(_arr)) suggestedSubreddits = _arr.slice(0, REDDIT_INTEL_FANOUT)
      } catch (_) {}
    }
  }
  const kwWithSubs = suggestedSubreddits.length > 0
    ? monitor.keywords.map(kw => (kw.subreddits?.length > 0 ? kw : { ...kw, subreddits: suggestedSubreddits }))
    : monitor.keywords
  const effectiveKeywords = [...kwWithSubs, ...expandedKeywords]

  // Per-monitor Reddit request budget. Shared counter passed into every
  // searchReddit call so all keyword/subreddit combinations for this monitor
  // draw from the same pool. Default 40 = ~1 min of pacer time at 1500ms/req;
  // enough for 8 keywords × 5 subreddits. Tune via MONITOR_REDDIT_URL_CAP.
  const MONITOR_REDDIT_URL_CAP = parseInt(process.env.MONITOR_REDDIT_URL_CAP || '40')
  const _redditBudget = { used: 0, max: MONITOR_REDDIT_URL_CAP }

  const allMatches = []
  const seenIds = { has: (id) => hasSeen(monitor.id, id), add: (id) => markSeen(monitor.id, id) }
  const maxAgeMs = 24 * 60 * 60 * 1000 // 24h for v2 monitors
  // Let everything through on the very first poll so new users see results
  // immediately. After that, the engagement gate removes low-signal noise.
  const _isFirstPoll = (monitor.totalMatchesFound || 0) === 0

  // ── Competitor mention tracking ─────────────────────────────────────────────
  const competitorMatches = []
  if ((monitor.competitors || []).length > 0) {
    const compKwEntries = buildCompetitorKeywords(monitor.competitors, monitor.productContext || '')
    if (platforms.includes('reddit')) {
      for (const compKwEntry of compKwEntries) {
        const phrase = compKwEntry.keyword
        const compKw = { keyword: phrase, type: 'competitor', subreddits: [], productContext: monitor.productContext || '' }
        const matches = await searchReddit(monitor.id, compKw, { requestBudget: _redditBudget })
        for (const m of matches) {
          m.matchType = 'competitor'
          m.competitorKeyword = phrase
          m.competitorName = compKwEntry.competitorName
          m.keywordType = 'competitor'
          m.productContext = monitor.productContext || ''
          competitorMatches.push(m)
        }
        console.log(`[competitor] "${phrase}" → ${matches.length} new`)
        await delay(2000)
      }
    }
    // Also search HN for competitor keywords
    if (platforms.includes('hackernews') || true) { // always search HN for competitor mentions
      const seenIdsCopy = seenIds
      for (const compKwEntry of compKwEntries) {
        const phrase = compKwEntry.keyword
        const compKw = { keyword: phrase, type: 'competitor', subreddits: [] }
        const matches = await searchHackerNews(compKw, { seenIds: seenIdsCopy, delay, MAX_AGE_MS: maxAgeMs })
        for (const m of matches) {
          m.matchType = 'competitor'
          m.competitorKeyword = phrase
          m.competitorName = compKwEntry.competitorName
          m.keywordType = 'competitor'
          competitorMatches.push(m)
        }
        if (matches.length) console.log(`[competitor] HN "${phrase}" → ${matches.length} new`)
        await delay(1500)
      }
    }
    if (competitorMatches.length) {
      console.log(`${label} Competitor tracking: ${competitorMatches.length} total matches from ${monitor.competitors.length} competitors`)
    }
  }
  // Merge competitor matches into allMatches (they bypass intent score filter below).
  //
  // RETRIEVAL CONTAINMENT GATE (competitor pipeline only). Competitor matches are
  // the one ingestion path that does NOT run passesRelevanceCheck during fetch, so
  // loose Reddit/HN hits for expanded queries ("X vs", "replace X", "X alternative")
  // leak unrelated cross-domain threads into the feed. Default-deny here: a
  // competitor candidate is admitted only if the BRAND NAME itself appears in
  // title+body — the expansion phrase is NOT used as a validation signal. This
  // does not touch the keyword/feed pipelines or passesRelevanceCheck behavior.
  let _compDropped = 0
  for (const m of competitorMatches) {
    if (!m.competitorName || !passesRelevanceCheck(m, m.competitorName, 'competitor')) { _compDropped++; continue }
    allMatches.push(m)
  }
  if (_compDropped) {
    console.log(`${label} Competitor containment: dropped ${_compDropped}/${competitorMatches.length} off-brand matches`)
  }
  // ── End competitor tracking ──────────────────────────────────────────────────

  // Reddit — explicitly opt-in per platforms array. No longer always-on.
  if (platforms.includes('reddit')) {
    for (const kw of effectiveKeywords) {
      const ctx = kw.productContext || monitor.productContext || ''
      const kwType = kw.type || 'keyword'
      // If keyword has no explicit subreddits but we have AI-suggested ones, use them.
      // The 404/403 blacklist filter applies to BOTH explicit and AI-suggested
      // subreddit lists — once Reddit has confirmed a sub doesn't exist (404)
      // or is private/quarantined (403), it doesn't matter who originally added
      // it to the list. Production logs (2026-05-12) showed Prembly's monitor
      // hitting r/identityverification's 404 every cycle because it was in the
      // explicit list, not the dynamic one.
      const _useSuggested = (!kw.subreddits || kw.subreddits.length === 0) && suggestedSubreddits.length > 0
      let _kwSubs = _useSuggested ? suggestedSubreddits : kw.subreddits
      if (redis && _kwSubs?.length) {
        const _filtered = []
        for (const _sr of _kwSubs) {
          const _subName = String(_sr).toLowerCase().replace(/^r\//, '')
          const _isBad = await redis.get(`subreddit:404:${_subName}`).catch(() => null)
          if (_isBad) {
            console.log(`${label} [subreddit-intel] Skipping blacklisted subreddit r/${_subName}${_useSuggested ? '' : ' (explicit list — edit the monitor to remove it)'}`)
            continue
          }
          _filtered.push(_sr)
        }
        _kwSubs = _filtered
      }
      const kwWithSubs = _useSuggested
        ? { ...kw, subreddits: _kwSubs, _dynamicSubreddits: true }
        : { ...kw, subreddits: _kwSubs }
      if (_useSuggested) {
        console.log(`${label} [subreddit-intel] Using ${_kwSubs.length} suggested subreddits for "${kw.keyword}"`)
      }
      const redditMatches = await searchReddit(monitor.id, kwWithSubs, { requestBudget: _redditBudget })
      let _redditIrrelevant = 0
      for (const m of redditMatches) {
        m.productContext = ctx
        m.keywordType = kwType   // PR #28
        m.matchedKeyword = kw.keyword
        // ── Relevance gate ─────────────────────────────────────────────
        if (!passesRelevanceCheck(m, kw.keyword, kwType)) { _redditIrrelevant++; continue }
        // ── Engagement gate ────────────────────────────────────────────
        const _minComments = monitor.minComments || 0
        const _hasEngagement = (m.score >= 1 || m.comments >= 1)
        const _meetsMinComments = m.comments >= _minComments
        const _isFreshUnanswered = (() => {
          const _ageMs = Date.now() - new Date(m.createdAt || 0).getTime()
          return _ageMs < 2 * 60 * 60 * 1000
        })()
        const _isHighTrustSource = [
          'hackernews','stackoverflow','indiehackers','g2','medium','substack','upwork','fiverr',
          'youtube','amazon','jijing','twitter','rss','telegram'
        ].includes(m.source)
        const _isHumanGithub = (
          m.source === 'github' &&
          !(m.author || '').toLowerCase().includes('[bot]')
        )
        if (!_isFirstPoll && !_hasEngagement && !_isFreshUnanswered &&
            !_isHighTrustSource && !_isHumanGithub) continue
        if (!_meetsMinComments) continue
        // ── End engagement gate ─────────────────────────────────────────
        allMatches.push(m)
      }
      if (redditMatches.length > 0) {
        const _redditKept = redditMatches.length - _redditIrrelevant
        console.log(`${label} Reddit "${kw.keyword}"${kw.source === 'expanded' ? ' [expanded]' : ''}${kwType === 'competitor' ? ' [competitor]' : ''}${kwType === 'phrase' ? ' [phrase]' : ''}: ${_redditKept} relevant${_redditIrrelevant ? ` (${_redditIrrelevant} irrelevant dropped)` : ''}`)
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
    { key: 'hackernews',    scraper: searchHackerNews,    delayMs: 1500 },
    { key: 'stackoverflow', scraper: searchStackOverflow, delayMs: 1500 },
    { key: 'indiehackers', scraper: searchIndieHackers,  delayMs: 2000 },
    { key: 'g2',           scraper: searchG2,             delayMs: 2000 },
    { key: 'medium',        scraper: searchMedium,        delayMs: 1500 },
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
    // HN is always-on: ask_hn posts are high-intent (founders asking for tools)
    // and the Algolia endpoint is free/fast. Skip the platforms check for it.
    if (key !== 'hackernews' && !platforms.includes(key)) continue
    // PLATFORM_DISABLED is the single source of truth for "currently broken
    // upstream" — see lib/platforms.js for per-platform reason + re-enable
    // requirements. Skipped BEFORE the per-keyword loop so we don't pay
    // delayMs × keyword-count of dead time on a 100%-failing scraper.
    if (isPlatformDisabled(key)) {
      console.log(`${label} Skipping disabled platform: ${key} (${PLATFORM_DISABLED[key]})`)
      continue
    }
    for (const kw of effectiveKeywords) {
      const ctx = kw.productContext || monitor.productContext || ''
      const kwType = kw.type || 'keyword'   // PR #28
      const matches = await scraper(kw, { seenIds, delay, MAX_AGE_MS: maxAgeMs })
      let _gated = 0
      for (const m of matches) {
        m.productContext = ctx; m.keywordType = kwType; m.matchedKeyword = kw.keyword
        // ── Relevance gate ───────────────────────────────────────────────
        if (!passesRelevanceCheck(m, kw.keyword, kwType)) { _gated++; continue }
        // ── Engagement gate ──────────────────────────────────────────────
        const _minComments = monitor.minComments || 0
        const _hasEngagement = (m.score >= 1 || m.comments >= 1)
        const _meetsMinComments = m.comments >= _minComments
        const _isFreshUnanswered = (() => {
          const _ageMs = Date.now() - new Date(m.createdAt || 0).getTime()
          return _ageMs < 2 * 60 * 60 * 1000
        })()
        const _isHighTrustSource = [
          'hackernews','stackoverflow','indiehackers','g2','medium','substack','upwork','fiverr',
          'youtube','amazon','jijing','twitter','rss','telegram'
        ].includes(m.source)
        const _isHumanGithub = (
          m.source === 'github' &&
          !(m.author || '').toLowerCase().includes('[bot]')
        )
        if (!_hasEngagement && !_isFreshUnanswered &&
            !_isHighTrustSource && !_isHumanGithub) { _gated++; continue }
        if (!_meetsMinComments) { _gated++; continue }
        // ── End engagement gate ───────────────────────────────────────────
        allMatches.push(m)
      }
      const _kept = matches.length - _gated
      if (_kept) console.log(`${label} ${PLATFORM_LABELS[key] || key} "${kw.keyword}"${kwType === 'competitor' ? ' [competitor]' : ''}${kwType === 'phrase' ? ' [phrase]' : ''}: ${_kept} new${_gated ? ` (${_gated} irrelevant/zero-engagement dropped)` : ''}`)
      await delay(delayMs)
    }
  }

  // ── Feed-based sources (run once per cycle, not per keyword) ─────────────
  // RSS and Telegram ingest full feeds and filter client-side against all
  // monitor keywords, so they are called once here instead of per-keyword.
  const allKeywordStrings = effectiveKeywords.map(resolveKeyword)
  const feedCtx = {
    seenIds,
    delay,
    MAX_AGE_MS: maxAgeMs,
    allKeywords: allKeywordStrings,
    rssFeeds:         monitor.rssFeeds         || [],
    telegramChannels: monitor.telegramChannels || [],
  }

  for (const [platformKey, scraper] of [['rss', searchRSS], ['telegram', searchTelegram]]) {
    if (!platforms.includes(platformKey)) continue
    const feedMatches = await scraper(null, feedCtx)
    let _feedGated = 0
    for (const m of feedMatches) {
      const kw     = monitor.keywords.find(k => resolveKeyword(k).toLowerCase() === m.keyword.toLowerCase()) || monitor.keywords[0]
      const kwType = (kw && kw.type) || 'keyword'
      m.productContext  = (kw && kw.productContext) || monitor.productContext || ''
      m.keywordType     = kwType
      m.matchedKeyword  = m.keyword
      if (!passesRelevanceCheck(m, m.keyword, kwType)) { _feedGated++; continue }
      const _meetsMinComments = m.comments >= (monitor.minComments || 0)
      if (!_meetsMinComments) { _feedGated++; continue }
      allMatches.push(m)
    }
    const _feedKept = feedMatches.length - _feedGated
    if (_feedKept) console.log(`${label} ${PLATFORM_LABELS[platformKey] || platformKey}: ${_feedKept} new${_feedGated ? ` (${_feedGated} irrelevant dropped)` : ''}`)
    if (feedMatches.length) await delay(1500)
  }

  // NOTE: competitor keywords used to be searched on Reddit a second time here,
  // but that loop was redundant with the competitor-tracking block above (both
  // derive identical global-search URLs from buildCompetitorKeywords, which
  // always returns subreddits:[]). The earlier block runs first and marks those
  // entries seen, so this loop returned ~0 new matches while still firing the
  // requests — and worse, it was NOT gated on platforms.includes('reddit'), so
  // it hit Reddit even for monitors that hadn't selected it. The budgeted,
  // reddit-gated competitor loop above is the single source of truth. Removed.

  // ── Feed filters: excludeTerms + blockedSubreddits ───────────────────────
  // Applied before classify to avoid spending Groq tokens on posts that will
  // never reach the user's feed.
  const _excludeTerms = (monitor.excludeTerms || []).map(t => t.toLowerCase())
  const _blockedSubs  = new Set((monitor.blockedSubreddits || []).map(s => s.toLowerCase().replace(/^r\//, '')))
  if (_excludeTerms.length || _blockedSubs.size) {
    const _before = allMatches.length
    const _kept = allMatches.filter(m => {
      if (_blockedSubs.size && _blockedSubs.has((m.subreddit || '').toLowerCase())) return false
      if (_excludeTerms.length) {
        const _hay = `${m.title} ${m.body}`.toLowerCase()
        if (_excludeTerms.some(t => _hay.includes(t))) return false
      }
      return true
    })
    allMatches.splice(0, allMatches.length, ..._kept)
    const _dropped = _before - allMatches.length
    if (_dropped) console.log(`${label} Feed filter dropped ${_dropped}/${_before} matches`)
  }
  // ── End feed filters ───────────────────────────────────────────────────────

  // ── Intent-grounding pre-filter (Stage 2: semantic disambiguation) ───────────
  // Sits between retrieval (passesRelevanceCheck) and classify. Drops candidates
  // that are mis-grounded BEFORE the classifier sees them, so the model is never
  // asked to compensate for domain/direction errors:
  //   - domain mismatch  (polysemy): a code-artifact post (GitHub/SO) on a
  //     non-developer monitor — e.g. "MVP validation" matching a CI-pipeline PR.
  //   - stance inversion (intent direction): a supply/announce post ("I built X",
  //     "Show HN") matching a demand keyword ("looking for a co-founder").
  // Competitor matches are skipped (they have the #84 brand gate). Deterministic
  // and recall-conservative — only drops on strong signal. Runs before classify
  // so mis-grounded posts don't cost a Groq call. See lib/intent-grounding.js.
  {
    const _gctx = groundingContext(monitor)
    const _before = allMatches.length
    const _reasons = { domain_mismatch: 0, stance_inversion: 0 }
    const _kept = allMatches.filter(m => {
      if (m.matchType === 'competitor' || m.keywordType === 'competitor') return true
      const g = groundIntent(m, _gctx)
      if (!g.admit) { _reasons[g.reason] = (_reasons[g.reason] || 0) + 1 }
      return g.admit
    })
    const _dropped = _before - _kept.length
    allMatches.splice(0, allMatches.length, ..._kept)
    if (_dropped) {
      console.log(`${label} Intent-grounding dropped ${_dropped}/${_before} (domain=${_reasons.domain_mismatch}, stance=${_reasons.stance_inversion})`)
    }
  }
  // ── End intent-grounding ─────────────────────────────────────────────────────

  if (allMatches.length === 0) {
    console.log(`${label} No new matches`)
    // Track consecutive zero-match cycles in Redis so the dashboard can
    // surface a "your keywords may need tuning" nudge to the user.
    // Counter resets when ANY post makes it through the relevance gate
    // (i.e. allMatches.length > 0 here, before intent filter). This
    // distinguishes "no posts at all" from "posts found but all low-intent".
    if (redis) {
      try {
        const zeroKey = `monitor:${monitor.id}:zero_match_cycles`
        const count = await redis.incr(zeroKey)
        await redis.expire(zeroKey, 60 * 60 * 24 * 7) // 7-day TTL
        if (count >= 3) {
          console.warn(`${label} ⚠️  ${count} consecutive zero-match cycles — keywords may need tuning`)
        }
      } catch (_) {}
    }
    return
  }
  // Reset zero-match counter — we found relevant posts this cycle
  if (redis) redis.del(`monitor:${monitor.id}:zero_match_cycles`).catch(() => {})

  // ── Classify sentiment + intent (best-effort, before drafting) ───────────
  // Why before drafting: priority sort uses intent. Why best-effort: classify
  // failure must never block storage or email. Cap-aware via shared groq cap.
  // FIX 8 — concurrency dropped from 5 to 2. Five concurrent Groq calls per
  // batch × 2 monitors-in-parallel = 10 concurrent Groq requests, which
  // bursts past Groq's free-tier 30/min ceiling.
  // FIX (May 2026) — concurrency dropped further from 2 → 1 and inter-call
  // delay tightened to a configurable 200ms. The previous 2-concurrent +
  // 300ms-between-batches pattern produced 2-call bursts back-to-back, which
  // hit llama-3.1-8b-instant's 6000 TPM ceiling on monitors that found 10+
  // matches. Sequential + 200ms gap caps us at ≤5 RPS = ≤300 RPM, well under
  // Groq's 30 RPM account-level limit. Tune via CLASSIFY_DELAY_MS env if the
  // TPM math turns out to need an even slower drip — see lib/ai-router.js
  // TASK_ROUTING.classify_match for the routing context.
  // 2026-05-12 — production logs show Groq llama-3.1-8b-instant 6000 TPM
  // ceiling still being hit on 12-17-match classify batches even with the
  // PR #64 throttle. The fallback to GROQ_QUALITY recovers each call so no
  // classifications are dropped, but every 429 adds ~1s of latency × batch
  // size. The real math: 1 call per 200ms = 5 RPS × ~250 tok/req = 75k TPM
  // (12.5× over budget). Bumping default to 400ms = 2.5 RPS ≈ 37.5k TPM
  // (still over but with bigger headroom, halving the 429-retry tax).
  // For TPM-safe operation, set CLASSIFY_DELAY_MS=2500 (~24 RPM = ~6k TPM).
  const CLASSIFY_CONCURRENCY = parseInt(process.env.CLASSIFY_CONCURRENCY || '1')
  const CLASSIFY_DELAY_MS    = parseInt(process.env.CLASSIFY_DELAY_MS    || '400')
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
        m.intentScore = result.intent_score     // ← intent scoring 0-100
        m.intentReasoning = result.reasoning    // ← one-sentence reasoning
        // Derive commercial_signal + specificity for WHY panel in dashboard
        m.commercial_signal = ['buying', 'asking_for_tool'].includes(result.intent) || (result.intent_score >= 70)
        m.specificity = (result.confidence === 'high' && result.intent_score >= 70) ? 'clear' : (result.confidence === 'low' || result.intent_score < 40) ? 'vague' : 'moderate'
      }
    }))
    if (i + CLASSIFY_CONCURRENCY < allMatches.length) await delay(CLASSIFY_DELAY_MS)
  }
  // Cycle summary so operator can see the intent mix at a glance
  const highValue = allMatches.filter(m => m.intent === 'asking_for_tool' || m.intent === 'buying').length
  const complaining = allMatches.filter(m => m.intent === 'complaining').length
  const otherClassified = allMatches.filter(m => m.intent && m.intent !== 'asking_for_tool' && m.intent !== 'buying' && m.intent !== 'complaining').length
  console.log(`${label} Classified ${allMatches.length} matches: ${highValue} buying/asking_for_tool, ${complaining} complaining, ${otherClassified} other`)

  // ask_hn boost: Ask HN posts are founders explicitly asking for tools —
  // classify scores these lower because they lack urgency language, but
  // they are high-value leads. Floor their intentScore at 60.
  for (const m of allMatches) {
    if (m.source === 'hackernews' && m.type === 'ask_hn') {
      if (typeof m.intentScore !== 'number' || m.intentScore < 60) m.intentScore = 60
    }
    // Attach a one-line match explanation so users can see WHY this surfaced.
    // Keeps it honest: matched keyword + source + intent if classified.
    if (!m.matchExplanation) {
      const kw = m.matchedKeyword || m.keyword || ''
      const src = m.source === 'reddit' ? `r/${m.subreddit}` : m.source
      const intentLabel = m.intent ? ` • ${m.intent.replace(/_/g, ' ')}` : ''
      m.matchExplanation = `Matched “${kw}” in ${src}${intentLabel}`
    }
  }

  // minIntentScore filter — drop low-signal matches before drafting/emailing
  const _minScore = typeof monitor.minIntentScore === 'number' ? monitor.minIntentScore : 40
  const _beforeFilter = allMatches.length
  allMatches.splice(0, allMatches.length, ...allMatches.filter(m => {
    if (m.matchType === 'competitor' || m.keywordType === 'competitor') return true  // competitor matches always pass
    if (typeof m.intentScore === 'number') return m.intentScore >= _minScore
    return true  // unclassified passes through
  }))
  if (allMatches.length < _beforeFilter) {
    console.log(`${label} Intent filter: kept ${allMatches.length}/${_beforeFilter} (minIntentScore=${_minScore})`)
  }

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
      // PR #29 — final piece. UTM-injected product URLs in the draft get
      // rewritten to a short link `${APP_URL}/r/${m.id}` which the api-server
      // `/r/:matchId` route redirects through (bumping a click counter on
      // each hop). The raw UTM URL is persisted on the match record AND on
      // its own Redis key `match:<id>:url` so the redirect route can look
      // it up without scanning monitor records.
      //
      // Net effect: every UTM-injected draft posted on Reddit becomes a
      // measurable funnel. The "Z drove traffic" digest line + the
      // AggregateOutcomesPanel 4th big-number both read from
      // `match:<id>:clicks`.
      if (m.draft && monitor.productUrl) {
        const utmUrl = extractInjectedUtmUrl({ draft: m.draft, productUrl: monitor.productUrl })
        if (utmUrl) {
          m.utmUrl = utmUrl
          m.utmInjectedAt = new Date().toISOString()
          const _appUrl   = process.env.APP_URL || 'https://ebenova.org'
          const shortUrl  = `${_appUrl.replace(/\/+$/, '')}/r/${m.id}`
          // String split/join is safer than regex when the UTM URL contains
          // regex-special characters (it always has `?` and `&`).
          m.draft         = m.draft.split(utmUrl).join(shortUrl)
          m.utmShortUrl   = shortUrl
          if (redis) {
            const _redirectTtl = 60 * 24 * 60 * 60   // 60 days
            // Best-effort writes — never throw if Upstash blips. The match
            // record itself is the source of truth for `m.utmUrl`; these
            // keys just power the redirect-layer lookup.
            await redis.setex(`match:${m.id}:url`, _redirectTtl, utmUrl).catch(() => {})
            await redis.set(`match:${m.id}:clicks`, '0', { nx: true, ex: _redirectTtl }).catch(() => {})
          }
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
  const SOURCE_RANK = { reddit: 0, hackernews: 1, stackoverflow: 2, indiehackers: 3, g2: 4, quora: 5, medium: 6, substack: 7, upwork: 8, fiverr: 9, twitter: 10, jijing: 11, youtube: 12, amazon: 13 }
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

  // ── Opportunity detection ──────────────────────────────────────────────────
  monitor._opportunitySummary = null
  {
    const _highDemand = allMatches.filter(m => (m.demandScore || 0) >= 7)
    if (_highDemand.length >= 2 && GROQ_API_KEY) {
      try {
        const _oppKeyword = monitor.keywords?.[0]?.keyword || 'this topic'
        const _oppTitles  = _highDemand.slice(0, 5).map(m => `- ${m.title}`).join('\n')
        const _oppPrompt  = [
          `These ${_highDemand.length} posts show strong buying intent`,
          `for "${_oppKeyword}":\n${_oppTitles}\n`,
          `In 1–2 sentences, describe the specific pain point or`,
          `opportunity these people share. Be concrete. No marketing`,
          `language. No "consider" or "leverage". Plain English.`,
        ].join(' ')

        const _oppRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            model:       'llama3-8b-8192',
            messages:    [{ role: 'user', content: _oppPrompt }],
            max_tokens:  120,
            temperature: 0.3,
          }),
        })

        if (_oppRes.ok) {
          const _oppData = await _oppRes.json()
          const _oppText = _oppData.choices?.[0]?.message?.content?.trim()
          if (_oppText && _oppText.length > 10) {
            monitor._opportunitySummary = _oppText
            console.log(`${label} 🎯 Opportunity: ${_oppText.slice(0, 80)}…`)
          }
        } else {
          console.warn(`${label} Opportunity detection: Groq ${_oppRes.status}`)
        }
      } catch (_oppErr) {
        console.warn(`${label} Opportunity detection failed: ${_oppErr.message}`)
      }
    }
  }
  // ── End opportunity detection ──────────────────────────────────────────────

  // Store in Redis + send alert
  try {
    await storeMatches(redis, monitor, allMatches)

    // Per-keyword health tracking. Builds a keyword → count map from allMatches.
    // Keywords with 0 matches this cycle also get registered so firstSeenAt is set.
    {
      const matchesByKw = new Map(monitor.keywords.map(kw => [kw.keyword, 0]))
      for (const m of allMatches) {
        if (m.matchedKeyword && matchesByKw.has(m.matchedKeyword)) {
          matchesByKw.set(m.matchedKeyword, matchesByKw.get(m.matchedKeyword) + 1)
        }
      }
      await updateKeywordHealth(redis, monitor.id, matchesByKw)
    }

    // Update monitor's lastPollAt + totalMatchesFound + lastMatchCount
    const updatedMonitor = {
      ...monitor,
      lastPollAt:        new Date().toISOString(),
      totalMatchesFound: (monitor.totalMatchesFound || 0) + allMatches.length,
      lastMatchCount:    allMatches.length,
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
      // Hunter.io lead enrichment — fire-and-forget, never blocks the cycle.
      // Only runs for high-intent (score >= 70) Reddit matches when key is set.
      if (process.env.HUNTER_API_KEY && m.source === 'reddit') {
        const { enrichAuthor } = await import('./lib/hunter-enrich.js')
        enrichAuthor({ match: m, monitorId: monitor.id, redis }).then(enrichResult => {
          if (enrichResult.enriched) {
            console.log(`[hunter] enriched ${m.author}: ${enrichResult.data?.email || 'no email'} @ ${enrichResult.data?.company || 'unknown company'}`)
          }
        }).catch(err => {
          console.warn(`[hunter] enrichment error for ${m.author}: ${err.message}`)
        })
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

  // Only alert on high-signal intents. Researching / recommending stay in the
  // feed for manual review but don't trigger email or Slack noise.
  const ALERT_INTENTS = new Set(['buying', 'asking_for_tool', 'complaining', 'venting'])
  const alertMatches = allMatches.filter(m => !m.intent || ALERT_INTENTS.has(m.intent))
  const _silenced = allMatches.length - alertMatches.length
  if (_silenced > 0) console.log(`${label} ${_silenced} match(es) silenced from alerts (researching/recommending intent)`)

  await sendMonitorAlert(monitor, alertMatches)

  // Slack alert (uses per-monitor webhook if set, falls back to global env var)
  const slackUrl = monitor.slackWebhookUrl || process.env.SLACK_WEBHOOK_URL
  if (slackUrl && alertMatches.length > 0) {
    await sendSlackAlert(slackUrl, alertMatches)
    console.log(`${label} Slack alert sent — ${alertMatches.length} matches`)
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

  // Reset cycle-scoped seen set — bounds memory to one poll cycle.
  // Cross-cycle dedup is handled by Redis seen:v2:{monitorId}:{postId} keys.
  _cycleSeenIds = new Set()

  let redisInner
  try {
    redisInner = redis
    if (!redisInner) throw new Error('Redis not configured')
  } catch (err) {
    console.error('[v2] Redis unavailable — skipping cycle:', err.message)
    return
  }

  // Load all active monitor IDs
  let monitorIds = []
  try {
    monitorIds = await redisInner.smembers('insights:active_monitors') || []
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
      const flag = await redisInner.get(`poll-now:${id}`)
      if (flag) {
        priorityIds.add(id)
        await redisInner.del(`poll-now:${id}`)
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
      const raw = await redisInner.get(`insights:monitor:${id}`)
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
    // Release references to help GC between monitor batches
    if (global.gc) global.gc()
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
  // Memory usage logging every 5 minutes. The worker's steady-state working
  // set is ~360–400MB heap, so the old `> 300MB` threshold fired on every
  // single tick and cried "possible leak" when nothing was wrong. Warn only
  // above HEAP_WARN_MB (default 700) — well above normal but low enough to
  // catch a genuine runaway. A real leak shows heapUsed climbing across
  // cycles; it currently oscillates and resets each cycle.
  const HEAP_WARN_MB = parseInt(process.env.MONITOR_HEAP_WARN_MB || '700')
  setInterval(() => {
    const m = process.memoryUsage()
    const heapUsedMB = Math.round(m.heapUsed/1024/1024)
    const heapTotalMB = Math.round(m.heapTotal/1024/1024)
    console.log(`[v2] 📊 Memory: Heap ${heapUsedMB}/${heapTotalMB}MB | RSS ${Math.round(m.rss/1024/1024)}MB | Seen entries (cycle): ${_cycleSeenIds.size} | EmbedCache: ${embeddingCache.size}`)
    if (heapUsedMB > HEAP_WARN_MB) {
      console.warn(`[v2] ⚠️  Elevated heap: ${heapUsedMB}MB (warn threshold ${HEAP_WARN_MB}MB)`)
      // Force a GC hint and trim the embedding cache aggressively
      if (embeddingCache.size > 500) {
        let trimmed = 0
        for (const k of embeddingCache.keys()) {
          embeddingCache.delete(k)
          if (++trimmed >= embeddingCache.size / 2) break
        }
        console.warn(`[v2] ⚠️  Trimmed embeddingCache to ${embeddingCache.size} entries`)
      }
      if (global.gc) global.gc()
    }
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
