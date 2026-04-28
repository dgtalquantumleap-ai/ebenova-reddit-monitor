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
import searchMedium      from './lib/scrapers/medium.js'
import searchSubstack    from './lib/scrapers/substack.js'
import searchQuora       from './lib/scrapers/quora.js'
import searchUpwork      from './lib/scrapers/upwork.js'
import searchFiverr      from './lib/scrapers/fiverr.js'
import searchGitHub      from './lib/scrapers/github.js'
import searchProductHunt from './lib/scrapers/producthunt.js'
import { loadEnv } from './lib/env.js'
import { makeCorsMiddleware } from './lib/cors.js'
import helmet from 'helmet'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

// Load .env via shared dotenv loader (replaces hand-rolled parser).
loadEnv()

import { Redis } from '@upstash/redis'
import { randomBytes } from 'crypto'
import { makeRateLimiter } from './lib/rate-limit.js'
import { makeCostCap } from './lib/cost-cap.js'
import { verifyCaptcha } from './lib/captcha.js'
import { applyInviteToUser } from './lib/invite.js'

const PORT = parseInt(process.env.API_PORT || process.env.PORT || '3001')
const ADMIN_KEY = process.env.MONITOR_ADMIN_KEY

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
    return { ok: true, owner: keyData.owner, keyData }
  } catch (err) {
    return { ok: false, status: 500, error: { code: 'AUTH_ERROR', message: err.message } }
  }
}

const PLAN_LIMITS = {
  starter: { monitors: 1,   keywords: 10  },
  growth:  { monitors: 20,  keywords: 100 },
  scale:   { monitors: 100, keywords: 500 },
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

app.use(express.json())
app.use(express.static(join(__dirname, 'public')))
app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')))
app.get('/dashboard', (req, res) => res.sendFile(join(__dirname, 'public', 'dashboard.html')))

// CORS allowlist (replaces wildcard). Set ALLOWED_ORIGINS env to override.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://ebenova.dev,https://www.ebenova.dev,https://ebenova-insights-production.up.railway.app')
  .split(',').map(s => s.trim()).filter(Boolean)
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
    catch (err) { return res.status(503).json({ success: false, error: { code: 'NOT_CONFIGURED', message: err.message } }) }
  }
  _findRouter(req, res, next)
})

// Feedback endpoint — same lazy-mount pattern.
let _feedbackRouter
app.use('/v1/feedback', (req, res, next) => {
  if (!_feedbackRouter) {
    try { _feedbackRouter = createFeedbackRouter({ redis: getRedis() }) }
    catch (err) { return res.status(503).json({ success: false, error: { code: 'NOT_CONFIGURED', message: err.message } }) }
  }
  _feedbackRouter(req, res, next)
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
        })
      }
    }
    res.json({ success: true, monitors, count: monitors.length })
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } })
  }
})

// ── POST /v1/monitors ──────────────────────────────────────────────────────
app.post('/v1/monitors', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { name, keywords = [], productContext, alertEmail, slackWebhookUrl,
    includeMedium, includeSubstack, includeQuora, includeUpworkForum, includeFiverrForum } = req.body
  const plan = auth.keyData.insightsPlan || 'starter'
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.starter
  if (!name?.trim()) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELD', message: '"name" is required' } })
  if (!Array.isArray(keywords) || keywords.length === 0)
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELD', message: '"keywords" must be a non-empty array' } })
  if (keywords.length > limits.keywords)
    return res.status(400).json({ success: false, error: { code: 'KEYWORD_LIMIT_EXCEEDED', message: `Max ${limits.keywords} keywords on ${plan} plan` } })
  try {
    const redis = getRedis()
    const cleanKws = keywords.map(k => typeof k === 'string'
      ? { keyword: k.trim(), subreddits: [], productContext: '' }
      : { keyword: String(k.keyword || '').trim(), subreddits: Array.isArray(k.subreddits) ? k.subreddits.slice(0, 10) : [], productContext: String(k.productContext || '').slice(0, 500) }
    ).filter(k => k.keyword.length > 1)
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

    const now = new Date().toISOString()
    const monitor = { id, owner: auth.owner, name: name.trim().slice(0, 100), keywords: cleanKws,
      productContext: (productContext || '').slice(0, 2000), alertEmail: alertEmail || auth.owner,
      slackWebhookUrl: (slackWebhookUrl || '').slice(0, 500),
      includeMedium:      includeMedium      !== false,
      includeSubstack:    includeSubstack    !== false,
      includeQuora:       includeQuora       !== false,
      includeUpworkForum: includeUpworkForum !== false,
      includeFiverrForum: includeFiverrForum !== false,
      active: true, plan, createdAt: now, lastPollAt: null, totalMatchesFound: 0 }
    await redis.set(`insights:monitor:${id}`, JSON.stringify(monitor))
    await redis.sadd('insights:active_monitors', id)
    res.status(201).json({ success: true, monitor_id: id, name: monitor.name, keyword_count: cleanKws.length,
      keywords: cleanKws.map(k => k.keyword), plan, alert_email: monitor.alertEmail, active: true,
      created_at: now, next_poll_eta: 'Within 15 minutes' })
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } })
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
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } })
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
    res.json({ success: true, monitor_id, matches, count: matches.length, offset: off, limit: lim })
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } })
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
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } })
  }
})

// ── POST /v1/matches/draft ─────────────────────────────────────────────────
app.post('/v1/matches/draft', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { monitor_id, match_id } = req.body
  if (!monitor_id || !match_id)
    return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'monitor_id and match_id required' } })
  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) return res.status(503).json({ success: false, error: { code: 'NO_AI', message: 'AI drafts not configured' } })

  // F14: daily Groq cost cap — return 429 instead of crashing on overload.
  try {
    const cap = await getGroqCap()()
    if (!cap.allowed) {
      console.warn(`[matches/draft] Groq daily cap hit (${cap.used}/${cap.max}) — refusing draft`)
      return res.status(429).json({ success: false, error: { code: 'DAILY_CAP', message: 'Daily AI draft quota reached. Try again tomorrow.' } })
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
    const prompt = `You are a Reddit community member. Write a helpful 2-4 sentence reply to this post. Casual tone. No marketing language. If your product (described below) is genuinely relevant, mention it naturally as "I use" or "there's a thing called".\n\nProduct context: ${productContext.slice(0,1200)}\n\nPost title: ${match.title}\nSubreddit: r/${match.subreddit}\nBody: ${match.body || '(none)'}\n\nReply with SKIP if not relevant, else just the reply text.`
    const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!gr.ok) return res.status(502).json({ success: false, error: { code: 'AI_ERROR', message: 'Groq request failed' } })
    const gd = await gr.json()
    const draft = gd.choices?.[0]?.message?.content?.trim() || null
    const finalDraft = (!draft || draft === 'SKIP') ? null : draft
    await redis.set(key, JSON.stringify({ ...match, draft: finalDraft, draftRegeneratedAt: new Date().toISOString() }))
    res.json({ success: true, match_id, draft: finalDraft })
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } })
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
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } })
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
        const from = process.env.FROM_EMAIL || 'insights@ebenova.dev'
        const appUrl = process.env.APP_URL || 'https://ebenova-insights-production.up.railway.app'
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
    await redis.set(`insights:signup:${norm}`, JSON.stringify({ key, email: norm, createdAt: now }))

    const resendKey = process.env.RESEND_API_KEY
    if (resendKey) {
      const { Resend } = await import('resend')
      const resend = new Resend(resendKey)
      const from = process.env.FROM_EMAIL || 'insights@ebenova.dev'
      const appUrl = process.env.APP_URL || 'https://ebenova-insights-production.up.railway.app'
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
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } })
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

  const { keywords = [], platforms = ['reddit','medium','substack','quora','upwork','fiverr','github','producthunt'] } = req.body
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
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } })
  }
})

// ── POST /v1/search/draft — AI reply for an on-demand search result ────────
app.post('/v1/search/draft', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })

  const { title, body: postBody, subreddit, source, productContext } = req.body
  if (!title) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELD', message: 'title required' } })

  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) return res.status(503).json({ success: false, error: { code: 'NO_AI', message: 'AI drafts not configured' } })

  // F14: daily Groq cost cap
  try {
    const cap = await getGroqCap()()
    if (!cap.allowed) {
      console.warn(`[search/draft] Groq daily cap hit (${cap.used}/${cap.max}) — refusing draft`)
      return res.status(429).json({ success: false, error: { code: 'DAILY_CAP', message: 'Daily AI draft quota reached. Try again tomorrow.' } })
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
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } })
  }
})

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[api] Ebenova Insights API listening on :${PORT}`)
  console.log(`[api] Redis: ${process.env.UPSTASH_REDIS_REST_URL ? 'configured' : '⚠️ UPSTASH_REDIS_REST_URL not set'}`)
})

export default app
