// reddit-monitor/api-server.js
// Express HTTP API — exposes reddit-monitor as a service on Railway
// Mounts alongside the v1/v2 cron workers via start-all.js
//
// Endpoints:
//   GET  /health
//   GET  /v1/monitors          — list monitors for an owner (by API key)
//   POST /v1/monitors          — create monitor
//   DELETE /v1/monitors/:id    — deactivate monitor
//   GET  /v1/matches           — list recent matches for a monitor
//   POST /v1/matches/draft     — regenerate AI draft for a match
//   POST /v1/matches/feedback  — thumbs up/down on a draft

import express from 'express'
import { readFileSync } from 'fs'
import { resolve, join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import stripeRoutes from './routes/stripe.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

// ── Load .env ──────────────────────────────────────────────────────────────
try {
  const lines = readFileSync(resolve(process.cwd(), '.env'), 'utf8').split('\n')
  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    const k = t.slice(0, eq).trim()
    const v = t.slice(eq + 1).trim()
    if (k && v && !process.env[k]) process.env[k] = v
  }
} catch (_) {}

import { Redis } from '@upstash/redis'
import { randomBytes } from 'crypto'

const PORT = parseInt(process.env.API_PORT || process.env.PORT || '3001')
const ADMIN_KEY = process.env.MONITOR_ADMIN_KEY   // for internal provisioning

// ── Redis ──────────────────────────────────────────────────────────────────
function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must both be set')
  return new Redis({ url, token })
}

// ── Auth helper — validates API key against Signova's Redis key store ─────
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
  starter: { monitors: 3,   keywords: 20  },
  growth:  { monitors: 20,  keywords: 100 },
  scale:   { monitors: 100, keywords: 500 },
}

// ── App ────────────────────────────────────────────────────────────────────
const app = express()
app.use(express.json())
app.use(express.static(join(__dirname, 'public')))
app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')))
app.get('/dashboard', (req, res) => res.sendFile(join(__dirname, 'public', 'dashboard.html')))
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, PATCH')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  next()
})

// ── Stripe billing ─────────────────────────────────────────────────────────
// Webhook route uses express.raw() internally — must be mounted before express.json() would re-parse it
app.use('/v1/billing', stripeRoutes)

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

// ── GET /v1/monitors ──────────────────────────────────────────────────────
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

// ── POST /v1/monitors ─────────────────────────────────────────────────────
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
    const existing = await redis.smembers(`insights:monitors:${auth.owner}`) || []
    if (existing.length >= limits.monitors)
      return res.status(429).json({ success: false, error: { code: 'MONITOR_LIMIT_REACHED', message: `Max ${limits.monitors} monitors on ${plan} plan` } })
    const cleanKws = keywords.map(k => typeof k === 'string'
      ? { keyword: k.trim(), subreddits: [], productContext: '' }
      : { keyword: String(k.keyword || '').trim(), subreddits: Array.isArray(k.subreddits) ? k.subreddits.slice(0, 10) : [], productContext: String(k.productContext || '').slice(0, 500) }
    ).filter(k => k.keyword.length > 1)
    const id = `mon_${randomBytes(12).toString('hex')}`
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
    await redis.sadd(`insights:monitors:${auth.owner}`, id)
    await redis.sadd('insights:active_monitors', id)
    res.status(201).json({ success: true, monitor_id: id, name: monitor.name, keyword_count: cleanKws.length,
      keywords: cleanKws.map(k => k.keyword), plan, alert_email: monitor.alertEmail, active: true,
      created_at: now, next_poll_eta: 'Within 15 minutes' })
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } })
  }
})

// ── DELETE /v1/monitors/:id ───────────────────────────────────────────────
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

// ── GET /v1/matches ───────────────────────────────────────────────────────
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

// ── POST /v1/matches/feedback ─────────────────────────────────────────────
app.post('/v1/matches/feedback', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { monitor_id, match_id, feedback } = req.body
  if (!monitor_id || !match_id || !['up', 'down'].includes(feedback))
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'monitor_id, match_id, and feedback (up|down) required' } })
  try {
    const redis = getRedis()
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

// ── POST /v1/subscribe — waitlist ─────────────────────────────────────────
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

// ── POST /v1/auth/signup — self-serve API key provisioning ───────────────
// Creates an API key, stores it in Redis, and emails it to the user.
// Starter plan is assigned automatically. Upgrade via /v1/billing/checkout.
app.post('/v1/auth/signup', async (req, res) => {
  const { email, name: userName } = req.body
  if (!email?.includes('@')) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_EMAIL', message: 'Valid email required' } })
  }
  const norm = email.toLowerCase().trim()

  try {
    const redis = getRedis()

    // Idempotent — return existing key if already signed up
    const existing = await redis.get(`insights:signup:${norm}`)
    if (existing) {
      const d = typeof existing === 'string' ? JSON.parse(existing) : existing
      return res.json({ success: true, already_exists: true, message: `Welcome back. Check your original signup email for your API key, or contact support.` })
    }

    // Generate key: ins_{32 random hex chars}
    const key = `ins_${randomBytes(16).toString('hex')}`
    const now = new Date().toISOString()

    // Store the key in Redis (same shape as manual provisions)
    const keyData = {
      owner: norm,
      email: norm,
      name: (userName || '').slice(0, 100),
      insights: true,
      insightsPlan: 'starter',
      createdAt: now,
      source: 'self-signup',
    }
    await redis.set(`apikey:${key}`, JSON.stringify(keyData))
    await redis.set(`insights:signup:${norm}`, JSON.stringify({ key, createdAt: now }))

    // Send welcome email via Resend
    const resendKey = process.env.RESEND_API_KEY
    if (resendKey) {
      const { Resend } = await import('resend')
      const resend = new Resend(resendKey)
      const from = process.env.FROM_EMAIL || 'insights@ebenova.dev'
      const appUrl = process.env.APP_URL || 'https://ebenova-insights-production.up.railway.app'
      await resend.emails.send({
        from:    `Ebenova Insights <${from}>`,
        to:      norm,
        subject: 'Your Ebenova Insights API key',
        html:    `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#f5f5f5;">
          <div style="padding:24px;background:#0e0e0e;border-radius:8px;margin-bottom:24px;">
            <div style="font-size:18px;font-weight:700;color:#c9a84c;">📡 Ebenova Insights</div>
          </div>
          <div style="padding:24px;background:#fff;border-radius:8px;border:1px solid #eee;">
            <p style="margin:0 0 16px;font-size:15px;">Hi${userName ? ' '+userName : ''},</p>
            <p style="margin:0 0 16px;font-size:15px;color:#333;">Here's your API key for Ebenova Insights:</p>
            <div style="padding:14px 16px;background:#f5f5f5;border-radius:6px;font-family:monospace;font-size:15px;font-weight:700;letter-spacing:0.5px;margin-bottom:20px;word-break:break-all;">${key}</div>
            <p style="margin:0 0 16px;font-size:14px;color:#666;">You're on the <strong>Starter plan</strong> — 3 monitors, 20 keywords, email digest. Free forever.</p>
            <a href="${appUrl}/dashboard" style="display:inline-block;background:#c9a84c;color:#000;font-weight:700;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:15px;">Open Dashboard →</a>
          </div>
          <p style="margin-top:20px;font-size:12px;color:#aaa;text-align:center;">Ebenova Insights · <a href="https://ebenova.dev" style="color:#c9a84c;">ebenova.dev</a></p>
        </body></html>`,
      }).catch(err => console.error('[signup] Email send failed:', err.message))
    }

    console.log(`[signup] New user: ${norm} → key ${key.slice(0, 12)}…`)
    res.status(201).json({
      success: true,
      message: 'Account created. Check your email for your API key.',
      plan: 'starter',
    })
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
