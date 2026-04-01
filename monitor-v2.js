// reddit-monitor/monitor-v2.js
// Multi-tenant Insights worker — polls Redis for active monitors,
// runs keyword searches for each, stores matches, sends email alerts.
//
// Runs on Railway alongside the existing monitor.js (v1 = Skido's own keywords).
// Start with: node monitor-v2.js
// Env vars needed: REDIS_URL, RESEND_API_KEY, GROQ_API_KEY, FROM_EMAIL

import { readFileSync } from 'fs'
import { resolve }      from 'path'

// ── Load .env ─────────────────────────────────────────────────────────────────
try {
  const lines = readFileSync(resolve(process.cwd(), '.env'), 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq  = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    if (key && val && !process.env[key]) process.env[key] = val
  }
} catch (_) {}

import { Resend }  from 'resend'
import { Redis }   from '@upstash/redis'
import cron        from 'node-cron'

const RESEND_API_KEY   = process.env.RESEND_API_KEY
const GROQ_API_KEY     = process.env.GROQ_API_KEY
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY   // embeddings for semantic search
const VOYAGE_API_KEY   = process.env.VOYAGE_API_KEY   // alternative: cheaper than OpenAI
const FROM_EMAIL       = process.env.FROM_EMAIL || 'insights@ebenova.dev'
const POLL_MINUTES     = parseInt(process.env.POLL_INTERVAL_MINUTES || '15')
const MAX_SEEN         = 50_000
const SEMANTIC_ENABLED = !!(OPENAI_API_KEY || VOYAGE_API_KEY)

// ── Redis client ──────────────────────────────────────────────────────────────
// Upstash REST only (same as Signova's lib/redis.js).
// Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN in Railway vars.
function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL  || process.env.REDIS_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN
  if (!url) throw new Error('UPSTASH_REDIS_REST_URL not set')
  return new Redis({ url, token })
}

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null

// ── Seen IDs (global, resets on restart) ─────────────────────────────────────
// We track by monitorId + postId so different monitors don't block each other
const seenMap = new Map() // key: `${monitorId}:${postId}` → true

function hasSeen(monitorId, postId) {
  return seenMap.has(`${monitorId}:${postId}`)
}

function markSeen(monitorId, postId) {
  seenMap.set(`${monitorId}:${postId}`, true)
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
])

// ── Semantic search (V2) ─────────────────────────────────────────────────────
// Uses text-embedding-3-small (OpenAI) or voyage-lite-02-instruct (Voyage AI)
// to find posts by intent rather than exact keyword match.
// Falls back to keyword search if embeddings are unavailable.

const embeddingCache = new Map() // cache embeddings to save API calls

async function getEmbedding(text) {
  const key = text.slice(0, 100)
  if (embeddingCache.has(key)) return embeddingCache.get(key)

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
      if (vec) embeddingCache.set(key, vec)
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
      if (vec) embeddingCache.set(key, vec)
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
      if (hasSeen(monitorId, p.id)) continue
      if (Date.now() - p.created_utc * 1000 > 60 * 60 * 1000) continue

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
// Returns new posts (< 60 min old) not yet seen for this monitor.
async function searchReddit(monitorId, keywordEntry) {
  const { keyword, subreddits = [] } = keywordEntry
  const results = []
  const encoded = encodeURIComponent(keyword)

  const urls = subreddits.length > 0
    ? subreddits.map(sr =>
        `https://www.reddit.com/r/${sr}/search.json?q=${encoded}&sort=new&limit=10&t=day&restrict_sr=1`
      )
    : [`https://www.reddit.com/search.json?q=${encoded}&sort=new&limit=10&t=day`]

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'ebenova-insights/2.0 (multi-tenant monitor)' },
      })
      if (!res.ok) { await delay(3000); continue }
      const data = await res.json()
      const posts = data?.data?.children || []

      for (const post of posts) {
        const p = post.data
        if (hasSeen(monitorId, p.id)) continue
        if (Date.now() - p.created_utc * 1000 > 60 * 60 * 1000) continue
        markSeen(monitorId, p.id)
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
    } catch (err) {
      console.error(`[v2] Reddit fetch error "${keyword}":`, err.message)
    }
    await delay(2000)
  }
  return results
}

// ── Nairaland search ──────────────────────────────────────────────────────────
async function searchNairaland(monitorId, keywordEntry) {
  const { keyword, nairalandSection = 'business' } = keywordEntry
  const results = []
  const encoded = encodeURIComponent(keyword)
  const url = `https://www.nairaland.com/search/posts/${encoded}/${nairalandSection}/0/0`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EbenovaInsights/2.0)', 'Accept': 'text/html' },
    })
    if (!res.ok) return results
    const html = await res.text()
    const pattern = /<td[^>]*>\s*<b>\s*<a href="(\/[^"]+)"[^>]*>([^<]+)<\/a>/gi
    const seen = new Set()
    let match
    while ((match = pattern.exec(html)) !== null) {
      const path  = match[1]
      const title = match[2].trim()
      if (!path || !title || path.length < 5) continue
      const id = `nl_${path.replace(/\//g, '_')}`
      if (hasSeen(monitorId, id) || seen.has(id)) continue
      seen.add(id)
      markSeen(monitorId, id)
      const snippet = html.slice(pattern.lastIndex, pattern.lastIndex + 700)
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
      results.push({
        id, title,
        url:       `https://www.nairaland.com${path}`,
        subreddit: `Nairaland/${nairalandSection}`,
        author:    'nairaland',
        score:     0, comments: 0,
        body:      snippet,
        createdAt: new Date().toISOString(),
        keyword,   source: 'nairaland', approved: true,
      })
      if (results.length >= 5) break
    }
  } catch (err) {
    console.error(`[v2] Nairaland fetch error "${keyword}":`, err.message)
  }
  return results
}

// ── AI reply draft ────────────────────────────────────────────────────────────
// Uses monitor's productContext so each customer's drafts are tailored to them.
async function generateReplyDraft(post, productContext) {
  if (!GROQ_API_KEY) return null
  if (!productContext || !productContext.trim()) return null
  if (!post.approved) return null

  const prompt = `You are a Reddit community member helping people with real problems. You have genuine expertise described below. You are NOT a marketer.

YOUR PRODUCT/EXPERTISE:
${productContext.slice(0, 1500)}

REDDIT POST:
Title: ${post.title}
Subreddit: r/${post.subreddit}
Body: ${post.body || '(no body)'}

━━━ SKIP FILTER ━━━
Respond ONLY with the word SKIP if ANY are true:
- Post is emotional, relational, or venting — not a task/tool problem
- Keyword matched incidentally (e.g. social meaning, not product-relevant)
- The post is clearly from a bot or spam
- Mentioning a product would feel like an ad in this context
- Post is asking about something completely unrelated to your expertise

━━━ REPLY (if not skipping) ━━━
Write a helpful 2-4 sentence reply as a community member.
- Casual, direct tone — not corporate
- Give real advice first. Only mention your product if it's the single most natural fit.
- Never use "check out", "I recommend", "great tool"
- No bullet points, headers, or markdown
- Do not start with "I"
- If mentioning your product: phrase as "I use" or "there's a tool called"

Respond with SKIP or the reply only. No labels or explanation.`

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const text = data.choices?.[0]?.message?.content?.trim() || null
    return (!text || text === 'SKIP') ? null : text
  } catch { return null }
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
      <div style="margin-bottom:18px;padding:14px;background:#f9f9f9;border-left:4px solid #c9a84c;border-radius:4px;">
        <div style="font-size:12px;color:#888;margin-bottom:5px;">
          ${p.source === 'nairaland' ? '🇳🇬' : '📌'} ${p.subreddit} · u/${p.author} · ${p.score} upvotes
        </div>
        <a href="${p.url}" style="font-size:15px;font-weight:600;color:#1a1a1a;text-decoration:none;">${p.title}</a>
        ${p.body ? `<p style="font-size:13px;color:#555;margin:7px 0 0;line-height:1.5;">${p.body}${p.body.length >= 300 ? '…' : ''}</p>` : ''}
        <a href="${p.url}" style="display:inline-block;margin-top:8px;font-size:12px;color:#c9a84c;font-weight:600;">Open thread →</a>
        ${!p.approved ? `
        <div style="margin-top:8px;padding:6px 10px;background:#fdecea;border:1px solid #f5c6cb;border-radius:4px;font-size:12px;font-weight:700;color:#c0392b;">
          ⚠️ DO NOT POST — ${p.subreddit} is not an approved subreddit
        </div>` : ''}
        ${p.draft ? `
        <div style="margin-top:10px;padding:12px;background:#fffdf0;border:1px solid #e8d87a;border-radius:6px;">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#a08c00;margin-bottom:6px;">✏️ Suggested reply</div>
          <div style="font-size:13px;color:#333;line-height:1.6;white-space:pre-wrap;">${p.draft}</div>
        </div>` : ''}
      </div>`).join('')
    return `
      <div style="margin-bottom:28px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#aaa;margin-bottom:10px;">"${kw}" (${posts.length})</div>
        ${items}
      </div>`
  }).join('')

  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:32px 24px;background:#f5f5f5;color:#1a1a1a;">
    <div style="margin-bottom:24px;padding:20px;background:#0e0e0e;border-radius:8px;">
      <div style="font-size:18px;font-weight:700;color:#f0ece4;">📡 Ebenova Insights — ${monitor.name}</div>
      <div style="font-size:13px;color:#9a9690;margin-top:6px;">${matches.length} new mention${matches.length !== 1 ? 's' : ''} · ${new Date().toUTCString()}</div>
    </div>
    ${keywordSections}
    <div style="margin-top:24px;font-size:11px;color:#aaa;text-align:center;">Ebenova Insights · <a href="https://ebenova.dev/insights" style="color:#c9a84c;">ebenova.dev/insights</a></div>
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
  if (!resend) {
    console.log(`[v2][${monitor.id}] No resend key — printing ${matches.length} matches to console`)
    matches.forEach(m => console.log(`  [${m.keyword}] ${m.title} — ${m.url}`))
    return
  }
  const keywords = [...new Set(matches.map(m => m.keyword))]
  const subject  = `Insights: ${matches.length} new mention${matches.length !== 1 ? 's' : ''} — ${keywords.slice(0, 3).join(', ')}${keywords.length > 3 ? '…' : ''}`
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

    // Nairaland (only if keyword has a nairalandSection set)
    if (kw.nairalandSection) {
      const nlMatches = await searchNairaland(monitor.id, kw)
      for (const m of nlMatches) {
        m.productContext = ctx
        allMatches.push(m)
      }
      if (nlMatches.length > 0) {
        console.log(`${label} Nairaland "${kw.keyword}": ${nlMatches.length} new`)
      }
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
      m.draft = await generateReplyDraft(m, m.productContext)
      if (m.draft) console.log(`${label} Draft: "${m.title.slice(0, 50)}…"`)
    }))
    if (i + CONCURRENCY < allMatches.length) await delay(1000)
  }

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
}

// ── Main poll cycle ───────────────────────────────────────────────────────────
// Loads all active monitor IDs from Redis, fetches each monitor's config,
// then runs them with a concurrency limit so we don't hammer Reddit.
async function poll() {
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

if (!process.env.UPSTASH_REDIS_REST_URL) {
  console.error('[v2] ❌ UPSTASH_REDIS_REST_URL is required. Set it in Railway vars.')
  process.exit(1)
}

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
