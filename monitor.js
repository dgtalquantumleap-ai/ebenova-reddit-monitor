// reddit-monitor/monitor.js
// Polls Reddit's public search API for keyword matches
// Sends email digest via Resend when new posts/comments are found
// No Reddit API key required — uses public JSON endpoints

import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load .env manually (no dotenv dependency needed)
try {
  const envPath = resolve(process.cwd(), '.env')
  const lines = readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (key && val && !process.env[key]) process.env[key] = val
  }
} catch (_) {}

import { Resend } from 'resend'
import cron from 'node-cron'

const RESEND_API_KEY = process.env.RESEND_API_KEY
const GROQ_API_KEY   = process.env.GROQ_API_KEY
const ALERT_EMAIL    = process.env.ALERT_EMAIL    || 'info@ebenova.net'
const FROM_EMAIL        = process.env.FROM_EMAIL      || 'monitor@getsignova.com'
const POLL_MINUTES      = parseInt(process.env.POLL_INTERVAL_MINUTES || '10')

const resend = new Resend(RESEND_API_KEY)

// ── Keywords to monitor ───────────────────────────────────────────────────────
// Each entry: { keyword, subreddits (optional — omit to search all of Reddit), product }
const KEYWORDS = [

  // ── SIGNOVA — getsignova.com ─────────────────────────────────────────────
  // Legal document generator for freelancers, small businesses, Nigeria/Africa
  { keyword: 'freelance contract',          subreddits: ['freelance','freelancers','smallbusiness','Entrepreneur'],        product: 'Signova' },
  { keyword: 'unpaid invoice',              subreddits: ['freelance','freelancers','smallbusiness'],                       product: 'Signova' },
  { keyword: 'NDA template',               subreddits: ['freelance','smallbusiness','startups','SoloDevelopment'],         product: 'Signova' },
  { keyword: 'tenancy agreement nigeria',   subreddits: ['Nigeria','lagos','nairaland'],                                   product: 'Signova' },
  { keyword: "client won't pay",           subreddits: ['freelance','smallbusiness','Entrepreneur'],                      product: 'Signova' },
  { keyword: 'scope creep',                subreddits: ['freelance','agency','agencynewbies','SoloDevelopment'],           product: 'Signova' },
  { keyword: 'generate legal document',    subreddits: ['freelance','smallbusiness','Entrepreneur'],                      product: 'Signova' },
  { keyword: 'need a contract template',   subreddits: ['freelance','smallbusiness'],                                     product: 'Signova' },
  { keyword: 'only had verbal agreement',  subreddits: ['smallbusiness','freelance','Entrepreneur'],                      product: 'Signova' },
  { keyword: 'deed of assignment',         subreddits: ['Nigeria','lagos','naija'],                                        product: 'Signova' },
  { keyword: 'contract dispute',           subreddits: ['smallbusiness','freelance','Entrepreneur'],                      product: 'Signova' },
  { keyword: 'landlord tenant agreement',  subreddits: ['Nigeria','lagos','LandlordLady'],                                 product: 'Signova' },
  { keyword: 'privacy policy generator',   subreddits: ['webdev','SaaS','startups','Entrepreneur','smallbusiness'],        product: 'Signova' },
  { keyword: 'how to write a contract',    subreddits: ['freelance','smallbusiness','Entrepreneur'],                       product: 'Signova' },

  // ── PEEKR — getpeekr.com ─────────────────────────────────────────────────
  // Share photos/videos/PDFs from iPhone to a room via QR — no app for viewers
  { keyword: 'share screen to multiple people', subreddits: ['Teachers','education','Professors','churchtech'],            product: 'Peekr' },
  { keyword: 'share photos with group',          subreddits: ['Teachers','photography','eventplanning','Weddings'],        product: 'Peekr' },
  { keyword: 'present from phone',               subreddits: ['Teachers','Professors','PublicSpeaking','education'],       product: 'Peekr' },
  { keyword: 'QR code presentation',            subreddits: ['Teachers','Professors','education','PublicSpeaking'],          product: 'Peekr' },
  { keyword: 'share PDF to class',              subreddits: ['Teachers','Professors','education'],                          product: 'Peekr' },
  { keyword: 'wireless presentation app',       subreddits: ['Teachers','AV','hometheater','techsupport'],                  product: 'Peekr' },
  { keyword: 'show photos without projector',   subreddits: ['Teachers','photography','Weddings','eventplanning'],          product: 'Peekr' },
  // High-volume additions — these subreddits have 10-100x more daily posts
  { keyword: 'no projector classroom',          subreddits: ['Teachers','education','Professors','SubstituteTeachers'],    product: 'Peekr' },
  { keyword: 'share slides with students',      subreddits: ['Teachers','Professors','education','OnlineLearning'],        product: 'Peekr' },
  { keyword: 'google classroom alternative',    subreddits: ['Teachers','education','Professors','edtech'],                product: 'Peekr' },
  { keyword: 'show video to class',             subreddits: ['Teachers','Professors','education'],                         product: 'Peekr' },
  { keyword: 'church presentation software',    subreddits: ['churchtech','Christianity','church','Reformed'],              product: 'Peekr' },
  { keyword: 'share photos at wedding',         subreddits: ['Weddings','wedding','weddingplanning','eventplanning'],      product: 'Peekr' },
  { keyword: 'display photos at event',         subreddits: ['eventplanning','Weddings','DIY','photography'],              product: 'Peekr' },
  { keyword: 'cast phone to screen',            subreddits: ['techsupport','Teachers','AV','hometheater'],                 product: 'Peekr' },
  { keyword: 'present without HDMI',            subreddits: ['Teachers','techsupport','AV','Professors'],                  product: 'Peekr' },

  // ── FIELDOPS — ebenova.net (enquiry: info@ebenova.net) ───────────────────
  // Operations platform for Nigerian service businesses (cleaning, logistics, facility mgmt)
  { keyword: 'cleaning business software',      subreddits: ['EntrepreneurRideAlong','smallbusiness','Entrepreneur'],       product: 'FieldOps' },
  { keyword: 'field service management',        subreddits: ['smallbusiness','Entrepreneur','startups'],                    product: 'FieldOps' },
  { keyword: 'managing cleaning staff',         subreddits: ['smallbusiness','EntrepreneurRideAlong','Nigeria'],            product: 'FieldOps' },
  { keyword: 'scheduling cleaning jobs',        subreddits: ['smallbusiness','cleaning','housekeeping'],                    product: 'FieldOps' },
  { keyword: 'running cleaning company nigeria',subreddits: ['Nigeria','lagos','naija'],                                    product: 'FieldOps' },
  { keyword: 'invoicing for service business',  subreddits: ['smallbusiness','freelance','Entrepreneur'],                   product: 'FieldOps' },
  { keyword: 'service business management app', subreddits: ['smallbusiness','Entrepreneur','startups'],                    product: 'FieldOps' },

]

// ── Approved subreddit whitelist ────────────────────────────────────────────
// Posts from ANY subreddit not on this list will be flagged DO NOT POST
// and will NOT receive an AI draft — no matter what keyword matched
const APPROVED_SUBREDDITS = new Set([
  // Signova
  'freelance','freelancers','smallbusiness','Entrepreneur','EntrepreneurRideAlong',
  'SoloDevelopment','agency','agencynewbies','Nigeria','lagos','naija','nairaland',
  'LandlordLady','webdev','SaaS','startups','IndieHackers','buildinpublic',
  // Peekr
  'Teachers','education','Professors','PublicSpeaking','churchtech',
  'photography','eventplanning','Weddings','AV','hometheater','techsupport',
  'SubstituteTeachers','OnlineLearning','edtech','wedding','weddingplanning',
  'Christianity','church','Reformed','DIY',
  // FieldOps
  'cleaning','housekeeping',
])

// ── Product context for reply drafts ─────────────────────────────────────────
const PRODUCT_CONTEXT = {
  Signova: {
    url: 'getsignova.com',
    description: 'Signova is an AI legal document generator. Users answer a few questions and get a professional document in under 3 minutes. 27 document types including NDAs, freelance contracts, tenancy agreements, privacy policies, and more. Free to preview, $4.99 to download. No account needed. Accepts card and USDT crypto. Serves Nigeria, Africa, and 180+ countries globally.',
    tone: 'You are a helpful Nigerian founder who built Signova after watching a friend get burned with no contract. You know legal document problems deeply. Never be salesy. Answer the person\'s actual problem first. Mention Signova at the end only if it genuinely helps.',
  },
  Peekr: {
    url: 'getpeekr.com',
    description: 'Peekr is a free iOS app that lets you share photos, videos, and PDFs from your iPhone to any room instantly. Viewers just scan a QR code — no app download needed on their end. Perfect for teachers, church leaders, presenters, and event hosts. Free tier available, premium unlocks video and PDF sharing.',
    tone: 'You are a helpful founder who built Peekr for teachers and presenters. Answer the person\'s sharing problem genuinely. Mention Peekr at the end only if it directly solves their situation.',
  },
  FieldOps: {
    url: 'ebenova.net',
    description: 'FieldOps is a web-based operations platform for Nigerian service businesses — cleaning companies, logistics firms, facility managers. It replaces WhatsApp group chats and paper records with a proper booking system, staff mobile app, job scheduling, and automated invoicing. Already live with a professional cleaning company in Calgary.',
    tone: 'You are a founder who built FieldOps for African service business owners. Be practical and understand their operational pain. Mention FieldOps at the end only if it genuinely fits their situation.',
  },
}

// ── Auto-draft a reply using Groq (free tier — Llama 3.3 70b) ────────────────
async function generateReplyDraft(post) {
  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) return null
  const ctx = PRODUCT_CONTEXT[post.product]
  if (!ctx) return null

  // Hard whitelist check — never draft for unapproved subreddits
  if (!APPROVED_SUBREDDITS.has(post.subreddit)) {
    console.log(`[monitor] SKIP (not whitelisted): r/${post.subreddit}`)
    return null
  }

  const prompt = `You are deciding whether a Reddit post is relevant enough to reply to for a specific product.

PRODUCT: ${post.product}
${ctx.description}

REDDIT POST:
Title: ${post.title}
Subreddit: r/${post.subreddit}
Body: ${post.body || '(no body text)'}

FIRST: Is this post DIRECTLY about a problem that ${post.product} solves?
- The person must actually have the problem, not just mention it in passing
- The subreddit must be relevant to the product's audience
- Gaming, entertainment, personal life, news, and general discussion posts are NEVER relevant

If NOT directly relevant, you MUST respond with only the word: SKIP

If YES it is directly relevant, write a short helpful Reddit reply (3-5 sentences):
- Answer their actual problem first with genuine advice
- Sound like a real person, not a marketer
- Mention ${post.product} (${ctx.url}) only at the very end, naturally
- Plain text only, no bullet points or headers

Response:`

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const text = data.choices?.[0]?.message?.content?.trim() || null
    if (!text || text === 'SKIP') return null
    return text
  } catch {
    return null
  }
}

// ── Nairaland keywords ──────────────────────────────────────────────────────
// Nairaland sections: Business, Properties, Career, Computers, Nairaland
const NAIRALAND_KEYWORDS = [
  { keyword: 'contract template',       section: 'business',    product: 'Signova'  },
  { keyword: 'tenancy agreement',       section: 'properties',  product: 'Signova'  },
  { keyword: 'client refused to pay',   section: 'business',    product: 'Signova'  },
  { keyword: 'deed of assignment',      section: 'properties',  product: 'Signova'  },
  { keyword: 'freelance contract',      section: 'career',      product: 'Signova'  },
  { keyword: 'NDA agreement',           section: 'business',    product: 'Signova'  },
  { keyword: 'quit notice',             section: 'properties',  product: 'Signova'  },
  { keyword: 'legal document',          section: 'business',    product: 'Signova'  },
  { keyword: 'share to classroom',      section: 'education',   product: 'Peekr'    },
  { keyword: 'cleaning company lagos',  section: 'business',    product: 'FieldOps' },
  { keyword: 'facility management',     section: 'business',    product: 'FieldOps' },
]

// ── Seen post tracker — persists in memory, resets on restart ────────────────
const seenIds = new Set()
const seenNairalandIds = new Set()

// ── Reddit search — public JSON endpoint, no auth needed ─────────────────────
async function searchReddit(keyword, subreddits) {
  const results = []
  const encodedKeyword = encodeURIComponent(keyword)

  const urls = subreddits && subreddits.length > 0
    ? subreddits.map(sr =>
        `https://www.reddit.com/r/${sr}/search.json?q=${encodedKeyword}&sort=new&limit=10&t=day&restrict_sr=1`
      )
    : [`https://www.reddit.com/search.json?q=${encodedKeyword}&sort=new&limit=10&t=day`]

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'reddit-monitor/1.0 (keyword alert bot)' }
      })
      if (!res.ok) continue
      const data = await res.json()
      const posts = data?.data?.children || []

      for (const post of posts) {
        const p = post.data
        if (seenIds.has(p.id)) continue
        const createdAt = p.created_utc * 1000
        const ageMs = Date.now() - createdAt
        // Only alert on posts from last 60 minutes — guards against restarts missing content
        if (ageMs > 60 * 60 * 1000) continue
        seenIds.add(p.id)
        results.push({
          id:        p.id,
          title:     p.title || p.body?.slice(0, 100) || '(no title)',
          url:       `https://reddit.com${p.permalink}`,
          subreddit: p.subreddit,
          author:    p.author,
          score:     p.score,
          comments:  p.num_comments,
          body:      (p.selftext || p.body || '').slice(0, 300),
          createdAt: new Date(createdAt).toUTCString(),
          keyword,
          approved:  APPROVED_SUBREDDITS.has(p.subreddit),
        })
      }
    } catch (err) {
      console.error(`[monitor] fetch error for "${keyword}":`, err.message)
    }

    // Polite delay between requests — avoid rate limiting
    await delay(1200)
  }

  return results
}

// ── Email digest builder ──────────────────────────────────────────────────────
function buildEmailHtml(matches) {
  // Group by product first, then by keyword within product
  const byProduct = {}
  for (const m of matches) {
    const prod = m.product || 'General'
    if (!byProduct[prod]) byProduct[prod] = {}
    if (!byProduct[prod][m.keyword]) byProduct[prod][m.keyword] = []
    byProduct[prod][m.keyword].push(m)
  }

  const PRODUCT_LINKS = {
    'Signova':  'https://getsignova.com',
    'Peekr':    'https://getpeekr.com',
    'FieldOps': 'mailto:info@ebenova.net',
  }

  const productSections = Object.entries(byProduct).map(([product, keywords]) => {
    const totalForProduct = Object.values(keywords).flat().length
    const keywordSections = Object.entries(keywords).map(([keyword, posts]) => {
      const items = posts.map(p => `
        <div style="margin-bottom:20px;padding:14px;background:#f9f9f9;border-left:4px solid #c9a84c;border-radius:4px;">
          <div style="font-size:12px;color:#888;margin-bottom:5px;">
            r/${p.subreddit} · u/${p.author} · ${p.score} upvotes · ${p.comments} comments
          </div>
          <a href="${p.url}" style="font-size:15px;font-weight:600;color:#1a1a1a;text-decoration:none;">${p.title}</a>
          ${p.body ? `<p style="font-size:13px;color:#555;margin:7px 0 0;line-height:1.5;">${p.body}${p.body.length >= 300 ? '…' : ''}</p>` : ''}
          <a href="${p.url}" style="display:inline-block;margin-top:8px;font-size:12px;color:#c9a84c;font-weight:600;">Open thread →</a>
          ${!p.approved ? `
          <div style="margin-top:10px;padding:8px 12px;background:#fdecea;border:1px solid #f5c6cb;border-radius:6px;font-size:12px;font-weight:700;color:#c0392b;">
            ⚠️ DO NOT POST — r/${p.subreddit} is not an approved subreddit
          </div>` : ''}
          ${p.draft ? `
          <div style="margin-top:12px;padding:12px;background:#fffdf0;border:1px solid #e8d87a;border-radius:6px;">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#a08c00;margin-bottom:6px;">✏️ Suggested reply</div>
            <div style="font-size:13px;color:#333;line-height:1.6;white-space:pre-wrap;">${p.draft}</div>
          </div>` : ''}
        </div>
      `).join('')
      return `
        <div style="margin-bottom:24px;">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#aaa;margin-bottom:10px;">
            "${keyword}" (${posts.length})
          </div>
          ${items}
        </div>
      `
    }).join('')

    return `
      <div style="margin-bottom:40px;padding:20px;background:#fff;border:1px solid #eee;border-radius:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;padding-bottom:12px;border-bottom:2px solid #c9a84c;">
          <div>
            <div style="font-size:18px;font-weight:700;color:#1a1a1a;">${product}</div>
            <div style="font-size:12px;color:#888;margin-top:2px;">${totalForProduct} new mention${totalForProduct !== 1 ? 's' : ''}</div>
          </div>
          <a href="${PRODUCT_LINKS[product] || '#'}" style="font-size:12px;color:#c9a84c;font-weight:600;text-decoration:none;">Visit site →</a>
        </div>
        ${keywordSections}
      </div>
    `
  }).join('')

  return `
    <!DOCTYPE html>
    <html>
    <body style="font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:32px 24px;background:#f5f5f5;color:#1a1a1a;">
      <div style="margin-bottom:28px;padding:20px 24px;background:#0e0e0e;border-radius:8px;">
        <div style="font-size:20px;font-weight:700;color:#f0ece4;">📡 Ebenova Reddit Monitor</div>
        <div style="font-size:13px;color:#9a9690;margin-top:6px;">
          ${matches.length} new mention${matches.length !== 1 ? 's' : ''} across ${Object.keys(byProduct).length} product${Object.keys(byProduct).length !== 1 ? 's' : ''} · ${new Date().toUTCString()}
        </div>
      </div>
      ${productSections}
      <div style="margin-top:32px;font-size:11px;color:#aaa;text-align:center;">
        Ebenova Reddit Monitor · Railway · Edit keywords in monitor.js
      </div>
    </body>
    </html>
  `
}

// ── Nairaland search — scrapes public search HTML ──────────────────────────
async function searchNairaland(keyword, section) {
  const results = []
  const encoded = encodeURIComponent(keyword)
  const url = `https://www.nairaland.com/search/posts/${encoded}/${section}/0/0`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EbenovaMonitor/1.0)', 'Accept': 'text/html' }
    })
    if (!res.ok) return results
    const html = await res.text()
    const postPattern = /<td[^>]*>\s*<b>\s*<a href="(\/[^"]+)"[^>]*>([^<]+)<\/a>/gi
    const seen = new Set()
    let match
    while ((match = postPattern.exec(html)) !== null) {
      const path = match[1]
      const title = match[2].trim()
      if (!path || !title || path.length < 5) continue
      const id = `nl_${path.replace(/\//g, '_')}`
      if (seenNairalandIds.has(id) || seen.has(id)) continue
      seen.add(id)
      seenNairalandIds.add(id)
      const matchIdx = postPattern.lastIndex
      const snippet = html.slice(matchIdx, matchIdx + 500)
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280)
      results.push({
        id, title,
        url: `https://www.nairaland.com${path}`,
        subreddit: `Nairaland / ${section}`,
        author: 'nairaland',
        score: 0, comments: 0,
        body: snippet,
        createdAt: new Date().toUTCString(),
        keyword, source: 'nairaland', approved: true,
      })
      if (results.length >= 5) break
    }
  } catch (err) {
    console.error(`[nairaland] fetch error for "${keyword}":`, err.message)
  }
  return results
}

// ── Send alert email ──────────────────────────────────────────────────────────
async function sendAlert(matches) {
  if (!RESEND_API_KEY) {
    console.log('[monitor] No RESEND_API_KEY set — printing matches to console instead:')
    for (const m of matches) console.log(`  [${m.keyword}] ${m.title} — ${m.url}`)
    return
  }

  const keywords = [...new Set(matches.map(m => m.keyword))]
  const hasNairaland = matches.some(m => m.source === 'nairaland')
  const platform = hasNairaland ? 'Reddit + Nairaland' : 'Reddit'
  const subject  = `${platform}: ${matches.length} new mention${matches.length !== 1 ? 's' : ''} — ${keywords.slice(0, 3).join(', ')}${keywords.length > 3 ? '…' : ''}`

  try {
    await resend.emails.send({
      from:    `Signova Monitor <${FROM_EMAIL}>`,
      to:      ALERT_EMAIL,
      subject,
      html:    buildEmailHtml(matches),
    })
    console.log(`[monitor] Alert sent — ${matches.length} matches across ${keywords.length} keywords`)
  } catch (err) {
    console.error('[monitor] Failed to send email:', err.message)
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms))

// ── Main poll cycle ───────────────────────────────────────────────────────────
async function poll() {
  console.log(`[monitor] Polling Reddit — ${new Date().toUTCString()}`)
  const allMatches = []

  // Reddit
  for (const { keyword, subreddits, product } of KEYWORDS) {
    const matches = await searchReddit(keyword, subreddits)
    if (matches.length > 0) {
      matches.forEach(m => { m.product = product })
      console.log(`[monitor] Reddit "${keyword}": ${matches.length} new`)
      allMatches.push(...matches)
    }
    await delay(2000)
  }

  // Nairaland
  for (const { keyword, section, product } of NAIRALAND_KEYWORDS) {
    const matches = await searchNairaland(keyword, section)
    if (matches.length > 0) {
      matches.forEach(m => { m.product = product })
      console.log(`[monitor] Nairaland "${keyword}": ${matches.length} new`)
      allMatches.push(...matches)
    }
    await delay(3000)
  }

  if (allMatches.length > 0) {
    console.log(`[monitor] Total new matches: ${allMatches.length} — generating reply drafts…`)

    // Generate drafts with concurrency limit of 3 to avoid API rate limits
    const CONCURRENCY = 3
    for (let i = 0; i < allMatches.length; i += CONCURRENCY) {
      const batch = allMatches.slice(i, i + CONCURRENCY)
      await Promise.all(batch.map(async m => {
        m.draft = await generateReplyDraft(m)
        if (m.draft) console.log(`[monitor] Draft generated for: "${m.title.slice(0, 60)}…"`)
      }))
      if (i + CONCURRENCY < allMatches.length) await delay(1000)
    }

    console.log(`[monitor] Sending alert email…`)
    await sendAlert(allMatches)
  } else {
    console.log('[monitor] No new matches this cycle')
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
console.log('━'.repeat(60))
console.log('  Ebenova Social Monitor (Reddit + Nairaland)')
console.log(`  Reddit: ${KEYWORDS.length} keywords · Nairaland: ${NAIRALAND_KEYWORDS.length} keywords`)
console.log(`  Polling every ${POLL_MINUTES} minutes`)
console.log(`  Alerts → ${ALERT_EMAIL}`)
console.log(`  AI drafts → ${process.env.GROQ_API_KEY ? 'ON (Groq / Llama 3.3)' : 'OFF (set GROQ_API_KEY)'}`)
if (!process.env.GROQ_API_KEY) {
  console.warn('  ⚠️  GROQ_API_KEY is not set — reply drafts will be SKIPPED for all matches')
  console.warn('     Add GROQ_API_KEY to Railway Variables to enable AI reply drafts')
}
if (!process.env.RESEND_API_KEY) {
  console.warn('  ⚠️  RESEND_API_KEY is not set — email alerts will be printed to console only')
}
console.log('━'.repeat(60))

// Run once immediately on startup
poll()

// Then run on schedule
const cronExpression = `*/${POLL_MINUTES} * * * *`
cron.schedule(cronExpression, poll)
console.log(`[monitor] Cron scheduled: ${cronExpression}`)
