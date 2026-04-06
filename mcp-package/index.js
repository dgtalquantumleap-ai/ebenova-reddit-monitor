#!/usr/bin/env node
// @ebenova/reddit-monitor-mcp
// Reddit & Nairaland Brand Monitor — MCP Server (stdio transport)
//
// Exposes keyword search + AI reply draft generation as MCP tools
// for AI agents (Claude Desktop, Cursor, Windsurf, etc.).
//
// Usage:
//   npx -y @ebenova/reddit-monitor-mcp
//
// Optional env: GROQ_API_KEY (for AI reply drafts — search works without it)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// ── Approved subreddits for brand mentions ───────────────────────────────────
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

const GROQ_API_KEY = process.env.GROQ_API_KEY || ''
const delay = ms => new Promise(r => setTimeout(r, ms))

// ── Reddit search ────────────────────────────────────────────────────────────
async function searchReddit(keywords, { maxPostAgeHours = 24, subreddits = [] } = {}) {
  const results = []
  const seenIds = new Set()
  const maxAgeMs = maxPostAgeHours * 60 * 60 * 1000
  const kwList = typeof keywords === 'string' ? [keywords] : keywords

  for (const keyword of kwList) {
    const encoded = encodeURIComponent(keyword)
    const urls = subreddits.length > 0
      ? subreddits.map(sr =>
          `https://www.reddit.com/r/${sr}/search.json?q=${encoded}&sort=new&limit=10&t=day&restrict_sr=1`
        )
      : [`https://www.reddit.com/search.json?q=${encoded}&sort=new&limit=10&t=day`]

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'ebenova-reddit-monitor-mcp/1.0' },
        })
        if (!res.ok) { await delay(3000); continue }
        const data = await res.json()
        const posts = data?.data?.children || []

        for (const post of posts) {
          const p = post.data
          if (seenIds.has(p.id)) continue
          const ageMs = Date.now() - p.created_utc * 1000
          if (ageMs > maxAgeMs) continue
          seenIds.add(p.id)
          results.push({
            id: p.id,
            title: p.title || '(no title)',
            url: `https://reddit.com${p.permalink}`,
            subreddit: p.subreddit,
            author: p.author,
            score: p.score,
            comments: p.num_comments,
            body: (p.selftext || '').slice(0, 600),
            createdAt: new Date(p.created_utc * 1000).toISOString(),
            keyword,
            source: 'reddit',
            approved: APPROVED_SUBREDDITS.has(p.subreddit),
            postAgeHours: Math.round(ageMs / (60 * 60 * 1000)),
          })
        }
      } catch (err) {
        console.error(`[search] Reddit fetch error for "${keyword}":`, err.message)
      }
      await delay(2000)
    }
  }
  return results
}

// ── Nairaland search ─────────────────────────────────────────────────────────
async function searchNairaland(keywords, { nairalandSection = 'business' } = {}) {
  const results = []
  const seenIds = new Set()
  const kwList = typeof keywords === 'string' ? [keywords] : keywords

  for (const keyword of kwList) {
    const encoded = encodeURIComponent(keyword)
    const url = `https://www.nairaland.com/search/posts/${encoded}/${nairalandSection}/0/0`
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EbenovaMonitor/1.0)', 'Accept': 'text/html' },
      })
      if (!res.ok) continue
      const html = await res.text()
      const pattern = /<td[^>]*>\s*<b>\s*<a href="(\/[^"]+)"[^>]*>([^<]+)<\/a>/gi
      const seen = new Set()
      let match
      while ((match = pattern.exec(html)) !== null) {
        const path = match[1]
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
          url: `https://www.nairaland.com${path}`,
          subreddit: `Nairaland/${nairalandSection}`,
          author: 'nairaland',
          score: 0, comments: 0,
          body: snippet,
          createdAt: new Date().toISOString(),
          keyword, source: 'nairaland', approved: true,
          postAgeHours: 0,
        })
        if (results.length >= 5) break
      }
    } catch (err) {
      console.error(`[search] Nairaland fetch error for "${keyword}":`, err.message)
    }
    await delay(3000)
  }
  return results
}

// ── AI reply draft ───────────────────────────────────────────────────────────
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

SKIP FILTER:
Respond ONLY with the word SKIP if ANY are true:
- Post is emotional, relational, or venting
- Keyword matched incidentally
- The post is clearly from a bot or spam
- Mentioning a product would feel like an ad
- Post is about something unrelated to your expertise

REPLY (if not skipping):
Write a helpful 2-4 sentence reply as a community member.
- Casual, direct tone
- Give real advice first. Only mention your product if it naturally fits.
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

// ── MCP Server ───────────────────────────────────────────────────────────────
const server = new McpServer({
  name: '@ebenova/reddit-monitor-mcp',
  version: '1.0.0',
})

// Tool 1: Search Reddit for keywords
server.tool(
  'search_reddit',
  'Search Reddit for recent posts matching given keywords. Returns structured results with post metadata, subreddit approval status, and age.',
  {
    keywords: z.array(z.string()).describe('Keywords to search for (e.g. ["freelance contract", "NDA template"])'),
    subreddits: z.array(z.string()).optional().describe('Optional: specific subreddits to search within. If omitted, searches all of Reddit.'),
    maxPostAgeHours: z.number().optional().default(24).describe('Only return posts newer than this many hours. Default: 24.'),
  },
  async ({ keywords, subreddits, maxPostAgeHours }) => {
    const results = await searchReddit(keywords, { subreddits, maxPostAgeHours })
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          totalMatches: results.length,
          results: results.map(r => ({
            title: r.title, url: r.url, subreddit: r.subreddit,
            author: r.author, score: r.score, comments: r.comments,
            body: r.body, keyword: r.keyword, approved: r.approved,
            postAgeHours: r.postAgeHours,
          })),
        }, null, 2),
      }],
    }
  }
)

// Tool 2: Search Reddit + Nairaland with AI reply drafts
server.tool(
  'monitor_keywords',
  'Search Reddit and optionally Nairaland for keyword mentions. Filters by approved subreddits and generates AI-drafted replies ready to post. Requires GROQ_API_KEY for drafts.',
  {
    keywords: z.array(z.string()).describe('Keywords to monitor'),
    productContext: z.string().describe('Describe your product/expertise for AI reply generation'),
    maxPostAgeHours: z.number().optional().default(24).describe('Only return posts newer than this many hours'),
    includeNairaland: z.boolean().optional().default(false).describe('Also search Nairaland'),
    generateReplies: z.boolean().optional().default(true).describe('Generate AI reply drafts for approved posts'),
  },
  async ({ keywords, productContext, maxPostAgeHours, includeNairaland, generateReplies }) => {
    const redditResults = await searchReddit(keywords, { maxPostAgeHours })
    let nairalandResults = []
    if (includeNairaland) {
      nairalandResults = await searchNairaland(keywords)
    }
    const allResults = [...redditResults, ...nairalandResults]

    if (generateReplies) {
      for (const post of allResults) {
        post.draft = await generateReplyDraft(post, productContext)
        await delay(500)
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          totalMatches: allResults.length,
          matchesWithDrafts: allResults.filter(m => m.draft).length,
          redditMatches: redditResults.length,
          nairalandMatches: nairalandResults.length,
          results: allResults.map(r => ({
            title: r.title, url: r.url, subreddit: r.subreddit,
            source: r.source, author: r.author, score: r.score,
            comments: r.comments, body: r.body, keyword: r.keyword,
            approved: r.approved, postAgeHours: r.postAgeHours,
            draft: r.draft || null,
          })),
        }, null, 2),
      }],
    }
  }
)

// Tool 3: Generate AI reply draft for a specific post
server.tool(
  'generate_reply_draft',
  'Generate an AI reply draft for a specific Reddit post. Returns SKIP if the post is not a good fit. Requires GROQ_API_KEY.',
  {
    postTitle: z.string().describe('Title of the Reddit post'),
    postBody: z.string().describe('Body text of the Reddit post'),
    subreddit: z.string().describe('The subreddit the post was made in'),
    productContext: z.string().describe('Describe your product/expertise for generating a relevant reply'),
  },
  async ({ postTitle, postBody, subreddit, productContext }) => {
    const isApproved = APPROVED_SUBREDDITS.has(subreddit)
    const draft = await generateReplyDraft({
      title: postTitle, body: postBody, subreddit, approved: isApproved,
    }, productContext)
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          approved: isApproved,
          draft: draft || null,
          message: draft
            ? 'Draft generated successfully.'
            : isApproved
              ? 'No draft generated — AI determined this post is not a good fit (SKIP).'
              : `r/${subreddit} is not in the approved subreddit list. No draft generated.`,
        }, null, 2),
      }],
    }
  }
)

// Tool 4: Check if subreddits are approved for brand mentions
server.tool(
  'check_subreddit_approval',
  'Check if subreddits are in the approved list for brand mentions. Returns approval status and the full approved list.',
  {
    subreddits: z.array(z.string()).describe('Subreddit names to check (without r/ prefix)'),
  },
  async ({ subreddits }) => {
    const checks = subreddits.map(sr => ({
      subreddit: sr,
      approved: APPROVED_SUBREDDITS.has(sr),
    }))
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          checks,
          approvedCount: APPROVED_SUBREDDITS.size,
          approvedSubreddits: Array.from(APPROVED_SUBREDDITS).sort(),
        }, null, 2),
      }],
    }
  }
)

// ── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[mcp] @ebenova/reddit-monitor-mcp running on stdio')
