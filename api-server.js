// reddit-monitor/api-server.js
// Express HTTP API — exposes reddit-monitor as a service on Railway
// Mounts alongside the v1/v2 cron workers via start-all.js
//
// Endpoints:
//   GET    /health
//   GET    /v1/me                — auth check + plan/email
//   GET    /v1/monitors          — list monitors for an owner (by API key)
//   POST   /v1/monitors          — create monitor (atomic plan-limit check, F13)
//   DELETE /v1/monitors/:id      — deactivate monitor
//   GET    /v1/matches           — list recent matches for a monitor
//   POST   /v1/matches/draft     — regenerate AI draft for a match (Groq cost-capped)
//   POST   /v1/matches/feedback  — thumbs up/down on a draft
//   POST   /v1/auth/signup       — magic-link auth (idempotent, resends login)
//   POST   /v1/subscribe         — landing-page waitlist
//   POST   /v1/billing/*         — Stripe checkout/portal/webhook (F1-F4 fixes)
//   POST   /v1/search            — on-demand cross-platform search (cost-capped)
//   POST   /v1/search/draft      — AI reply for a search result (Groq cost-capped)

import express from 'express'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import stripeRoutes, { webhookHandler } from './routes/stripe.js'
import { createRouter as createFindRouter } from './routes/find.js'
import { createRouter as createFeedbackRouter } from './routes/feedback.js'
import {
  generateUnsubscribeToken,
  resolveUnsubscribeToken,
  setMonitorEmailEnabled,
  deleteMonitorAndData,
  logDeletion,
  removeResendContact,
} from './lib/account-deletion.js'
import searchMedium      from './lib/scrapers/medium.js'
import searchSubstack    from './lib/scrapers/substack.js'
import searchQuora       from './lib/scrapers/quora.js'
import searchUpwork      from './lib/scrapers/upwork.js'
import searchFiverr      from './lib/scrapers/fiverr.js'
import searchGitHub      from './lib/scrapers/github.js'
import searchProductHunt from './lib/scrapers/producthunt.js'
import searchTwitter     from './lib/scrapers/twitter.js'
// LinkedIn scraper exists but is not wired in — see lib/platforms.js for why.
import { loadEnv } from './lib/env.js'
import { makeCorsMiddleware } from './lib/cors.js'
import helmet from 'helmet'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

// Load .env via shared dotenv loader (replaces hand-rolled parser).
loadEnv()

// Hotfix-narrowed env validation. Hard-required set is the four vars whose
// absence makes the API nonfunctional (no Redis = no monitors; no Resend
// = no emails; no Groq = no drafts). Everything else is warn-only because
// the code has a working fallback OR a graceful 5xx degrade — and PR #43's
// broader hard-fail brought production down on a deploy that had been
// quietly relying on those fallbacks for a long time.
//
// STRIPE_PRICE_STARTER (per audit spec) is intentionally omitted — starter
// is the free tier with no Stripe product. We use the actual env var names
// that routes/stripe.js consumes.
import { requireEnv, warnEnv } from './lib/env-required.js'
requireEnv([
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'RESEND_API_KEY', 'GROQ_API_KEY',
])
warnEnv([
  { name: 'ANTHROPIC_API_KEY',       reason: 'Claude tasks will fall back to Groq' },
  { name: 'STRIPE_SECRET_KEY',       reason: 'billing endpoints will return 503' },
  { name: 'STRIPE_WEBHOOK_SECRET',   reason: 'plan upgrades from checkout will not apply' },
  { name: 'STRIPE_GROWTH_PRICE_ID',  reason: 'Growth plan checkout will return 503' },
  { name: 'STRIPE_SCALE_PRICE_ID',   reason: 'Scale plan checkout will return 503' },
  { name: 'FROM_EMAIL',              reason: 'defaults to insights@ebenova.org' },
  { name: 'APP_URL',                 reason: 'defaults to https://ebenova.org' },
])

import { Redis } from '@upstash/redis'
import { randomBytes } from 'crypto'
import { makeRateLimiter } from './lib/rate-limit.js'
import { makeCostCap } from './lib/cost-cap.js'
import { verifyCaptcha } from './lib/captcha.js'
import { applyInviteToUser } from './lib/invite.js'
import { draftCall, extractInjectedUtmUrl } from './lib/draft-call.js'
import { validatePlatforms, migrateLegacyPlatforms, VALID_PLATFORMS } from './lib/platforms.js'
import { classifyMatch, intentPriority } from './lib/classify.js'
import { sendOutboundWebhook, buildPayload as buildWebhookPayload } from './lib/outbound-webhook.js'
import { toCsv, matchToExportRow, MATCH_EXPORT_COLUMNS } from './lib/csv-export.js'
import { gatherReportData, buildExecutiveSummary, renderReportHtml, resolveReportToken } from './lib/client-report.js'
import { normalizeKeywordList, isoWeekLabel, previousIsoWeekLabel } from './lib/keyword-types.js'
import { getBuilderProfiles, buildersToCSV } from './lib/builder-tracker.js'
import { getRecentReports, topCompetitorsAcross, computeTrend } from './lib/ai-visibility.js'
import { listPresets, getPreset } from './lib/keyword-presets.js'
import { scheduleEngagementCheck, getRecentOutcomes } from './lib/reply-tracker.js'
import { listCorridors, getCorridor, isValidCorridorId } from './lib/diaspora-corridors.js'

const PORT = parseInt(process.env.API_PORT || process.env.PORT || '3001')
// FIX 13 — MONITOR_ADMIN_KEY removed. The variable was read here but never
// referenced anywhere downstream; production audit flagged it as dead
// config. Re-add (and actually wire it) when an admin endpoint is built.

// F5: Signup rate limit + email validation. Lazy-init so .env loads first.
let _signupLimiter
function signupLimiter() {
  if (!_signupLimiter) _signupLimiter = makeRateLimiter(getRedis(), { max: 3, windowSeconds: 3600 })
  return _signupLimiter
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','guerrillamail.com','10minutemail.com','tempmail.com',
  'sharklasers.com','trashmail.com','yopmail.com','throwawaymail.com',
])

// F14: Daily cost caps. Lazy-init so missing Redis at boot doesn't crash.
let _groqCap, _searchCap
function getGroqCap() {
  if (!_groqCap) _groqCap = makeCostCap(getRedis(), { resource: 'groq', dailyMax: parseInt(process.env.GROQ_DAILY_MAX || '5000') })
  return _groqCap
}
function getSearchCap() {
  if (!_searchCap) _searchCap = makeCostCap(getRedis(), { resource: 'search', dailyMax: parseInt(process.env.SEARCH_DAILY_MAX || '500') })
  return _searchCap
}

// ── Redis ──────────────────────────────────────────────────────────────────
function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must both be set')
  return new Redis({ url, token })
}

// FIX 4 — Long-lived Redis TTLs on user/account records.
// 365 days. Inactive users still hang on for a year before garbage-collection,
// but no longer accumulate forever. Renewed on every successful auth.
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60

// FIX 6 — Internal-error responder. Generates a per-request id, logs the
// underlying error server-side, returns a generic message to the client so
// raw library error strings ("redis ECONNREFUSED", "JSON parse: unexpected
// token") don't reach end users. The id lets ops correlate a 500 the user
// reports with the matching log line.
function makeRequestId() {
  return Math.random().toString(36).slice(2, 10)
}
function serverError(res, err, context = '') {
  const requestId = makeRequestId()
  console.error(`[api] Internal error ${requestId}${context ? ' [' + context + ']' : ''}:`, err)
  res.status(500).json({
    success: false,
    error: { code: 'SERVER_ERROR', message: 'Internal server error', requestId },
  })
}

// FIX 6 — Safe parse of stored Redis values. Returns the parsed object on
// success, or `null` if the value was missing OR malformed JSON. Caller
// distinguishes by checking for null and returning the appropriate 404 /
// 500 response. Keeps inner try/catch boilerplate out of every handler.
function parseRedisJson(raw) {
  if (raw == null) return null
  if (typeof raw !== 'string') return raw   // Upstash returns objects directly sometimes
  try { return JSON.parse(raw) } catch { return null }
}

// ── Auth helper — validates API key against Redis key store ─────────────────
async function authenticate(req) {
  const auth = req.headers['authorization'] || ''
  const key  = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!key) return { ok: false, status: 401, error: { code: 'MISSING_KEY', message: 'Authorization header required' } }
  try {
    const redis = getRedis()
    const raw = await redis.get(`apikey:${key}`)
    if (!raw) return { ok: false, status: 401, error: { code: 'INVALID_KEY', message: 'API key not found' } }
    let keyData
    try { keyData = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return { ok: false, status: 500, error: { code: 'CORRUPT_KEY_DATA', message: 'Key data is corrupt' } } }
    if (!keyData.insights) return {
      ok: false, status: 403,
      error: { code: 'INSIGHTS_ACCESS_REQUIRED', message: 'This key does not have Insights access. See ebenova.dev/insights' }
    }
    // FIX 4 — sliding TTL renewal. Active users keep their records;
    // inactive users (no auth in 365 days) get their records expired.
    redis.expire(`apikey:${key}`, ONE_YEAR_SECONDS).catch(() => {})
    return { ok: true, owner: keyData.owner, keyData }
  } catch (err) {
    const requestId = makeRequestId()
    console.error(`[api] Internal error ${requestId} [auth]:`, err)
    return { ok: false, status: 500, error: { code: 'AUTH_ERROR', message: 'Internal server error', requestId } }
  }
}

const PLAN_LIMITS = {
  starter: { monitors: 1,   keywords: 10  },
  growth:  { monitors: 20,  keywords: 100 },
  scale:   { monitors: 100, keywords: 500 },
}

// Slugify a monitor name into a UTM campaign default. Lowercase, alphanum +
// hyphens, capped at 40 chars. Empty input → ''.
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

// Validate an optional product URL. Empty/null is OK (returns null). String
// must parse as an http(s) URL or we reject. Used by POST/PATCH /v1/monitors
// for the productUrl field that drives UTM injection in drafts.
function validateProductUrl(input) {
  if (input == null || input === '') return { ok: true, value: null }
  if (typeof input !== 'string') return { ok: false, error: '`productUrl` must be a string' }
  let u
  try { u = new URL(input.trim()) } catch (_) { return { ok: false, error: '`productUrl` is not a valid URL' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: '`productUrl` must be http:// or https://' }
  }
  return { ok: true, value: u.toString() }
}

// Validate an optional outbound webhook URL. Empty/null is OK (returns null).
// Must parse as https:// — http:// is rejected to avoid sending payloads with
// match content over plaintext. Used by POST/PATCH /v1/monitors and the test
// endpoint.
function validateWebhookUrl(input) {
  if (input == null || input === '') return { ok: true, value: null }
  if (typeof input !== 'string') return { ok: false, error: '`webhookUrl` must be a string' }
  let u
  try { u = new URL(input.trim()) } catch (_) { return { ok: false, error: '`webhookUrl` is not a valid URL' } }
  if (u.protocol !== 'https:') return { ok: false, error: '`webhookUrl` must be https://' }
  return { ok: true, value: u.toString() }
}

// ── App ────────────────────────────────────────────────────────────────────
const app = express()

// F1: Stripe webhook MUST be mounted before express.json() so the raw request
// body (Buffer) reaches stripe.webhooks.constructEvent for signature
// verification. If express.json() runs first, it consumes the body and the
// SDK throws "No webhook payload was provided." All other routes use JSON.
app.post('/v1/billing/webhook',
  express.raw({ type: 'application/json' }),
  webhookHandler
)

// Security headers — X-Content-Type-Options, X-Frame-Options, HSTS,
// Referrer-Policy, basic CSP. Loosened CSP to allow the dashboard's React,
// Tailwind, and Phosphor icon CDN scripts (a future change will bundle these).
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://unpkg.com", "'unsafe-eval'", "https://js.hcaptcha.com"],
      'connect-src': ["'self'", "https://hooks.slack.com", "https://hcaptcha.com", "https://*.hcaptcha.com"],
      'img-src': ["'self'", 'data:', "https://imgs.hcaptcha.com"],
      'frame-src': ["'self'", "https://hcaptcha.com", "https://*.hcaptcha.com"],
      'style-src': ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      'font-src': ["'self'", 'https:', 'data:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}))

// FIX 9 — body-size limit + strict JSON. 64kb is well above any legitimate
// monitor-creation payload (productContext capped at 2000 chars, keywords
// capped per-plan). Anything bigger is either a malformed client or an
// abuse attempt.
app.use(express.json({ limit: '64kb', strict: true }))
// FIX 9 — JSON parse error handler. Without this, a malformed body bubbles
// up to the global handler and returns a 500 with the parser's raw error
// message ("Unexpected token … in JSON at position …"). Catch the parser
// error class specifically and return a clean 400.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    const code = err.type === 'entity.too.large' ? 'BODY_TOO_LARGE' : 'INVALID_JSON'
    const message = err.type === 'entity.too.large'
      ? 'Request body too large (max 64kb)'
      : 'Invalid JSON body'
    return res.status(err.status || 400).json({ success: false, error: { code, message } })
  }
  next(err)
})
app.use(express.static(join(__dirname, 'public')))
app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')))
app.get('/dashboard', (req, res) => res.sendFile(join(__dirname, 'public', 'dashboard.html')))

// CORS allowlist. Set ALLOWED_ORIGINS env to override the default list.
// FIX 10 — default list (in lib/cors-config.js) now includes ebenova.org +
// www.ebenova.org (production primary domain). Extracted to a separate
// module so production-hardening tests can pin the default without
// spinning up Express.
import { resolveAllowedOrigins } from './lib/cors-config.js'
const ALLOWED_ORIGINS = resolveAllowedOrigins(process.env.ALLOWED_ORIGINS)
app.use(makeCorsMiddleware(ALLOWED_ORIGINS))

// ── Stripe billing (checkout + portal) ─────────────────────────────────────
// Note: /v1/billing/webhook is mounted above, before express.json().
// stripeRoutes (the router) only contains /checkout and /portal now.
app.use('/v1/billing', stripeRoutes)

// Find Customers endpoints — lazy-mounted so missing Redis env doesn't crash boot.
let _findRouter
app.use('/v1/find', (req, res, next) => {
  if (!_findRouter) {
    try { _findRouter = createFindRouter({ redis: getRedis() }) }
    catch (err) { console.error('[api] route mount NOT_CONFIGURED:', err.message); return res.status(503).json({ success: false, error: { code: 'NOT_CONFIGURED', message: 'Service temporarily unavailable' } }) }
  }
  _findRouter(req, res, next)
})

// Feedback endpoint — same lazy-mount pattern.
let _feedbackRouter
app.use('/v1/feedback', (req, res, next) => {
  if (!_feedbackRouter) {
    try { _feedbackRouter = createFeedbackRouter({ redis: getRedis() }) }
    catch (err) { console.error('[api] route mount NOT_CONFIGURED:', err.message); return res.status(503).json({ success: false, error: { code: 'NOT_CONFIGURED', message: 'Service temporarily unavailable' } }) }
  }
  _feedbackRouter(req, res, next)
})

// ── GET /v1/presets, GET /v1/presets/:id ───────────────────────────────────
// Vertical-keyword preset library (PR #33). Public — no auth required —
// because the dashboard hits these on the unauthenticated landing flow,
// and the data is non-sensitive curated content (the same library would
// be hardcoded into a docs page).
//
// /v1/presets       returns the list shape (no subreddits) for the picker.
// /v1/presets/:id   returns the full preset including subreddits (the
//                    worker hint that's redundant in the picker UI).
app.get('/v1/presets', (req, res) => {
  const presets = listPresets()
  res.json({ success: true, presets, count: presets.length })
})

app.get('/v1/presets/:id', (req, res) => {
  const preset = getPreset(req.params.id)
  if (!preset) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Preset not found' } })
  }
  res.json({ success: true, preset })
})

// ── GET /v1/corridors, GET /v1/corridors/:id ───────────────────────────────
// Diaspora corridor library (PR #36). Public — no auth — same rationale as
// /v1/presets: the dashboard's create-monitor flow hits these on the
// unauthenticated landing path, the data is non-sensitive curated content,
// and the subreddits worker-hint is omitted from the list endpoint.
app.get('/v1/corridors', (req, res) => {
  const corridors = listCorridors()
  res.json({ success: true, corridors, count: corridors.length })
})

app.get('/v1/corridors/:id', (req, res) => {
  const corridor = getCorridor(req.params.id)
  if (!corridor) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Corridor not found' } })
  }
  res.json({ success: true, corridor })
})

// ── GET /health ────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  let redisOk = false
  try { const r = getRedis(); await r.ping(); redisOk = true } catch (err) { console.error('[health] Redis ping failed:', err.message) }
  res.json({
    status: 'ok',
    service: 'ebenova-insights-api',
    version: '2.0.0',
    redis: redisOk ? 'connected' : 'unavailable',
    uptime: Math.floor(process.uptime()),
    ts: new Date().toISOString(),
  })
})

// ── GET /v1/me ─────────────────────────────────────────────────────────────
app.get('/v1/me', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  res.json({
    success: true,
    email: auth.owner,
    plan: auth.keyData.insightsPlan || 'starter',
    name: auth.keyData.name || '',
  })
})

// ── GET /v1/monitors ───────────────────────────────────────────────────────
app.get('/v1/monitors', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  try {
    const redis = getRedis()
    const ids = await redis.smembers(`insights:monitors:${auth.owner}`) || []
    const monitors = []
    for (const id of ids) {
      const raw = await redis.get(`insights:monitor:${id}`)
      if (raw) {
        const m = typeof raw === 'string' ? JSON.parse(raw) : raw
        monitors.push({
          id: m.id, name: m.name, active: m.active,
          keyword_count: m.keywords?.length || 0,
          keywords: m.keywords?.map(k => k.keyword) || [],
          alert_email: m.alertEmail,
          plan: m.plan,
          last_poll_at: m.lastPollAt,
          total_matches_found: m.totalMatchesFound || 0,
          created_at: m.createdAt,
          // Email opt-out state. Existing monitors without the field default
          // to true (backward-compatible: old monitors keep getting emails).
          email_enabled: m.emailEnabled !== false,
          // Surfaced so the dashboard can wire the "Delete account" button
          // (token is the public auth for the /delete-account flow).
          unsubscribe_token: m.unsubscribeToken || null,
          // Platforms list — derived from monitor.platforms when present, or
          // migrated from legacy includeXxx flags otherwise. Always returned
          // so the dashboard can render the right chip-selection state.
          platforms: migrateLegacyPlatforms(m),
          // UTM tracking config (PR #22). Null until the user fills it in.
          product_url:  m.productUrl  || null,
          utm_source:   m.utmSource   || null,
          utm_medium:   m.utmMedium   || null,
          utm_campaign: m.utmCampaign || null,
          // Outbound webhook (PR #23). Null until owner configures one.
          webhook_url:  m.webhookUrl  || null,
          // PR #31: Builder Tracker mode. Default 'keyword' for legacy monitors.
          mode:                 m.mode               || 'keyword',
          min_consistency:      m.minConsistency     || 'all',
          total_builders_found: m.totalBuildersFound || 0,
          // PR #34: AI visibility brand name. Empty for legacy monitors —
          // resolveBrandName falls back to first keyword at run time.
          brand_name:           m.brandName          || '',
          // PR #36 — diaspora corridor (paired-geography monitor blueprint).
          // Null on legacy monitors; the worker treats null as "use the
          // monitor's own keywords + platforms" (the existing behavior).
          diaspora_corridor:    m.diasporaCorridor   || null,
        })
      }
    }
    res.json({ success: true, monitors, count: monitors.length })
  } catch (err) {
    serverError(res, err)
  }
})

// ── POST /v1/monitors ──────────────────────────────────────────────────────
app.post('/v1/monitors', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { name, keywords = [], productContext, alertEmail, slackWebhookUrl, replyTone,
    platforms,
    productUrl, utmSource, utmMedium, utmCampaign, webhookUrl,
    mode, minConsistency,
    brandName,
    diasporaCorridor,
    includeMedium, includeSubstack, includeQuora, includeUpworkForum, includeFiverrForum } = req.body

  // PR #36 — diaspora corridor (optional). When set, the worker overrides
  // keywords + platforms + Reddit subreddits with the corridor blueprint.
  // Validate up-front so an invalid id returns 400 instead of silently
  // falling back to the monitor's own (probably empty) defaults.
  let resolvedCorridor = null
  if (diasporaCorridor != null && diasporaCorridor !== '') {
    if (!isValidCorridorId(diasporaCorridor)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_CORRIDOR', message: '`diasporaCorridor` must be one of the ids returned by GET /v1/corridors' } })
    }
    resolvedCorridor = diasporaCorridor
  }

  // PR #31: monitor mode. 'keyword' (default) or 'builder_tracker'. Unknown
  // values fall back to 'keyword' so a typo doesn't accidentally lock a
  // monitor into a different processing path.
  const VALID_MODES = new Set(['keyword', 'builder_tracker'])
  const resolvedMode = VALID_MODES.has(mode) ? mode : 'keyword'
  const VALID_MIN_CONSISTENCY = new Set(['all', 'weekly', 'daily'])
  const resolvedMinConsistency = VALID_MIN_CONSISTENCY.has(minConsistency) ? minConsistency : 'all'

  // Platforms — new monitors must specify at least 1; if omitted entirely we
  // default to ['reddit'] (per spec). Unknown values reject with 400.
  let resolvedPlatforms
  if (platforms === undefined || platforms === null) {
    resolvedPlatforms = ['reddit']
  } else {
    const v = validatePlatforms(platforms)
    if (!v.ok) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PLATFORMS', message: v.error } })
    }
    resolvedPlatforms = v.platforms
  }
  const plan = auth.keyData.insightsPlan || 'starter'
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.starter
  if (!name?.trim()) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELD', message: '"name" is required' } })
  // PR #31: Builder Tracker mode uses a hardcoded keyword set in monitor-v2,
  // so user-supplied keywords are optional/ignored for that mode.
  if (resolvedMode !== 'builder_tracker') {
    if (!Array.isArray(keywords) || keywords.length === 0)
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELD', message: '"keywords" must be a non-empty array' } })
    if (keywords.length > limits.keywords)
      return res.status(400).json({ success: false, error: { code: 'KEYWORD_LIMIT_EXCEEDED', message: `Max ${limits.keywords} keywords on ${plan} plan` } })
  }
  try {
    const redis = getRedis()
    // Keyword normalization handles legacy string-format and the new
    // type-aware shape. PR #28 adds optional `type: 'keyword' | 'competitor'`
    // — defaults to 'keyword' when omitted so existing clients keep working.
    const cleanKws = normalizeKeywordList(keywords)
    const id = `mon_${randomBytes(12).toString('hex')}`

    // F13: atomic add-then-check-then-rollback to close the plan-limit race.
    // Two concurrent requests both passing the old `existing.length >= limits`
    // check could each then sadd, ending up at limits+1. The new pattern adds
    // the ID FIRST, counts the set, and rolls back if over.
    const ownerSetKey = `insights:monitors:${auth.owner}`
    const wasAdded = await redis.sadd(ownerSetKey, id)
    if (!wasAdded) return res.status(500).json({ success: false, error: { code: 'INTERNAL', message: 'monitor id collision' } })
    const ownedAfter = await redis.smembers(ownerSetKey) || []
    if (ownedAfter.length > limits.monitors) {
      await redis.srem(ownerSetKey, id)
      return res.status(429).json({ success: false, error: { code: 'MONITOR_LIMIT_REACHED', message: `Max ${limits.monitors} monitors on ${plan} plan` } })
    }

    // Reply tone — validated against the centralized preset list
    const VALID_TONES = new Set(['conversational', 'professional', 'empathetic', 'expert', 'playful'])
    const tone = VALID_TONES.has(replyTone) ? replyTone : 'conversational'

    // UTM tracking fields (PR #22). All optional. productUrl, if set, must be
    // a valid http(s) URL — invalid values are rejected with 400 rather than
    // silently ignored, so users see the typo at create time.
    const cleanProductUrl = validateProductUrl(productUrl)
    if (cleanProductUrl.ok === false) {
      await redis.srem(ownerSetKey, id)
      return res.status(400).json({ success: false, error: { code: 'INVALID_PRODUCT_URL', message: cleanProductUrl.error } })
    }
    const cleanUtmSource   = String(utmSource   ?? '').trim().slice(0, 60) || 'ebenova-insights'
    const cleanUtmMedium   = String(utmMedium   ?? '').trim().slice(0, 60) || 'community'
    const cleanUtmCampaign = String(utmCampaign ?? '').trim().slice(0, 60) || slugify(name.trim())

    // Outbound webhook URL (PR #23). Optional; must be https when present.
    const cleanWebhookUrl = validateWebhookUrl(webhookUrl)
    if (cleanWebhookUrl.ok === false) {
      await redis.srem(ownerSetKey, id)
      return res.status(400).json({ success: false, error: { code: 'INVALID_WEBHOOK_URL', message: cleanWebhookUrl.error } })
    }

    // Unsubscribe token — issued at creation, used by the public /unsubscribe
    // and /delete-account routes (no login required for either).
    const unsubscribeToken = generateUnsubscribeToken()

    // Share token (PR #27) — gates the public white-label report at /report?token=…
    // Same length / hex shape as the unsubscribe token. Stored separately so
    // that revoking one doesn't kill the other.
    const shareToken = randomBytes(24).toString('hex')

    const now = new Date().toISOString()
    const monitor = { id, owner: auth.owner, name: name.trim().slice(0, 100), keywords: cleanKws,
      productContext: (productContext || '').slice(0, 2000), alertEmail: alertEmail || auth.owner,
      slackWebhookUrl: (slackWebhookUrl || '').slice(0, 500),
      webhookUrl:         cleanWebhookUrl.value,
      replyTone:          tone,
      productUrl:         cleanProductUrl.value,
      utmSource:          cleanUtmSource,
      utmMedium:          cleanUtmMedium,
      utmCampaign:        cleanUtmCampaign,
      // Platforms — array of platform keys this monitor should scan.
      // Replaces the old includeXxx boolean flags. The legacy fields are
      // still written for one release so old workers keep functioning
      // during the rollout. Drop the legacy block in a follow-up.
      platforms:          resolvedPlatforms,
      includeMedium:      resolvedPlatforms.includes('medium'),
      includeSubstack:    resolvedPlatforms.includes('substack'),
      includeQuora:       resolvedPlatforms.includes('quora'),
      includeUpworkForum: resolvedPlatforms.includes('upwork'),
      includeFiverrForum: resolvedPlatforms.includes('fiverr'),
      // Email opt-out + delete-account flow (per PR #13)
      emailEnabled:       true,
      unsubscribeToken,
      shareToken,
      // PR #31: Builder Tracker mode + minimum consistency display filter.
      mode:               resolvedMode,
      minConsistency:     resolvedMinConsistency,
      totalBuildersFound: 0,
      // PR #34: AI visibility brand name. Optional; resolveBrandName falls
      // back to the first keyword when this is empty. Trim + cap to keep
      // prompt sizes bounded.
      brandName:          (brandName || '').toString().trim().slice(0, 80),
      diasporaCorridor:   resolvedCorridor,
      active: true, plan, createdAt: now, lastPollAt: null, totalMatchesFound: 0 }
    await redis.set(`insights:monitor:${id}`, JSON.stringify(monitor))
    await redis.expire(`insights:monitor:${id}`, ONE_YEAR_SECONDS).catch(() => {})
    await redis.set(`unsubscribe:${unsubscribeToken}`, id)
    await redis.expire(`unsubscribe:${unsubscribeToken}`, ONE_YEAR_SECONDS).catch(() => {})
    await redis.set(`report:token:${shareToken}`, id)
    await redis.expire(`report:token:${shareToken}`, ONE_YEAR_SECONDS).catch(() => {})
    await redis.sadd('insights:active_monitors', id)
    res.status(201).json({ success: true, monitor_id: id, name: monitor.name, keyword_count: cleanKws.length,
      keywords: cleanKws.map(k => k.keyword), plan, alert_email: monitor.alertEmail, active: true,
      email_enabled: true,
      platforms: resolvedPlatforms,
      product_url:   monitor.productUrl,
      utm_source:    monitor.utmSource,
      utm_medium:    monitor.utmMedium,
      utm_campaign:  monitor.utmCampaign,
      webhook_url:   monitor.webhookUrl,
      share_token:   shareToken,
      mode:            monitor.mode,
      min_consistency: monitor.minConsistency,
      brand_name:        monitor.brandName,
      diaspora_corridor: monitor.diasporaCorridor,
      created_at: now, next_poll_eta: 'Within 15 minutes' })
  } catch (err) {
    serverError(res, err)
  }
})

// ── PATCH /v1/monitors/:id ─────────────────────────────────────────────────
// Whitelisted per-monitor field updates. Today supports `platforms` (full
// re-set, validated) and `emailEnabled` (boolean opt-out toggle). Both are
// optional in any single request — update only what's present in the body.
// Reject 400 if neither is present.
//
// Owners cannot patch plan/owner/active/createdAt/etc. — only the
// fields explicitly handled below.
app.patch('/v1/monitors/:id', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { id } = req.params
  try {
    const redis = getRedis()
    const raw = await redis.get(`insights:monitor:${id}`)
    if (!raw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (m.owner !== auth.owner) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not your monitor' } })

    // Build the updates object from whatever fields the body contains.
    // Each field is independent: caller can patch one or both.
    const body = req.body || {}
    const updates = {}

    // Field 1: platforms — validated against lib/platforms.js whitelist.
    if (Object.prototype.hasOwnProperty.call(body, 'platforms')) {
      const v = validatePlatforms(body.platforms)
      if (!v.ok) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_PLATFORMS', message: v.error } })
      }
      updates.platforms = v.platforms
      // Mirror to legacy includeXxx flags so any pre-platforms-PR workers
      // still in flight continue to behave correctly during rollout.
      updates.includeMedium      = v.platforms.includes('medium')
      updates.includeSubstack    = v.platforms.includes('substack')
      updates.includeQuora       = v.platforms.includes('quora')
      updates.includeUpworkForum = v.platforms.includes('upwork')
      updates.includeFiverrForum = v.platforms.includes('fiverr')
    }

    // Field 2: emailEnabled — boolean opt-out toggle (PR #13 unsubscribe flow).
    if (Object.prototype.hasOwnProperty.call(body, 'emailEnabled')) {
      if (typeof body.emailEnabled !== 'boolean') {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '`emailEnabled` must be a boolean' } })
      }
      updates.emailEnabled = body.emailEnabled
    }

    // Field 3: productUrl — http(s) URL or null (PR #22 UTM injection).
    if (Object.prototype.hasOwnProperty.call(body, 'productUrl')) {
      const v = validateProductUrl(body.productUrl)
      if (!v.ok) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_PRODUCT_URL', message: v.error } })
      }
      updates.productUrl = v.value
    }

    // Fields 4-6: utmSource / utmMedium / utmCampaign — plain strings, capped 60 chars.
    for (const fld of ['utmSource', 'utmMedium', 'utmCampaign']) {
      if (Object.prototype.hasOwnProperty.call(body, fld)) {
        const raw = body[fld]
        if (raw == null) {
          updates[fld] = null
        } else if (typeof raw !== 'string') {
          return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: `\`${fld}\` must be a string or null` } })
        } else {
          updates[fld] = raw.trim().slice(0, 60) || null
        }
      }
    }

    // Field 7: webhookUrl — https URL or null (PR #23).
    if (Object.prototype.hasOwnProperty.call(body, 'webhookUrl')) {
      const v = validateWebhookUrl(body.webhookUrl)
      if (!v.ok) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_WEBHOOK_URL', message: v.error } })
      }
      updates.webhookUrl = v.value
    }

    // Fields 8-9: PR #31 — mode + minConsistency.
    if (Object.prototype.hasOwnProperty.call(body, 'mode')) {
      const VALID_MODES = new Set(['keyword', 'builder_tracker'])
      if (!VALID_MODES.has(body.mode)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_MODE', message: '`mode` must be "keyword" or "builder_tracker"' } })
      }
      updates.mode = body.mode
    }
    if (Object.prototype.hasOwnProperty.call(body, 'minConsistency')) {
      const VALID = new Set(['all', 'weekly', 'daily'])
      if (!VALID.has(body.minConsistency)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_MIN_CONSISTENCY', message: '`minConsistency` must be "all", "weekly", or "daily"' } })
      }
      updates.minConsistency = body.minConsistency
    }

    // Field 10: PR #34 — AI visibility brand name (optional, plain string).
    // Empty string is a legitimate value (clears the field; we then fall
    // back to first-keyword at run time).
    if (Object.prototype.hasOwnProperty.call(body, 'brandName')) {
      if (body.brandName !== null && typeof body.brandName !== 'string') {
        return res.status(400).json({ success: false, error: { code: 'INVALID_BRAND_NAME', message: '`brandName` must be a string or null' } })
      }
      updates.brandName = (body.brandName || '').toString().trim().slice(0, 80)
    }

    // Field 11: PR #36 — diaspora corridor. null/'' clears it (worker falls
    // back to the monitor's own keywords + platforms); a valid id swaps the
    // monitor onto the corridor's blueprint at next poll.
    if (Object.prototype.hasOwnProperty.call(body, 'diasporaCorridor')) {
      if (body.diasporaCorridor === null || body.diasporaCorridor === '') {
        updates.diasporaCorridor = null
      } else if (typeof body.diasporaCorridor === 'string' && isValidCorridorId(body.diasporaCorridor)) {
        updates.diasporaCorridor = body.diasporaCorridor
      } else {
        return res.status(400).json({ success: false, error: { code: 'INVALID_CORRIDOR', message: '`diasporaCorridor` must be a valid corridor id or null' } })
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: { code: 'NO_UPDATES', message: 'No supported fields in body. Patchable: platforms, emailEnabled, productUrl, utmSource, utmMedium, utmCampaign, webhookUrl, mode, minConsistency, brandName, diasporaCorridor' } })
    }
    const next = { ...m, ...updates }
    await redis.set(`insights:monitor:${id}`, JSON.stringify(next))
    await redis.expire(`insights:monitor:${id}`, ONE_YEAR_SECONDS).catch(() => {})
    // Echo back exactly what the caller patched, plus any always-included
    // mirrored fields (platforms[] is the canonical view).
    const echo = { success: true, monitor_id: id }
    if (updates.platforms     !== undefined) echo.platforms     = next.platforms
    if (updates.emailEnabled  !== undefined) echo.email_enabled = next.emailEnabled
    if (updates.productUrl    !== undefined) echo.product_url   = next.productUrl
    if (updates.utmSource     !== undefined) echo.utm_source    = next.utmSource
    if (updates.utmMedium     !== undefined) echo.utm_medium    = next.utmMedium
    if (updates.utmCampaign   !== undefined) echo.utm_campaign  = next.utmCampaign
    if (updates.webhookUrl    !== undefined) echo.webhook_url   = next.webhookUrl
    if (updates.brandName        !== undefined) echo.brand_name        = next.brandName
    if (updates.diasporaCorridor !== undefined) echo.diaspora_corridor = next.diasporaCorridor
    res.json(echo)
  } catch (err) {
    serverError(res, err)
  }
})

// ── GET /v1/monitors/:id/share-link ────────────────────────────────────────
// Auth-gated. Returns the public, no-login share URL for the monitor's
// white-label client report. Backfills the shareToken if a legacy monitor
// (created before PR #27) doesn't have one yet — saves the operator a trip
// to recreate the monitor just to get a token.
app.get('/v1/monitors/:id/share-link', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { id } = req.params
  try {
    const redis = getRedis()
    const raw = await redis.get(`insights:monitor:${id}`)
    if (!raw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (m.owner !== auth.owner) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })

    // Backfill for legacy monitors
    let token = m.shareToken
    if (!token) {
      token = randomBytes(24).toString('hex')
      const next = { ...m, shareToken: token }
      await redis.set(`insights:monitor:${id}`, JSON.stringify(next))
      await redis.set(`report:token:${token}`, id)
    }

    const baseUrl = process.env.APP_URL || 'https://ebenova.org'
    const reportUrl = `${baseUrl.replace(/\/+$/, '')}/report?token=${encodeURIComponent(token)}`
    res.json({ success: true, monitor_id: id, reportUrl })
  } catch (err) {
    serverError(res, err)
  }
})

// ── GET /report?token=… (public) ───────────────────────────────────────────
// White-label client report. Token-gated, no API key required. Renders 30
// days of match data, sentiment / intent / platform breakdowns, top 5 matches,
// author highlights, and weekly trend. Branded as the monitor's own name —
// "Powered by Ebenova" appears only in the footer.
//
// Failure modes return user-readable HTML pages, not JSON, since this is a
// public route a marketer might link to from a slide deck or email.
async function reportHandler(req, res) {
  res.set('Content-Type', 'text/html; charset=utf-8')
  const token = req.query?.token
  try {
    const redis = getRedis()
    const monitor = await resolveReportToken(redis, token)
    if (!monitor) {
      return res.status(404).send(htmlPage({
        title: 'Report not found',
        accent: '#DC2626',
        body: `<h1>This report link is no longer valid</h1>
          <p>The link may have expired, been revoked, or the monitor it pointed to has been deleted.</p>
          <p>If you received this from someone, ask them to send a fresh link from their dashboard.</p>`,
      }))
    }
    const stats = await gatherReportData(monitor, redis, 30)
    const summary = await buildExecutiveSummary({ monitor, stats })
    const html = renderReportHtml({ monitor, stats, summary })
    res.send(html)
  } catch (err) {
    console.error('[report] error:', err.message)
    res.status(500).send(htmlPage({
      title: 'Report unavailable',
      accent: '#DC2626',
      body: `<h1>Report temporarily unavailable</h1><p>Something went wrong rendering this page. Try again in a moment.</p>`,
    }))
  }
}
app.get('/report', reportHandler)

// ── POST /v1/monitors/:id/test-webhook ─────────────────────────────────────
// Fires a sample `event:'test'` payload at the monitor's configured webhookUrl
// synchronously so the dashboard's "Test webhook" button can show success or
// failure inline. Auth-gated, ownership-checked. Returns 502 with structured
// detail on delivery failure (so the UI can show e.g. "non-2xx (status 500)").
app.post('/v1/monitors/:id/test-webhook', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { id } = req.params
  try {
    const redis = getRedis()
    const raw = await redis.get(`insights:monitor:${id}`)
    if (!raw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw
    // Match feedback's pattern: 404 (not 403) on owner mismatch to avoid
    // existence-leak.
    if (m.owner !== auth.owner) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    if (!m.webhookUrl) return res.status(400).json({ success: false, error: { code: 'NO_WEBHOOK', message: 'Monitor has no webhookUrl set' } })

    const samplePayload = buildWebhookPayload({
      event: 'test',
      monitorId: m.id,
      match: {
        id: 'sample_match_1',
        title: 'Sample test match — Ebenova Insights webhook',
        url: 'https://example.com/sample',
        subreddit: 'test',
        author: 'sample_user',
        score: 42,
        comments: 5,
        body: 'This is a test payload from the Ebenova Insights "Test webhook" button. Real matches will look like this.',
        createdAt: new Date().toISOString(),
        keyword: 'sample',
        source: 'reddit',
        sentiment: 'neutral',
        intent: 'researching',
        intentConfidence: 0.92,
        draft: null,
        approved: true,
      },
    })

    const r = await sendOutboundWebhook(m.webhookUrl, samplePayload)
    if (r.delivered) return res.json({ success: true, status: r.status })
    return res.status(502).json({
      success: false,
      error: { code: 'WEBHOOK_FAILED', message: r.reason, status: r.status, networkError: r.error },
    })
  } catch (err) {
    serverError(res, err)
  }
})

// ── POST /v1/monitors/:id/poll-now ─────────────────────────────────────────
// FIX 11 — allow a user to trigger an immediate scan of their monitor
// instead of waiting up to POLL_INTERVAL_MINUTES (default 15) for the
// next cron tick. Especially valuable for new monitors — the empty-state
// "first matches usually arrive within 15 minutes" message is friendlier
// when the user can opt to skip the wait.
//
// Implementation: set a Redis flag `poll-now:{monitorId}` with a 5-min TTL.
// monitor-v2.js's poll loop reads these flags at the top of every cycle
// and runs flagged monitors first. Rate-limited to 1/hour per monitor via
// a separate `poll-now:lock:{monitorId}` key with 60-min TTL.
app.post('/v1/monitors/:id/poll-now', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { id } = req.params
  try {
    const redis = getRedis()
    // Ownership check first — same 404-not-403 leak-prevention pattern.
    const raw = await redis.get(`insights:monitor:${id}`)
    if (!raw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (m.owner !== auth.owner) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })

    // Rate-limit: 1 poll-now per monitor per hour. Use SET NX so the check
    // and the set are atomic — no race between two simultaneous clicks.
    const lockKey = `poll-now:lock:${id}`
    const lockSet = await redis.set(lockKey, '1', { nx: true, ex: 60 * 60 })
    if (!lockSet) {
      return res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Poll-now is limited to once per hour per monitor.' },
      })
    }

    // Set the flag the worker checks at the top of every cycle. 5min TTL
    // is long enough for the worker to pick it up on the next tick and
    // short enough that a stale flag from a missed cycle doesn't replay
    // forever.
    await redis.set(`poll-now:${id}`, '1', { ex: 300 })

    res.json({
      success: true,
      monitor_id: id,
      message: 'Scan queued — your monitor will run within the next 60 seconds.',
    })
  } catch (err) {
    serverError(res, err)
  }
})

// ── DELETE /v1/monitors/:id ────────────────────────────────────────────────
app.delete('/v1/monitors/:id', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { id } = req.params
  try {
    const redis = getRedis()
    const raw = await redis.get(`insights:monitor:${id}`)
    if (!raw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (m.owner !== auth.owner) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not your monitor' } })
    await redis.set(`insights:monitor:${id}`, JSON.stringify({ ...m, active: false }))
    await redis.srem('insights:active_monitors', id)
    res.json({ success: true, monitor_id: id, active: false })
  } catch (err) {
    serverError(res, err)
  }
})

// ── GET /v1/matches ────────────────────────────────────────────────────────
app.get('/v1/matches', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { monitor_id, limit = '20', offset = '0' } = req.query
  if (!monitor_id) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'monitor_id is required' } })
  try {
    const redis = getRedis()
    const raw = await redis.get(`insights:monitor:${monitor_id}`)
    if (!raw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (m.owner !== auth.owner) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not your monitor' } })
    const lim = Math.min(Math.max(parseInt(limit) || 20, 1), 100)
    const off = Math.max(parseInt(offset) || 0, 0)
    const ids = await redis.lrange(`insights:matches:${monitor_id}`, off, off + lim - 1) || []
    const matches = []
    for (const matchId of ids) {
      const mr = await redis.get(`insights:match:${monitor_id}:${matchId}`)
      if (mr) matches.push(typeof mr === 'string' ? JSON.parse(mr) : mr)
    }
    // Priority sort — intent first (asking_for_tool > buying > researching >
    // ...), then source rank (Reddit first), then recency. Mirrors the same
    // sort applied in monitor-v2.js runMonitor() so the dashboard order
    // matches what testers see in their alert emails.
    const SOURCE_RANK = { reddit: 0, hackernews: 1, quora: 2, medium: 3, substack: 4, upwork: 5, fiverr: 6 }
    matches.sort((a, b) => {
      const ia = intentPriority(a.intent)
      const ib = intentPriority(b.intent)
      if (ia !== ib) return ia - ib
      const ra = SOURCE_RANK[a.source] ?? 99
      const rb = SOURCE_RANK[b.source] ?? 99
      if (ra !== rb) return ra - rb
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    })
    res.json({ success: true, monitor_id, matches, count: matches.length, offset: off, limit: lim })
  } catch (err) {
    serverError(res, err)
  }
})

// ── GET /v1/monitors/:id/export.csv ────────────────────────────────────────
// Streams the last 30 days of matches for a single monitor as a CSV
// attachment. Auth-gated, ownership-checked. Empty CSV (header row only)
// is a valid response when the monitor has no recent matches — caller can
// distinguish from "monitor not found" via the 200 vs 404.
//
// Field set is locked-in via lib/csv-export.js MATCH_EXPORT_COLUMNS so
// downstream pipelines (Builder Tracker export, customer reports) get a
// predictable schema. RFC 4180 escaping for fields with commas / quotes /
// newlines (drafts often contain commas; titles occasionally have quotes).
app.get('/v1/monitors/:id/export.csv', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { id } = req.params
  try {
    const redis = getRedis()
    const monRaw = await redis.get(`insights:monitor:${id}`)
    if (!monRaw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const monitor = typeof monRaw === 'string' ? JSON.parse(monRaw) : monRaw
    if (monitor.owner !== auth.owner) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })

    // Pull the last 500 match IDs (existing list size — match TTL caps at 7d
    // anyway, so 30-day-window is naturally bounded by storage retention).
    const ids = await redis.lrange(`insights:matches:${id}`, 0, 499) || []
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    const rows = []
    for (const matchId of ids) {
      const mr = await redis.get(`insights:match:${id}:${matchId}`)
      if (!mr) continue
      const m = typeof mr === 'string' ? JSON.parse(mr) : mr
      const ts = new Date(m.createdAt || m.storedAt || 0).getTime()
      if (!Number.isFinite(ts) || ts < cutoff) continue
      rows.push(matchToExportRow(m))
    }
    // Sort newest first so the export reads top-down chronologically.
    rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))

    const csv = toCsv(MATCH_EXPORT_COLUMNS, rows)
    const dateStr = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="monitor-${id}-${dateStr}.csv"`)
    res.send(csv)
  } catch (err) {
    serverError(res, err)
  }
})

// ── GET /v1/monitors/:id/builders ──────────────────────────────────────────
// Builder Tracker (PR #31) read endpoint. Returns all profiles tracked for
// the monitor, sorted by postCount desc. Auth-gated, ownership-checked.
// Returns an empty list (not 404) for monitors that haven't recorded any
// builders yet — distinguishes "monitor exists, no data" from "no monitor".
app.get('/v1/monitors/:id/builders', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { id } = req.params
  try {
    const redis = getRedis()
    const monRaw = await redis.get(`insights:monitor:${id}`)
    if (!monRaw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const monitor = typeof monRaw === 'string' ? JSON.parse(monRaw) : monRaw
    if (monitor.owner !== auth.owner) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })

    const builders = await getBuilderProfiles({ redis, monitorId: id, limit: 200 })
    res.json({ success: true, builders, total: builders.length })
  } catch (err) {
    serverError(res, err)
  }
})

// ── GET /v1/monitors/:id/builders.csv ──────────────────────────────────────
// CSV export of tracked builder profiles. Same shape as the JSON endpoint
// above, RFC 4180 escaped (manual — no library), CRLF line endings, header-
// only on empty. The CSV's headline value to Steven Musielski's $50/mo
// engagement: load it into a spreadsheet, sort by consistency, decide who
// to reach out to.
app.get('/v1/monitors/:id/builders.csv', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { id } = req.params
  try {
    const redis = getRedis()
    const monRaw = await redis.get(`insights:monitor:${id}`)
    if (!monRaw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const monitor = typeof monRaw === 'string' ? JSON.parse(monRaw) : monRaw
    if (monitor.owner !== auth.owner) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })

    const builders = await getBuilderProfiles({ redis, monitorId: id, limit: 500 })
    const csv = buildersToCSV(builders)
    const dateStr = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="builders-${id}-${dateStr}.csv"`)
    res.send(csv)
  } catch (err) {
    serverError(res, err)
  }
})

// ── GET /v1/monitors/:id/outcomes ──────────────────────────────────────────
// Reply outcome tracking — the ROI-proof endpoint. Reads the last 30 days of
// posted matches for the monitor and surfaces:
//   - totalPosted    — replies the user marked as posted
//   - gotEngagement  — replies that picked up commentsDelta > 0 OR scoreDelta > 2
//   - engagementRate — formatted percentage string
//   - topPerforming  — top 3 by commentsDelta (desc)
//   - recentOutcomes — last 10 posted matches with their delta record
//
// Auth-gated, ownership-checked, returns 200 with zeroed fields when there
// are no posted replies (so the dashboard can render an "encouraging-empty"
// state instead of treating it as a 404).
app.get('/v1/monitors/:id/outcomes', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { id } = req.params
  try {
    const redis = getRedis()
    const monRaw = await redis.get(`insights:monitor:${id}`)
    if (!monRaw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const monitor = typeof monRaw === 'string' ? JSON.parse(monRaw) : monRaw
    if (monitor.owner !== auth.owner) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })

    const o = await getRecentOutcomes({ redis, monitorId: id, days: 30 })
    res.json({
      success:        true,
      period:         '30d',
      totalPosted:    o.posted,
      gotEngagement:  o.engaged,
      engagementRate: o.rateLabel,
      topPerforming:  o.topPerforming,
      recentOutcomes: o.recent,
    })
  } catch (err) {
    serverError(res, err)
  }
})

// ── GET /v1/monitors/:id/ai-visibility ─────────────────────────────────────
// AI visibility report (PR #34). Returns up to the last 4 weekly reports
// for the monitor, plus the current overall score, the trend bucket vs the
// prior week, and the most-frequently-mentioned competitors across the
// returned window. Auth-gated, ownership-checked.
//
// Empty response (no reports yet, or no resolvable brand name) returns 200
// with `reports: []` and `currentScore: null` so the dashboard can show a
// "first weekly run hasn't fired yet" empty state instead of treating it as
// an error.
app.get('/v1/monitors/:id/ai-visibility', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { id } = req.params
  try {
    const redis = getRedis()
    const monRaw = await redis.get(`insights:monitor:${id}`)
    if (!monRaw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const monitor = typeof monRaw === 'string' ? JSON.parse(monRaw) : monRaw
    if (monitor.owner !== auth.owner) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })

    const reports = await getRecentReports({ redis, monitorId: id, weeks: 4 })
    const currentScore = reports.length > 0 ? reports[0].overallScore : null
    const previousScore = reports.length > 1 ? reports[1].overallScore : null
    const trend = currentScore != null
      ? computeTrend(currentScore, previousScore)
      : 'new'
    const topCompetitorsMentioned = topCompetitorsAcross(reports)
    const brandName = monitor.brandName ||
      (Array.isArray(monitor.keywords) && monitor.keywords[0]
        ? (monitor.keywords[0].keyword || monitor.keywords[0])
        : '')
    res.json({
      success: true,
      monitorId: id,
      brandName,
      reports,
      currentScore,
      trend,
      topCompetitorsMentioned,
    })
  } catch (err) {
    serverError(res, err)
  }
})

// ── GET /v1/matches/intent-summary ─────────────────────────────────────────
// 7-day breakdown of intent + sentiment across a monitor's matches. Used
// for marketer-facing rollups ("how many high-value signals this week?").
// Reads the same matches list that powers the feed; classifications come
// from the records as-stored in Redis.
app.get('/v1/matches/intent-summary', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { monitor_id } = req.query
  if (!monitor_id) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'monitor_id is required' } })
  try {
    const redis = getRedis()
    const monRaw = await redis.get(`insights:monitor:${monitor_id}`)
    if (!monRaw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const m = typeof monRaw === 'string' ? JSON.parse(monRaw) : monRaw
    if (m.owner !== auth.owner) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not your monitor' } })

    const ids = await redis.lrange(`insights:matches:${monitor_id}`, 0, 499) || []
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    const by_intent = {
      asking_for_tool: 0, buying: 0, complaining: 0, researching: 0,
      venting: 0, recommending: 0, unclassified: 0,
    }
    const by_sentiment = {
      positive: 0, negative: 0, neutral: 0, frustrated: 0, questioning: 0,
    }
    let total = 0
    for (const matchId of ids) {
      const mr = await redis.get(`insights:match:${monitor_id}:${matchId}`)
      if (!mr) continue
      const match = typeof mr === 'string' ? JSON.parse(mr) : mr
      const ts = new Date(match.createdAt || match.storedAt || 0).getTime()
      if (!Number.isFinite(ts) || ts < cutoff) continue
      total++
      if (match.intent && Object.prototype.hasOwnProperty.call(by_intent, match.intent)) {
        by_intent[match.intent]++
      } else {
        by_intent.unclassified++
      }
      if (match.sentiment && Object.prototype.hasOwnProperty.call(by_sentiment, match.sentiment)) {
        by_sentiment[match.sentiment]++
      }
    }
    const high_value_count = by_intent.asking_for_tool + by_intent.buying

    // PR #28: share-of-voice block. Reads the SoV counters this cycle's
    // monitor-v2 wrote during runMonitor. Both keys may be missing for
    // a brand-new monitor; treat missing as zero. The trend comparison
    // uses an own-share fraction (own / (own + competitor)) — if there
    // were no matches at all in either week, trend is 'stable'.
    const wkNow  = isoWeekLabel(new Date())
    const wkPrev = previousIsoWeekLabel(new Date())
    let sovBlock = null
    try {
      const [ownNow, compNow, ownPrev, compPrev] = await Promise.all([
        redis.get(`sov:${monitor_id}:${wkNow}:own`),
        redis.get(`sov:${monitor_id}:${wkNow}:competitor`),
        redis.get(`sov:${monitor_id}:${wkPrev}:own`),
        redis.get(`sov:${monitor_id}:${wkPrev}:competitor`),
      ])
      const own1  = Number(ownNow  || 0)
      const comp1 = Number(compNow || 0)
      const own2  = Number(ownPrev  || 0)
      const comp2 = Number(compPrev || 0)
      const ratio = (a, b) => {
        if (a === 0 && b === 0) return '0:0'
        const g = (function gcd(x, y) { return y === 0 ? x : gcd(y, x % y) })(a, b)
        return `${a / g}:${b / g}`
      }
      const share = (a, b) => (a + b === 0 ? null : a / (a + b))
      const sNow = share(own1, comp1)
      const sPrev = share(own2, comp2)
      let trend = 'stable'
      if (sNow != null && sPrev != null) {
        const delta = sNow - sPrev
        if (delta > 0.05)      trend = 'improving'
        else if (delta < -0.05) trend = 'declining'
      } else if (sNow != null && sPrev == null) {
        trend = 'improving'   // first week with data
      }
      sovBlock = {
        thisWeek: { own: own1, competitor: comp1, ratio: ratio(own1, comp1) },
        lastWeek: { own: own2, competitor: comp2, ratio: ratio(own2, comp2) },
        trend,
      }
    } catch (err) {
      console.warn(`[intent-summary] SoV read failed for ${monitor_id}: ${err.message}`)
    }

    res.json({
      success: true,
      monitor_id,
      period: '7d',
      summary: { total, by_intent, by_sentiment, high_value_count },
      shareOfVoice: sovBlock,
    })
  } catch (err) {
    serverError(res, err)
  }
})

// ── PATCH /v1/matches/posted ───────────────────────────────────────────────
// Toggle the "posted" state of a match. Sets `postedAt` to now (or clears it
// on undo) and bumps the per-monitor `posted_count` so the dashboard can
// surface a real engagement metric. Body: { monitor_id, match_id }.
//
// Idempotent up to "current state": calling twice in a row toggles back. The
// counter only moves on actual state transition (off→on increments, on→off
// decrements) so click-arounds don't inflate the metric.
app.patch('/v1/matches/posted', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { monitor_id, match_id } = req.body || {}
  if (!monitor_id || !match_id)
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'monitor_id and match_id required' } })
  try {
    const redis = getRedis()
    // Verify caller owns this monitor (matches /v1/matches/feedback's pattern,
    // returns 404 to avoid leaking existence).
    const monitorKey = `insights:monitor:${monitor_id}`
    const monitorRaw = await redis.get(monitorKey)
    if (!monitorRaw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const monitor = typeof monitorRaw === 'string' ? JSON.parse(monitorRaw) : monitorRaw
    if (monitor.owner !== auth.owner) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    }

    const matchKey = `insights:match:${monitor_id}:${match_id}`
    const matchRaw = await redis.get(matchKey)
    if (!matchRaw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Match not found' } })
    const match = typeof matchRaw === 'string' ? JSON.parse(matchRaw) : matchRaw

    const wasPosted = !!match.postedAt
    const now = new Date().toISOString()
    const nextMatch = wasPosted
      ? { ...match, postedAt: null }
      : { ...match, postedAt: now }
    await redis.set(matchKey, JSON.stringify(nextMatch))

    // Counter only moves on actual transition.
    const currentCount = Number(monitor.posted_count) || 0
    const nextCount = wasPosted ? Math.max(0, currentCount - 1) : currentCount + 1
    await redis.set(monitorKey, JSON.stringify({ ...monitor, posted_count: nextCount }))

    // Reply outcome tracking: on the off→on transition, schedule a
    // +24h engagement check on this monitor's pending queue. Best-effort;
    // failure to schedule never blocks the posted-state update.
    if (!wasPosted) {
      try { await scheduleEngagementCheck({ redis, monitorId: monitor_id, match: nextMatch }) }
      catch (err) { console.warn(`[posted] scheduleEngagementCheck failed for ${monitor_id}:${match_id}: ${err.message}`) }
    }

    res.json({
      success: true,
      match_id,
      posted: !wasPosted,
      postedAt: nextMatch.postedAt,
      monitor_posted_count: nextCount,
    })
  } catch (err) {
    serverError(res, err)
  }
})

// ── POST /v1/matches/feedback ──────────────────────────────────────────────
app.post('/v1/matches/feedback', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { monitor_id, match_id, feedback } = req.body
  if (!monitor_id || !match_id || !['up', 'down'].includes(feedback))
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'monitor_id, match_id, and feedback (up|down) required' } })
  try {
    const redis = getRedis()

    // F6: Verify the caller owns this monitor before allowing a write.
    // Without this, any authenticated user could write feedback into any
    // other user's matches. Return 404 (not 403) to avoid leaking existence.
    const monitorRaw = await redis.get(`insights:monitor:${monitor_id}`)
    if (!monitorRaw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const monitor = typeof monitorRaw === 'string' ? JSON.parse(monitorRaw) : monitorRaw
    if (monitor.owner !== auth.owner) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    }

    const key = `insights:match:${monitor_id}:${match_id}`
    const raw = await redis.get(key)
    if (!raw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Match not found' } })
    const match = typeof raw === 'string' ? JSON.parse(raw) : raw
    await redis.set(key, JSON.stringify({ ...match, feedback, feedbackAt: new Date().toISOString() }))
    res.json({ success: true, match_id, feedback })
  } catch (err) {
    serverError(res, err)
  }
})

// ── POST /v1/matches/draft ─────────────────────────────────────────────────
app.post('/v1/matches/draft', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { monitor_id, match_id } = req.body
  if (!monitor_id || !match_id)
    return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'monitor_id and match_id required' } })
  // Accept either Groq or Deepseek as a draft provider. draftCall() handles
  // primary/peer fallback internally per DRAFT_PRIMARY env.
  const hasProvider = !!(process.env.GROQ_API_KEY || process.env.DEEPSEEK_API_KEY)
  if (!hasProvider) return res.status(503).json({ success: false, error: { code: 'NO_PROVIDER', message: 'Reply drafting unavailable' } })

  // F14: daily Groq cost cap — return 429 instead of crashing on overload.
  try {
    const cap = await getGroqCap()()
    if (!cap.allowed) {
      console.warn(`[matches/draft] Groq daily cap hit (${cap.used}/${cap.max}) — refusing draft`)
      return res.status(429).json({ success: false, error: { code: 'DAILY_CAP', message: 'Daily draft quota reached. Try again tomorrow.' } })
    }
  } catch (_) { /* if redis unavailable, allow through */ }

  try {
    const redis = getRedis()
    const key = `insights:match:${monitor_id}:${match_id}`
    const raw = await redis.get(key)
    if (!raw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Match not found' } })
    const match = typeof raw === 'string' ? JSON.parse(raw) : raw
    const monRaw = await redis.get(`insights:monitor:${monitor_id}`)
    const monitor = monRaw ? (typeof monRaw === 'string' ? JSON.parse(monRaw) : monRaw) : {}
    if (monitor.owner !== auth.owner) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not your monitor' } })
    const productContext = match.productContext || monitor.productContext || ''
    const { draft: finalDraft, model: draftedBy } = await draftCall({
      title: match.title,
      body: match.body,
      subreddit: match.subreddit,
      productContext: productContext.slice(0, 1200),
      productName: monitor.productName || monitor.name,
      tone: monitor.replyTone, // monitor's saved tone — falls back to 'conversational' inside buildDraftPrompt
      // UTM injection (PR #22). All optional — injectUtm no-ops if productUrl
      // is missing, so legacy monitors without these fields draft as before.
      productUrl:  monitor.productUrl,
      utmSource:   monitor.utmSource,
      utmMedium:   monitor.utmMedium,
      utmCampaign: monitor.utmCampaign,
    })

    // Backfill classification if this is a legacy match (no sentiment/intent
    // stored yet). Best-effort: failure does not block the draft response.
    // Cost-cap aware — same getGroqCap() that gates the draft above, so a
    // hot regen-loop on legacy matches can't blow through the daily budget.
    let backfill = {}
    if (!match.intent || !match.sentiment) {
      const r = await classifyMatch({
        title: match.title,
        body: match.body,
        source: match.source,
        costCapCheck: getGroqCap(),
      })
      if (r) {
        backfill = { sentiment: r.sentiment, intent: r.intent, intentConfidence: r.confidence }
      }
    }

    // Deferred-fixes PR: capture the UTM-injected product URL (if any) on
    // the persisted match so a future click-tracking redirect layer can read
    // it directly instead of re-parsing the draft. Null if no product URL
    // was configured or no draft URL matched the product origin.
    const injectedUtmUrl = monitor.productUrl
      ? extractInjectedUtmUrl({ draft: finalDraft, productUrl: monitor.productUrl })
      : null
    const utmFields = injectedUtmUrl
      ? { utmUrl: injectedUtmUrl, utmInjectedAt: new Date().toISOString() }
      : {}
    await redis.set(key, JSON.stringify({
      ...match,
      ...backfill,
      ...utmFields,
      draft: finalDraft,
      draftedBy,
      draftRegeneratedAt: new Date().toISOString(),
    }))
    res.json({
      success: true,
      match_id,
      draft: finalDraft,
      draftedBy,
      ...(backfill.intent ? { sentiment: backfill.sentiment, intent: backfill.intent } : {}),
    })
  } catch (err) {
    serverError(res, err)
  }
})

// ── POST /v1/subscribe — landing page waitlist ─────────────────────────────
app.post('/v1/subscribe', async (req, res) => {
  const { email, plan = 'starter' } = req.body
  if (!email?.includes('@')) return res.status(400).json({ success: false, error: { code: 'MISSING_EMAIL', message: 'Valid email required' } })
  const norm = email.toLowerCase().trim()
  try {
    const redis = getRedis()
    const exists = await redis.get(`insights:waitlist:${norm}`)
    if (exists) return res.json({ success: true, already_on_waitlist: true })
    await redis.sadd('insights:waitlist', norm)
    await redis.set(`insights:waitlist:${norm}`, JSON.stringify({ email: norm, plan, joinedAt: new Date().toISOString() }))
    res.json({ success: true, message: "You're on the waitlist." })
  } catch (err) {
    serverError(res, err)
  }
})

// ── POST /v1/auth/signup — magic-link auth ─────────────────────────────────
// Idempotent: existing email gets a fresh magic-link email; new email gets
// a key + welcome email. Login flow is "click link → /dashboard?key=xxx".
app.post('/v1/auth/signup', async (req, res) => {
  // F5: per-IP rate limit (3/hour). Trust X-Forwarded-For from Railway proxy.
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
  try {
    const limited = await signupLimiter()(`signup:ip:${ip}`)
    if (!limited.allowed) {
      return res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: `Too many signup attempts. Try again in ${Math.ceil(limited.retryAfterSeconds/60)} minutes.` },
      })
    }
  } catch (err) {
    console.error('[signup] rate limiter error:', err.message)
  }

  const { email, name: userName, inviteCode } = req.body || {}

  // F5: strict email validation
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_EMAIL', message: 'A valid email address is required.' } })
  }
  const norm = email.toLowerCase().trim()
  const domain = norm.split('@')[1]
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_EMAIL', message: 'Please use a non-disposable email address.' } })
  }

  try {
    const redis = getRedis()

    // F15: Soft-gate hCaptcha — only kick in for repeat IPs within an hour.
    // First signup from any IP works without friction.
    const recentSignups = Number(await redis.get(`signupcount:ip:${ip}`).catch(() => 0)) || 0
    if (recentSignups >= 1 || req.body?.forceCaptcha) {
      const cap = await verifyCaptcha(req.body?.captchaToken)
      if (!cap.ok) {
        return res.status(400).json({
          success: false,
          error: { code: 'CAPTCHA_REQUIRED', message: 'Please complete the captcha.' },
          requiresCaptcha: true,
          hcaptchaSiteKey: process.env.HCAPTCHA_SITE_KEY || null,
        })
      }
    }

    // Idempotent — existing user gets a fresh magic-link email
    const existing = await redis.get(`insights:signup:${norm}`)
    if (existing) {
      const d = typeof existing === 'string' ? JSON.parse(existing) : existing
      // Apply invite to existing user record if a valid invite was provided
      if (inviteCode && d.key) {
        const apiKeyData = await redis.get(`apikey:${d.key}`)
        if (apiKeyData) {
          const parsed = typeof apiKeyData === 'string' ? JSON.parse(apiKeyData) : apiKeyData
          const upgraded = applyInviteToUser(parsed, inviteCode)
          if (upgraded !== parsed) {
            await redis.set(`apikey:${d.key}`, JSON.stringify(upgraded))
            console.log(`[signup] Existing user ${norm} upgraded to ${upgraded.insightsPlan} via invite`)
          }
        }
      }
      const resendKey = process.env.RESEND_API_KEY
      if (resendKey && d.key) {
        const { Resend } = await import('resend')
        const resend = new Resend(resendKey)
        const from = process.env.FROM_EMAIL || 'insights@ebenova.org'
        const appUrl = process.env.APP_URL || 'https://ebenova.org'
        await resend.emails.send({
          from: `Ebenova Insights <${from}>`, to: norm,
          subject: 'Your Ebenova Insights login link',
          html: `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#f5f5f5;">
            <div style="padding:24px;background:#0e0e0e;border-radius:8px;margin-bottom:24px;">
              <div style="font-size:18px;font-weight:700;color:#FF6B35;">📡 Ebenova Insights</div>
            </div>
            <div style="padding:24px;background:#fff;border-radius:8px;border:1px solid #eee;">
              <p style="margin:0 0 16px;font-size:15px;">Here's your magic login link:</p>
              <a href="${appUrl}/dashboard?key=${d.key}" style="display:inline-block;background:#FF6B35;color:#fff;font-weight:700;padding:14px 28px;border-radius:6px;text-decoration:none;font-size:15px;">Open Dashboard →</a>
              <p style="margin:16px 0 0;font-size:12px;color:#aaa;">Link expires in 7 days. If you didn't request this, ignore it.</p>
            </div>
          </body></html>`,
        }).catch(err => console.error('[auth] Resend login email failed:', err.message))
      }
      // F15: increment IP counter even on idempotent path
      await redis.incr(`signupcount:ip:${ip}`).catch(() => {})
      await redis.expire(`signupcount:ip:${ip}`, 60 * 60).catch(() => {})
      return res.json({ success: true, already_exists: true, message: 'Magic link sent — check your email.' })
    }

    // New email — provision key
    const key = `ins_${randomBytes(16).toString('hex')}`
    const now = new Date().toISOString()
    let keyData = {
      owner: norm,
      email: norm,
      name: (userName || '').slice(0, 100),
      insights: true,
      insightsPlan: 'starter',
      createdAt: now,
      source: 'self-signup',
    }
    if (inviteCode) {
      keyData = applyInviteToUser(keyData, inviteCode)
      if (keyData.source === 'demo-invite') {
        console.log(`[signup] New user ${norm} provisioned with invite → ${keyData.insightsPlan}`)
      }
    }
    await redis.set(`apikey:${key}`, JSON.stringify(keyData))
    await redis.expire(`apikey:${key}`, ONE_YEAR_SECONDS).catch(() => {})
    await redis.set(`insights:signup:${norm}`, JSON.stringify({ key, email: norm, createdAt: now }))
    await redis.expire(`insights:signup:${norm}`, ONE_YEAR_SECONDS).catch(() => {})

    const resendKey = process.env.RESEND_API_KEY
    if (resendKey) {
      const { Resend } = await import('resend')
      const resend = new Resend(resendKey)
      const from = process.env.FROM_EMAIL || 'insights@ebenova.org'
      const appUrl = process.env.APP_URL || 'https://ebenova.org'
      const limits = PLAN_LIMITS[keyData.insightsPlan] || PLAN_LIMITS.starter
      const isDemo = keyData.source === 'demo-invite'
      const planLabel = isDemo ? 'Growth plan (30-day demo)' : keyData.insightsPlan === 'starter' ? 'Starter plan' : `${keyData.insightsPlan.charAt(0).toUpperCase()}${keyData.insightsPlan.slice(1)} plan`
      const monitorWord = limits.monitors === 1 ? 'monitor' : 'monitors'
      const planFooter = isDemo
        ? `Tap the feedback button anytime to share what works and what doesn't.`
        : keyData.insightsPlan === 'starter' ? 'Free forever.' : ''
      await resend.emails.send({
        from:    `Ebenova Insights <${from}>`,
        to:      norm,
        subject: 'Welcome to Ebenova Insights — your magic login link',
        html:    `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#f5f5f5;">
          <div style="padding:24px;background:#0e0e0e;border-radius:8px;margin-bottom:24px;">
            <div style="font-size:18px;font-weight:700;color:#FF6B35;">📡 Ebenova Insights</div>
          </div>
          <div style="padding:24px;background:#fff;border-radius:8px;border:1px solid #eee;">
            <p style="margin:0 0 16px;font-size:15px;">Hi${userName ? ' '+userName : ''},</p>
            <p style="margin:0 0 16px;font-size:15px;color:#333;">Welcome aboard. Click below to open your dashboard — no password needed.</p>
            <a href="${appUrl}/dashboard?key=${key}" style="display:inline-block;background:#FF6B35;color:#fff;font-weight:700;padding:14px 28px;border-radius:6px;text-decoration:none;font-size:15px;margin-bottom:20px;">Open Dashboard →</a>
            <p style="margin:0 0 4px;font-size:14px;color:#666;">You're on the <strong>${planLabel}</strong> — ${limits.monitors} ${monitorWord}, ${limits.keywords} keywords, email alerts. ${planFooter}</p>
            <p style="margin:16px 0 0;font-size:12px;color:#aaa;">Save this email — the link logs you back in any time.</p>
          </div>
        </body></html>`,
      }).catch(err => console.error('[signup] Email send failed:', err.message))
    }

    // F15: increment IP counter for the soft-gate
    await redis.incr(`signupcount:ip:${ip}`).catch(() => {})
    await redis.expire(`signupcount:ip:${ip}`, 60 * 60).catch(() => {})

    console.log(`[signup] New user: ${norm} → key ${key.slice(0, 12)}…`)
    res.status(201).json({
      success: true,
      message: 'Account created. Check your email for the login link.',
      plan: 'starter',
    })
  } catch (err) {
    serverError(res, err)
  }
})

// ── On-demand search helper — Reddit global search (no auth needed) ────────
async function searchRedditNow(keyword) {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=new&limit=25&t=month`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'EbenovaInsights/2.0 (on-demand search)' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data?.data?.children || []).map(c => c.data).map(p => ({
      id: `reddit_${p.id}`,
      source: 'reddit',
      title: p.title,
      body: (p.selftext || '').slice(0, 500),
      url: `https://reddit.com${p.permalink}`,
      subreddit: p.subreddit,
      author: p.author,
      score: p.score,
      comments: p.num_comments,
      createdAt: new Date(p.created_utc * 1000).toISOString(),
      keyword,
      approved: true,
    }))
  } catch { return [] }
}

// ── POST /v1/search — on-demand cross-platform search ──────────────────────
app.post('/v1/search', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })

  // F14: daily search cap (each call hits up to 8 platforms — protects bandwidth)
  try {
    const cap = await getSearchCap()()
    if (!cap.allowed) {
      console.warn(`[search] daily cap hit (${cap.used}/${cap.max}) — refusing`)
      return res.status(429).json({ success: false, error: { code: 'DAILY_CAP', message: 'Daily search quota reached. Try again tomorrow.' } })
    }
  } catch (_) { /* redis unavailable — allow */ }

  const { keywords = [], platforms = ['reddit','medium','substack','quora','upwork','fiverr','github','producthunt','twitter'] } = req.body
  if (!Array.isArray(keywords) || keywords.length === 0)
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELD', message: 'keywords array required' } })

  const kws = keywords.slice(0, 5).map(k => String(k).trim()).filter(Boolean)
  if (!kws.length) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'No valid keywords' } })

  const platformSet = new Set(Array.isArray(platforms) ? platforms : [])
  const noSeen = { has: () => false, add: () => {} }
  const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

  const all = []
  const seenSet = new Set()

  try {
    for (const kw of kws) {
      const kwEntry = { keyword: kw }
      const opts = { seenIds: noSeen, delay: null, MAX_AGE_MS }
      const tasks = []
      if (platformSet.has('reddit'))      tasks.push(searchRedditNow(kw))
      if (platformSet.has('medium'))      tasks.push(searchMedium(kwEntry, opts).catch(() => []))
      if (platformSet.has('substack'))    tasks.push(searchSubstack(kwEntry, opts).catch(() => []))
      if (platformSet.has('quora'))       tasks.push(searchQuora(kwEntry, opts).catch(() => []))
      if (platformSet.has('upwork'))      tasks.push(searchUpwork(kwEntry, opts).catch(() => []))
      if (platformSet.has('fiverr'))      tasks.push(searchFiverr(kwEntry, opts).catch(() => []))
      if (platformSet.has('github'))      tasks.push(searchGitHub(kwEntry, opts).catch(() => []))
      if (platformSet.has('producthunt')) tasks.push(searchProductHunt(kwEntry, opts).catch(() => []))
      if (platformSet.has('twitter'))     tasks.push(searchTwitter(kwEntry, opts).catch(() => []))
      const batches = await Promise.all(tasks)
      for (const batch of batches) {
        for (const item of (batch || [])) {
          if (!seenSet.has(item.id)) { seenSet.add(item.id); all.push(item) }
        }
      }
    }
    all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    res.json({ success: true, results: all.slice(0, 100), count: all.length, searchedAt: new Date().toISOString() })
  } catch (err) {
    serverError(res, err)
  }
})

// ── POST /v1/search/draft — AI reply for an on-demand search result ────────
app.post('/v1/search/draft', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })

  const { title, body: postBody, subreddit, source, productContext } = req.body
  if (!title) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELD', message: 'title required' } })

  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) return res.status(503).json({ success: false, error: { code: 'NO_AI', message: 'Reply drafting unavailable' } })

  // F14: daily Groq cost cap
  try {
    const cap = await getGroqCap()()
    if (!cap.allowed) {
      console.warn(`[search/draft] Groq daily cap hit (${cap.used}/${cap.max}) — refusing draft`)
      return res.status(429).json({ success: false, error: { code: 'DAILY_CAP', message: 'Daily draft quota reached. Try again tomorrow.' } })
    }
  } catch (_) { /* redis unavailable — allow */ }

  try {
    const prompt = `You are a helpful community member. Write a genuine 2-4 sentence reply to this post. Casual tone. No marketing language. If your product (described below) is genuinely relevant, mention it naturally.\n\nProduct context: ${(productContext||'').slice(0,1200)}\n\nPost title: ${title}\nSource: ${source||'reddit'}${subreddit?`/${subreddit}`:''}\nBody: ${(postBody||'(none)').slice(0,600)}\n\nReply with SKIP if not relevant, else just the reply text.`
    const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!gr.ok) return res.status(502).json({ success: false, error: { code: 'AI_ERROR', message: 'Groq request failed' } })
    const gd = await gr.json()
    const raw = gd.choices?.[0]?.message?.content?.trim() || null
    res.json({ success: true, draft: (!raw || raw === 'SKIP') ? null : raw })
  } catch (err) {
    serverError(res, err)
  }
})

// ── Unsubscribe + delete-account (public, token-gated) ────────────────────
// All three routes look up a monitor by an unguessable 32-byte token issued
// at monitor creation. No login required — designed for one-click email
// links and "I lost access" recovery paths.

// Tiny HTML page builder so we don't pull in a template engine.
function htmlPage({ title, body, accent = '#0F172A' }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F1F5F9;color:#0F172A;margin:0;padding:48px 20px;line-height:1.65;}
    .card{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:36px 32px;box-shadow:0 4px 20px rgba(15,23,42,.06);}
    h1{margin:0 0 14px;font-size:22px;color:${accent};letter-spacing:-.3px;}
    p{margin:0 0 14px;font-size:15px;color:#334155;}
    .btn{display:inline-block;background:#FF6B35;color:#fff;font-weight:700;padding:11px 22px;border-radius:6px;text-decoration:none;font-size:14px;margin-top:8px;border:none;cursor:pointer;font-family:inherit;}
    .btn-danger{background:#DC2626;}
    .btn-ghost{background:transparent;color:#64748B;border:1px solid #E2E8F0;}
    .footnote{font-size:12px;color:#94A3B8;margin-top:24px;text-align:center;}
    a{color:#FF6B35;}
  </style></head><body><div class="card">${body}</div><div class="footnote">Ebenova Insights · Built in Canada · Compliant with CASL &amp; NDPR</div></body></html>`
}

// ── GET /unsubscribe?token=… ───────────────────────────────────────────────
app.get('/unsubscribe', async (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8')
  const { token } = req.query
  try {
    const redis = getRedis()
    const resolved = await resolveUnsubscribeToken(redis, token)
    if (!resolved) {
      return res.status(404).send(htmlPage({
        title: 'Link expired or invalid',
        accent: '#DC2626',
        body: `<h1>This unsubscribe link is no longer valid</h1>
          <p>The link may have expired, or the monitor it pointed to has already been deleted.</p>
          <p>If you continue to receive emails, reply to one and we'll handle it manually.</p>`,
      }))
    }
    await setMonitorEmailEnabled(redis, resolved.monitorId, false)
    const appUrl = process.env.APP_URL || 'https://ebenova.org'
    const tokenParam = encodeURIComponent(token)
    res.send(htmlPage({
      title: 'Unsubscribed',
      body: `<h1>You've been unsubscribed</h1>
        <p>Your monitor "<strong>${escapeHtmlInline(resolved.monitor.name || 'Untitled')}</strong>" is still running — it just won't send you any more email alerts.</p>
        <p>Changed your mind?</p>
        <a class="btn" href="${appUrl}/resubscribe?token=${tokenParam}">Re-enable email alerts</a>
        &nbsp;
        <a class="btn btn-ghost" href="${appUrl}/delete-account?token=${tokenParam}">Delete my account instead</a>`,
    }))
  } catch (err) {
    console.error('[unsubscribe] error:', err.message)
    res.status(500).send(htmlPage({ title: 'Error', accent: '#DC2626', body: `<h1>Something went wrong</h1><p>Try the link again in a moment, or reply to your most recent alert email.</p>` }))
  }
})

// ── GET /resubscribe?token=… ───────────────────────────────────────────────
app.get('/resubscribe', async (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8')
  const { token } = req.query
  try {
    const redis = getRedis()
    const resolved = await resolveUnsubscribeToken(redis, token)
    if (!resolved) {
      return res.status(404).send(htmlPage({
        title: 'Link expired or invalid',
        accent: '#DC2626',
        body: `<h1>This link is no longer valid</h1><p>The monitor it pointed to may have been deleted.</p>`,
      }))
    }
    await setMonitorEmailEnabled(redis, resolved.monitorId, true)
    res.send(htmlPage({
      title: 'Re-subscribed',
      body: `<h1>You're back on the list</h1>
        <p>Email alerts for "<strong>${escapeHtmlInline(resolved.monitor.name || 'Untitled')}</strong>" are enabled again. Next match will land in your inbox.</p>`,
    }))
  } catch (err) {
    console.error('[resubscribe] error:', err.message)
    res.status(500).send(htmlPage({ title: 'Error', accent: '#DC2626', body: `<h1>Something went wrong</h1>` }))
  }
})

// ── GET /delete-account?token=… ────────────────────────────────────────────
// Step 1: confirmation page. Does NOT delete anything yet.
app.get('/delete-account', async (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8')
  const { token } = req.query
  try {
    const redis = getRedis()
    const resolved = await resolveUnsubscribeToken(redis, token)
    if (!resolved) {
      return res.status(404).send(htmlPage({
        title: 'Link expired or invalid',
        accent: '#DC2626',
        body: `<h1>This link is no longer valid</h1>
          <p>The account or monitor it pointed to may have already been deleted.</p>`,
      }))
    }
    const tokenParam = encodeURIComponent(token)
    res.send(htmlPage({
      title: 'Delete account?',
      accent: '#DC2626',
      body: `<h1>This cannot be undone</h1>
        <p>Confirming deletion will permanently remove:</p>
        <ul style="font-size:14px;color:#475569;">
          <li>Your monitor "<strong>${escapeHtmlInline(resolved.monitor.name || 'Untitled')}</strong>"</li>
          <li>All matched posts (last 7 days)</li>
          <li>All stored reply drafts</li>
          <li>Your email from our system (if this is your only monitor)</li>
        </ul>
        <p>This action takes effect immediately. There is no recovery.</p>
        <form method="POST" action="/delete-account" style="margin-top:18px;">
          <input type="hidden" name="token" value="${tokenParam}">
          <button class="btn btn-danger" type="submit">Confirm deletion</button>
        </form>
        <p style="margin-top:18px;font-size:13px;">
          <a href="/unsubscribe?token=${tokenParam}">Just stop the emails instead</a>
        </p>`,
    }))
  } catch (err) {
    console.error('[delete-account GET] error:', err.message)
    res.status(500).send(htmlPage({ title: 'Error', accent: '#DC2626', body: `<h1>Something went wrong</h1>` }))
  }
})

// ── POST /delete-account ───────────────────────────────────────────────────
// Step 2: actually delete. Body can come as form-encoded (from the GET-page
// form) or JSON (from the dashboard's typed-DELETE flow).
app.post('/delete-account', express.urlencoded({ extended: false }), async (req, res) => {
  const isHtml = (req.headers['accept'] || '').includes('text/html')
  res.set('Content-Type', isHtml ? 'text/html; charset=utf-8' : 'application/json')
  const token = req.body?.token || req.query?.token
  try {
    const redis = getRedis()
    const resolved = await resolveUnsubscribeToken(redis, token)
    if (!resolved) {
      const msg = 'This link is no longer valid.'
      return res.status(404).send(isHtml
        ? htmlPage({ title: 'Not found', accent: '#DC2626', body: `<h1>${msg}</h1>` })
        : JSON.stringify({ success: false, error: { code: 'INVALID_TOKEN', message: msg } }))
    }

    const summary = await deleteMonitorAndData(redis, resolved.monitorId)
    await logDeletion(redis, { monitorId: resolved.monitorId, reason: 'user_request' })

    // Best-effort: remove the user from a Resend audience if one is set up.
    // Silent no-op when audience isn't configured.
    if (resolved.monitor.owner) {
      removeResendContact({ email: resolved.monitor.owner })
        .then(r => { if (!r.removed && r.reason !== 'no_audience_configured' && r.reason !== 'no_resend_key') {
          console.warn(`[delete-account] resend contact removal: ${r.reason}`)
        } })
        .catch(err => console.warn('[delete-account] resend contact threw:', err.message))
    }

    // Audit notification to operator email (no PII in the message body
    // beyond the monitor name + ID — owner email is not included).
    notifyOperatorOfDeletion({
      monitorId: resolved.monitorId,
      monitorName: resolved.monitor.name,
      accountAlsoDeleted: summary.accountAlsoDeleted,
    }).catch(() => {}) // never block the response on audit email

    if (isHtml) {
      return res.status(200).send(htmlPage({
        title: 'Deleted',
        body: `<h1>All done</h1>
          <p>Your account and all associated data have been deleted.</p>
          <p>If you have questions, email <a href="mailto:olumide@ebenova.net">olumide@ebenova.net</a>.</p>`,
      }))
    }
    res.json({
      success: true,
      monitor_id: resolved.monitorId,
      account_deleted: summary.accountAlsoDeleted,
      removed: summary.deleted.length,
    })
  } catch (err) {
    const requestId = makeRequestId()
    console.error(`[delete-account POST] error ${requestId}:`, err)
    res.status(500).send(isHtml
      ? htmlPage({ title: 'Error', accent: '#DC2626', body: `<h1>Something went wrong</h1>` })
      : JSON.stringify({ success: false, error: { code: 'SERVER_ERROR', message: 'Internal server error', requestId } }))
  }
})

// Minimal HTML escape — only for values we interpolate into the unsub pages.
function escapeHtmlInline(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Operator notification — fires when any monitor is deleted via the
// public /delete-account flow. No PII (no email address); just a heads-up
// so the operator has a human-readable audit trail in their inbox.
async function notifyOperatorOfDeletion({ monitorId, monitorName, accountAlsoDeleted }) {
  if (!process.env.RESEND_API_KEY) return
  const operatorEmail = process.env.ALERT_EMAIL || 'info@ebenova.net'
  try {
    const { Resend } = await import('resend')
    const resend = new Resend(process.env.RESEND_API_KEY)
    const fromAddress = process.env.FROM_EMAIL || 'insights@ebenova.org'
    await resend.emails.send({
      from:    `Ebenova Insights <${fromAddress}>`,
      to:      operatorEmail,
      subject: `[audit] Monitor deleted via /delete-account · ${monitorId.slice(0, 12)}`,
      text:    `A user-initiated deletion just completed.\n\nMonitor: ${monitorName || '(untitled)'}\nMonitor ID: ${monitorId}\nAccount fully wiped: ${accountAlsoDeleted ? 'yes' : 'no — owner had other monitors'}\nWhen: ${new Date().toUTCString()}\n\nThis email contains no user PII. Original Redis records have been removed.`,
    })
  } catch (err) {
    console.warn('[delete-account] operator notification failed:', err.message)
  }
}

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[api] Ebenova Insights API listening on :${PORT}`)
  console.log(`[api] Redis: ${process.env.UPSTASH_REDIS_REST_URL ? 'configured' : '⚠️ UPSTASH_REDIS_REST_URL not set'}`)
})

export default app
