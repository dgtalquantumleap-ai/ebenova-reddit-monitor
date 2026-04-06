// reddit-monitor/apify-actor.js
// Apify Actor — Reddit Brand Monitor + AI Reply Drafter
//
// Wraps the existing searchReddit(), searchNairaland(), and generateReplyDraft()
// logic from monitor.js/monitor-v2.js into Apify's input/output format.
//
// Runs once per Actor invocation (no cron, no Redis, no email).
// Pushes structured results to the default Apify dataset via Actor.pushData().
//
// Usage:
//   apify run --input '{"keywords":["freelance contract"],"productContext":"I build freelance contract templates.","maxPostAgeHours":24,"includeNairaland":true,"generateReplies":true}'

import { Actor } from 'apify'

await Actor.init()

// ── Read user input ──────────────────────────────────────────────────────────
const input = await Actor.getInput()

const {
  keywords = [],            // string[] or [{ keyword, subreddits?, nairalandSection? }]
  productContext = '',      // string — describes the product/expertise for AI drafts
  maxPostAgeHours = 24,     // number — only return posts newer than this
  includeNairaland = false, // boolean — also search Nairaland
  generateReplies = true,   // boolean — generate AI reply drafts for approved posts
  groqApiKey = '',          // string — optional, user's own Groq key (or set via APIFY env vars)
} = input || {}

// Validate
if (!keywords || keywords.length === 0) {
  throw new Error('Input must include at least one keyword (string or object with "keyword" field).')
}

// Normalize keywords to consistent shape: { keyword, subreddits?, nairalandSection? }
const normalizedKeywords = keywords.map(k =>
  typeof k === 'string' ? { keyword: k } : k
)

const GROQ_API_KEY = groqApiKey || process.env.GROQ_API_KEY || ''
const MAX_AGE_MS = maxPostAgeHours * 60 * 60 * 1000

// ── Approved subreddits — never draft a reply if not on this list ─────────────
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
  'cscareerquestions','cscareeradvice','ExperiencedDevs','forhire',
  'MachineLearning','learnmachinelearning','datascience','MLjobs',
  'recruitinghell','jobsearchhacks','jobs','remotework','techjobs',
  'YCombinator','venturecapital','angels','product_management','ProductManagement',
  'graphic_design','writing','copywriting','videography','marketing',
  'socialmediamanagement','malelivingspace','digitalnomad','workingdigitalnomad',
  'legal','automation','Content_marketing',
])

// ── Utility ───────────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms))

// Deduplicate results by post ID across all keyword searches
const seenIds = new Set()

// ── Reddit search (from monitor-v2.js, unchanged logic) ──────────────────────
async function searchReddit(keywordEntry) {
  const { keyword, subreddits = [] } = keywordEntry
  const results = []
  const encoded = encodeURIComponent(keyword)

  const urls = subreddits.length > 0
    ? subreddits.map(sr =>
        `https://www.reddit.com/r/${sr}/search.json?q=${encoded}&sort=new&limit=25&t=week&restrict_sr=1`
      )
    : [`https://www.reddit.com/search.json?q=${encoded}&sort=new&limit=25&t=week`]

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'reddit-brand-monitor/1.0 (apify-actor)' },
      })
      if (!res.ok) {
        console.warn(`[actor]   Reddit returned ${res.status} for "${keyword}" — skipping`)
        await delay(5000)
        continue
      }
      const data = await res.json()
      const posts = data?.data?.children || []
      const subredditName = url.includes('/r/') ? url.split('/r/')[1].split('/')[0] : 'all'
      console.log(`[actor]   "${keyword}" in r/${subredditName} → ${posts.length} posts`)

      for (const post of posts) {
        const p = post.data
        if (seenIds.has(p.id)) continue
        const ageMs = Date.now() - p.created_utc * 1000
        if (ageMs > MAX_AGE_MS) continue
        seenIds.add(p.id)
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
          postAgeHours: Math.round(ageMs / (60 * 60 * 1000)),
        })
      }
    } catch (err) {
      console.error(`[actor] Reddit fetch error "${keyword}":`, err.message)
    }
    await delay(1500)
  }
  return results
}

// ── Nairaland search (from monitor-v2.js, unchanged logic) ───────────────────
async function searchNairaland(keywordEntry) {
  const { keyword, nairalandSection = 'business' } = keywordEntry
  const results = []
  const encoded = encodeURIComponent(keyword)
  const url = `https://www.nairaland.com/search/posts/${encoded}/${nairalandSection}/0/0`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RedditBrandMonitor/1.0)', 'Accept': 'text/html' },
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
      if (seenIds.has(id) || seen.has(id)) continue
      seen.add(id)
      seenIds.add(id)
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
        postAgeHours: 0,
      })
      if (results.length >= 5) break
    }
  } catch (err) {
    console.error(`[actor] Nairaland fetch error "${keyword}":`, err.message)
  }
  return results
}

// ── AI reply draft (from monitor-v2.js, unchanged logic) ─────────────────────
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

// ── Main execution ───────────────────────────────────────────────────────────
console.log(`[actor] Starting Reddit Brand Monitor — ${normalizedKeywords.length} keyword(s)`)
console.log(`[actor] Max post age: ${maxPostAgeHours}h | Nairaland: ${includeNairaland} | AI replies: ${generateReplies}`)

const allResults = []

for (const kw of normalizedKeywords) {
  console.log(`[actor] Searching: "${kw.keyword}"…`)

  // Reddit — push results immediately so a timeout doesn't lose them
  const redditMatches = await searchReddit(kw)
  for (const m of redditMatches) {
    if (generateReplies) {
      m.draft = await generateReplyDraft(m, productContext)
      if (m.draft) console.log(`[actor]   Draft: "${m.title.slice(0, 55)}…"`)
      await delay(800)
    }
    await Actor.pushData({
      id: m.id, title: m.title, url: m.url, subreddit: m.subreddit,
      author: m.author, score: m.score, comments: m.comments, body: m.body,
      createdAt: m.createdAt, keyword: m.keyword, source: m.source,
      approved: m.approved, postAgeHours: m.postAgeHours, draft: m.draft || null,
    })
    allResults.push(m)
  }
  if (redditMatches.length > 0) console.log(`[actor]   Reddit: ${redditMatches.length} saved`)

  // Nairaland (optional) — same pattern
  if (includeNairaland) {
    const nlMatches = await searchNairaland(kw)
    for (const m of nlMatches) {
      if (generateReplies) {
        m.draft = await generateReplyDraft(m, productContext)
        if (m.draft) console.log(`[actor]   Draft: "${m.title.slice(0, 55)}…"`)
        await delay(800)
      }
      await Actor.pushData({
        id: m.id, title: m.title, url: m.url, subreddit: m.subreddit,
        author: m.author, score: m.score, comments: m.comments, body: m.body,
        createdAt: m.createdAt, keyword: m.keyword, source: m.source,
        approved: m.approved, postAgeHours: m.postAgeHours, draft: m.draft || null,
      })
      allResults.push(m)
    }
    if (nlMatches.length > 0) console.log(`[actor]   Nairaland: ${nlMatches.length} saved`)
    await delay(2000)
  }
}

console.log(`[actor] Done — ${allResults.length} result(s) pushed to dataset`)

if (allResults.length === 0) {
  console.log('[actor] No matching posts found in the specified time window.')
  console.log(`[actor] Try increasing maxPostAgeHours (currently ${maxPostAgeHours}h) or broadening keywords.`)
}

await Actor.exit()
