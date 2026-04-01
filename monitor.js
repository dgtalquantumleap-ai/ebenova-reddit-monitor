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

// ── Memory monitoring — log every 5 minutes ──────────────────────────────────
setInterval(() => {
  const used = process.memoryUsage()
  const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024)
  const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024)
  const rssMB = Math.round(used.rss / 1024 / 1024)
  console.log(`[monitor] 📊 Memory: Heap ${heapUsedMB}/${heapTotalMB}MB | RSS ${rssMB}MB`)
}, 300000) // 5 minutes

const RESEND_API_KEY = process.env.RESEND_API_KEY
const GROQ_API_KEY   = process.env.GROQ_API_KEY
const ALERT_EMAIL    = process.env.ALERT_EMAIL    || 'info@ebenova.net'
const FROM_EMAIL        = process.env.FROM_EMAIL      || 'monitor@getsignova.com'
const POLL_MINUTES      = parseInt(process.env.POLL_INTERVAL_MINUTES || '15')

// ── Memory optimization: max posts to keep in memory ─────────────────────────
const MAX_POSTS_IN_MEMORY = 10000

const resend = new Resend(RESEND_API_KEY)

// ── Keywords to monitor ───────────────────────────────────────────────────────
// Each entry: { keyword, subreddits (optional — omit to search all of Reddit), product }
const KEYWORDS = [

  // ── SIGNOVA — getsignova.com ─────────────────────────────────────────────
  // Legal document generator for freelancers, small businesses, Nigeria/Africa

  // — Already-aware keywords (person knows what they need) —
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

  // — Trigger-moment keywords (person has the problem, doesn't know the solution yet) —
  { keyword: 'client refused to pay',      subreddits: ['freelance','freelancers','smallbusiness','Entrepreneur'],        product: 'Signova' },
  { keyword: 'no written contract',        subreddits: ['freelance','freelancers','smallbusiness','Entrepreneur'],        product: 'Signova' },
  { keyword: 'nothing in writing',         subreddits: ['freelance','smallbusiness','Entrepreneur'],                      product: 'Signova' },
  { keyword: 'tenant refuses to leave',    subreddits: ['Nigeria','lagos','LandlordLady','naija'],                        product: 'Signova' },
  { keyword: 'landlord problem nigeria',   subreddits: ['Nigeria','lagos','naija','nairaland'],                           product: 'Signova' },
  { keyword: 'how to protect my work',     subreddits: ['freelance','freelancers','SoloDevelopment','Entrepreneur'],      product: 'Signova' },
  { keyword: 'privacy policy for my app',  subreddits: ['webdev','SaaS','startups','androiddev','iOSProgramming'],        product: 'Signova' },
  { keyword: 'terms and conditions website',subreddits: ['webdev','SaaS','startups','Entrepreneur','smallbusiness'],      product: 'Signova' },
  { keyword: 'business partnership nigeria',subreddits: ['Nigeria','lagos','naija','Entrepreneur','smallbusiness'],       product: 'Signova' },
  { keyword: 'new client contract',        subreddits: ['freelance','freelancers','agency','agencynewbies'],              product: 'Signova' },

  // — Lagos Tenancy Bill 2025 — active legislation creating immediate search demand —
  { keyword: 'tenancy bill lagos',           subreddits: ['Nigeria','lagos','naija','nairaland'],                          product: 'Signova' },
  { keyword: 'rent increase lagos',          subreddits: ['Nigeria','lagos','naija'],                                      product: 'Signova' },
  { keyword: 'landlord eviction nigeria',    subreddits: ['Nigeria','lagos','naija','LandlordLady'],                       product: 'Signova' },

  // — WhatsApp negotiation pain points (Signova's unique feature) —
  { keyword: 'agreed on whatsapp no contract', subreddits: ['freelance','freelancers','Nigeria','smallbusiness'],          product: 'Signova' },
  { keyword: 'client changed price after',     subreddits: ['freelance','freelancers','smallbusiness','Entrepreneur'],     product: 'Signova' },
  { keyword: 'no written agreement dispute',   subreddits: ['freelance','smallbusiness','Entrepreneur','Nigeria'],         product: 'Signova' },
  { keyword: 'paid upfront no contract',       subreddits: ['freelance','smallbusiness','Nigeria','lagos'],                product: 'Signova' },
  { keyword: 'verbal deal gone wrong',         subreddits: ['freelance','smallbusiness','Entrepreneur','Nigeria'],         product: 'Signova' },

  // ── PEEKR — getpeekr.com ─────────────────────────────────────────────────
  // Share photos/videos/PDFs from iPhone to a room via QR — no app for viewers

  // — Already-aware keywords —
  { keyword: 'share screen to multiple people', subreddits: ['Teachers','education','Professors','churchtech'],            product: 'Peekr' },
  { keyword: 'share photos with group',          subreddits: ['Teachers','photography','eventplanning','Weddings'],        product: 'Peekr' },
  { keyword: 'present from phone',               subreddits: ['Teachers','Professors','PublicSpeaking','education'],       product: 'Peekr' },
  { keyword: 'QR code presentation',            subreddits: ['Teachers','Professors','education','PublicSpeaking'],          product: 'Peekr' },
  { keyword: 'share PDF to class',              subreddits: ['Teachers','Professors','education'],                          product: 'Peekr' },
  { keyword: 'wireless presentation app',       subreddits: ['Teachers','AV','hometheater','techsupport'],                  product: 'Peekr' },
  { keyword: 'show photos without projector',   subreddits: ['Teachers','photography','Weddings','eventplanning'],          product: 'Peekr' },
  { keyword: 'no projector classroom',          subreddits: ['Teachers','education','Professors','SubstituteTeachers'],    product: 'Peekr' },
  { keyword: 'share slides with students',      subreddits: ['Teachers','Professors','education','OnlineLearning'],        product: 'Peekr' },
  { keyword: 'google classroom alternative',    subreddits: ['Teachers','education','Professors','edtech'],                product: 'Peekr' },
  { keyword: 'show video to class',             subreddits: ['Teachers','Professors','education'],                         product: 'Peekr' },
  { keyword: 'church presentation software',    subreddits: ['churchtech','Christianity','church','Reformed'],              product: 'Peekr' },
  { keyword: 'share photos at wedding',         subreddits: ['Weddings','wedding','weddingplanning','eventplanning'],      product: 'Peekr' },
  { keyword: 'display photos at event',         subreddits: ['eventplanning','Weddings','DIY','photography'],              product: 'Peekr' },
  { keyword: 'cast phone to screen',            subreddits: ['techsupport','Teachers','AV','hometheater'],                 product: 'Peekr' },
  { keyword: 'present without HDMI',            subreddits: ['Teachers','techsupport','AV','Professors'],                  product: 'Peekr' },

  // — Trigger-moment keywords (person has the problem, doesn't know Peekr exists) —
  { keyword: 'share screen without cable',      subreddits: ['Teachers','techsupport','AV','Professors','education'],     product: 'Peekr' },
  { keyword: 'show phone screen to class',      subreddits: ['Teachers','education','Professors'],                        product: 'Peekr' },
  { keyword: 'church screen sharing',           subreddits: ['churchtech','Christianity','church','Reformed'],             product: 'Peekr' },
  { keyword: 'photographer share photos live',  subreddits: ['photography','weddingphotography','Weddings','eventplanning'], product: 'Peekr' },
  { keyword: 'live slideshow wedding',          subreddits: ['Weddings','weddingplanning','eventplanning','photography'],  product: 'Peekr' },
  { keyword: 'present without laptop',          subreddits: ['Teachers','PublicSpeaking','techsupport','Professors'],     product: 'Peekr' },
  { keyword: 'how to show students my phone',   subreddits: ['Teachers','education','Professors','SubstituteTeachers'],   product: 'Peekr' },
  { keyword: 'screen mirroring without app',    subreddits: ['techsupport','Teachers','AV','hometheater'],                product: 'Peekr' },
  { keyword: 'share video with audience',       subreddits: ['Teachers','PublicSpeaking','eventplanning','AV'],           product: 'Peekr' },

  // — Church and photography trigger moments from market research —
  { keyword: 'show lyrics on screen church',    subreddits: ['churchtech','Christianity','church','Reformed'],             product: 'Peekr' },
  { keyword: 'worship display small church',    subreddits: ['churchtech','Christianity','church','Reformed'],             product: 'Peekr' },
  { keyword: 'photographer live preview',       subreddits: ['weddingphotography','photography','Weddings'],               product: 'Peekr' },

  // — Teachers Pay Teachers audience — teachers who already pay for classroom tools —
  { keyword: 'app for sharing content classroom', subreddits: ['Teachers','education','edtech','Professors'],              product: 'Peekr' },
  { keyword: 'free tool for teachers share',      subreddits: ['Teachers','education','edtech','SubstituteTeachers'],      product: 'Peekr' },
  { keyword: 'congregation song lyrics phone',    subreddits: ['churchtech','Christianity','church','Reformed'],            product: 'Peekr' },
  { keyword: 'wedding slideshow live guests',     subreddits: ['Weddings','weddingplanning','weddingphotography'],         product: 'Peekr' },

  // ── FIELDOPS — ebenova.net (enquiry: info@ebenova.net) ───────────────────
  // Operations platform for Nigerian service businesses (cleaning, logistics, facility mgmt)
  { keyword: 'cleaning business software',      subreddits: ['EntrepreneurRideAlong','smallbusiness','Entrepreneur'],       product: 'FieldOps' },
  { keyword: 'field service management',        subreddits: ['smallbusiness','Entrepreneur','startups'],                    product: 'FieldOps' },
  { keyword: 'managing cleaning staff',         subreddits: ['smallbusiness','EntrepreneurRideAlong','Nigeria'],            product: 'FieldOps' },
  { keyword: 'scheduling cleaning jobs',        subreddits: ['smallbusiness','cleaning','housekeeping'],                    product: 'FieldOps' },
  { keyword: 'running cleaning company nigeria',subreddits: ['Nigeria','lagos','naija'],                                    product: 'FieldOps' },
  { keyword: 'invoicing for service business',  subreddits: ['smallbusiness','freelance','Entrepreneur'],                   product: 'FieldOps' },
  { keyword: 'service business management app', subreddits: ['smallbusiness','Entrepreneur','startups'],                    product: 'FieldOps' },

  // ── EBENOVA API — api.ebenova.dev ─────────────────────────────────────────
  // Legal document API for developers, SaaS founders, AI agent builders
  { keyword: 'legal document API',              subreddits: ['webdev','SaaS','startups'],                                   product: 'Ebenova API' },
  { keyword: 'contract generation API',         subreddits: ['webdev','IndieHackers'],                                      product: 'Ebenova API' },
  { keyword: 'document automation API',         subreddits: ['webdev','SaaS'],                                              product: 'Ebenova API' },
  { keyword: 'API for legal tech',              subreddits: ['webdev','legaltech','SaaS'],                                  product: 'Ebenova API' },
  { keyword: 'generate contracts programmatically', subreddits: ['webdev','SaaS','startups'],                               product: 'Ebenova API' },

  // ── EBENOVA MCP — MCP Server for Claude Desktop ───────────────────────────
  // Model Context Protocol server for AI agents
  { keyword: 'MCP server',                      subreddits: ['artificial','ClaudeAI','LocalLLaMA'],                         product: 'Ebenova MCP' },
  { keyword: 'Claude Desktop tools',            subreddits: ['ClaudeAI','artificial'],                                      product: 'Ebenova MCP' },
  { keyword: 'AI agent tools',                  subreddits: ['artificial','SaaS','startups'],                               product: 'Ebenova MCP' },
  { keyword: 'model context protocol',          subreddits: ['ClaudeAI','artificial','webdev'],                             product: 'Ebenova MCP' },
  { keyword: 'AI agent framework',              subreddits: ['artificial','webdev','SaaS'],                                 product: 'Ebenova MCP' },
  { keyword: 'Claude AI automation',            subreddits: ['ClaudeAI','artificial','automation'],                         product: 'Ebenova MCP' },

  // ── SCOPE GUARD — Contract enforcement for freelancers ────────────────────
  // Freelance contract protection and change order enforcement
  { keyword: 'change order',                    subreddits: ['freelance','Entrepreneur','smallbusiness'],                   product: 'Scope Guard' },
  { keyword: 'satisfaction clause',             subreddits: ['freelance','legal','smallbusiness'],                          product: 'Scope Guard' },
  { keyword: 'contract enforcement',            subreddits: ['freelance','legal','Entrepreneur'],                           product: 'Scope Guard' },
  { keyword: 'freelance payment dispute',       subreddits: ['freelance','freelancers','legal'],                            product: 'Scope Guard' },
  { keyword: 'breach of contract freelance',    subreddits: ['freelance','legal','Entrepreneur'],                           product: 'Scope Guard' },

  // ── NIGERIA/AFRICA PAYMENTS — Signova crypto feature ──────────────────────
  // USDT and crypto payments for African users
  { keyword: 'Nigeria payment',                 subreddits: ['Nigeria','lagos','fintech'],                                  product: 'Signova' },
  { keyword: 'bank transfer Nigeria',           subreddits: ['Nigeria','lagos','smallbusiness'],                            product: 'Signova' },
  { keyword: 'USDT payment Nigeria',            subreddits: ['Nigeria','CryptoCurrency','fintech'],                         product: 'Signova' },
  { keyword: 'crypto payment Africa',           subreddits: ['Nigeria','Kenya','Ghana','CryptoCurrency'],                   product: 'Signova' },
  { keyword: 'pay with crypto Nigeria',         subreddits: ['Nigeria','CryptoCurrency','lagos'],                           product: 'Signova' },

  // ── AI RECRUITING — Reddit Monitor V2 use case ────────────────────────────
  // Semantic search for recruiting and hiring
  { keyword: 'AI recruiting',                   subreddits: ['recruiting','artificial','startups'],                         product: 'Reddit Monitor V2' },
  { keyword: 'hiring engineers',                subreddits: ['recruiting','webdev','startups'],                             product: 'Reddit Monitor V2' },
  { keyword: 'startup hiring',                  subreddits: ['startups','recruiting','Entrepreneur'],                       product: 'Reddit Monitor V2' },
  { keyword: 'candidate sourcing',              subreddits: ['recruiting','HR','startups'],                                 product: 'Reddit Monitor V2' },
  { keyword: 'automated candidate screening',   subreddits: ['recruiting','artificial','HR'],                               product: 'Reddit Monitor V2' },

  // ── API DEVELOPER KEYWORDS (15 keywords) ─────────────────────────────────
  { keyword: 'legal document API',              subreddits: ['webdev','SaaS','IndieHackers'],                               product: 'Ebenova API' },
  { keyword: 'NDA API',                         subreddits: ['webdev','SaaS','startups'],                                   product: 'Ebenova API' },
  { keyword: 'contract generation API',         subreddits: ['webdev','SaaS'],                                              product: 'Ebenova API' },
  { keyword: 'document generation API',         subreddits: ['webdev','SaaS'],                                              product: 'Ebenova API' },
  { keyword: 'PDF generation API',              subreddits: ['webdev','SaaS'],                                              product: 'Ebenova API' },
  { keyword: 'invoice API',                     subreddits: ['webdev','SaaS','freelance'],                                  product: 'Ebenova API' },
  { keyword: 'API for contracts',               subreddits: ['webdev','IndieHackers'],                                      product: 'Ebenova API' },
  { keyword: 'legal tech API',                  subreddits: ['webdev','legaltech'],                                         product: 'Ebenova API' },
  { keyword: 'compliance API',                  subreddits: ['fintech','SaaS'],                                             product: 'Ebenova API' },
  { keyword: 'KYC API',                         subreddits: ['fintech','SaaS','startups'],                                  product: 'Ebenova API' },
  { keyword: 'payment API Africa',              subreddits: ['fintech','Africa','Nigeria'],                                 product: 'PocketBridge' },
  { keyword: 'payout API',                      subreddits: ['fintech','SaaS'],                                             product: 'PocketBridge' },
  { keyword: 'remittance API',                  subreddits: ['fintech','Nigeria','Africa'],                                 product: 'PocketBridge' },
  { keyword: 'Stripe alternative',              subreddits: ['SaaS','IndieHackers','Nigeria'],                              product: 'PocketBridge' },
  { keyword: 'Flutterwave alternative',         subreddits: ['fintech','Nigeria','Africa'],                                 product: 'PocketBridge' },

  // ── MCP SERVER KEYWORDS (10 keywords) ────────────────────────────────────
  { keyword: 'MCP server',                      subreddits: ['ClaudeAI','artificial','LocalLLaMA'],                         product: 'Ebenova MCP' },
  { keyword: 'Model Context Protocol',          subreddits: ['ClaudeAI','artificial'],                                      product: 'Ebenova MCP' },
  { keyword: 'Claude Desktop tools',            subreddits: ['ClaudeAI','artificial'],                                      product: 'Ebenova MCP' },
  { keyword: 'Cursor IDE tools',                subreddits: ['CursorIDE','webdev'],                                         product: 'Ebenova MCP' },
  { keyword: 'AI agent tools',                  subreddits: ['artificial','LocalLLaMA','LangChain'],                        product: 'Ebenova MCP' },
  { keyword: 'AI agent API',                    subreddits: ['artificial','SaaS'],                                          product: 'Ebenova API' },
  { keyword: 'build MCP server',                subreddits: ['ClaudeAI','webdev'],                                          product: 'Ebenova MCP' },
  { keyword: 'MCP server tutorial',             subreddits: ['ClaudeAI','artificial'],                                      product: 'Ebenova MCP' },
  { keyword: 'Smithery MCP',                    subreddits: ['ClaudeAI','artificial'],                                      product: 'Ebenova MCP' },
  { keyword: 'Glama MCP',                       subreddits: ['ClaudeAI','artificial'],                                      product: 'Ebenova MCP' },

  // ── FREELANCER PAIN KEYWORDS (10 keywords) ───────────────────────────────
  { keyword: "client won't pay",                subreddits: ['freelance','freelancers','Upwork'],                           product: 'Signova' },
  { keyword: 'scope creep',                     subreddits: ['freelance','webdev','IndieHackers'],                          product: 'Scope Guard' },
  { keyword: 'freelance contract',              subreddits: ['freelance','freelancers','Upwork'],                           product: 'Signova' },
  { keyword: 'verbal agreement',                subreddits: ['freelance','smallbusiness'],                                  product: 'Signova' },
  { keyword: 'need contract template',          subreddits: ['freelance','Entrepreneur','smallbusiness'],                   product: 'Signova' },
  { keyword: 'Upwork suspended',                subreddits: ['Upwork','freelance','freelancers'],                           product: 'Signova' },
  { keyword: 'Fiverr suspended',                subreddits: ['Fiverr','freelance'],                                         product: 'Signova' },
  { keyword: 'freelancer protection',           subreddits: ['freelance','Entrepreneur'],                                   product: 'Signova' },
  { keyword: 'independent contractor agreement',subreddits: ['freelance','smallbusiness'],                                  product: 'Signova' },
  { keyword: '1099 contract',                   subreddits: ['freelance','tax','smallbusiness'],                            product: 'Signova' },

  // ── BUSINESS/SERVICE KEYWORDS (5 keywords) ───────────────────────────────
  { keyword: 'booking system',                  subreddits: ['smallbusiness','Entrepreneur','CleaningBusiness'],            product: 'FieldOps' },
  { keyword: 'service business software',       subreddits: ['smallbusiness','Entrepreneur'],                               product: 'FieldOps' },
  { keyword: 'cleaning business app',           subreddits: ['CleaningBusiness','smallbusiness'],                           product: 'FieldOps' },
  { keyword: 'field service management',        subreddits: ['smallbusiness','Entrepreneur'],                               product: 'FieldOps' },
  { keyword: 'HVAC software',                   subreddits: ['HVAC','smallbusiness'],                                       product: 'FieldOps' },

]

// ── Approved subreddit whitelist ────────────────────────────────────────────
// Posts from ANY subreddit not on this list will be flagged DO NOT POST
// and will NOT receive an AI draft — no matter what keyword matched
const APPROVED_SUBREDDITS = new Set([
  // Signova
  'freelance','freelancers','smallbusiness','Entrepreneur','EntrepreneurRideAlong',
  'SoloDevelopment','agency','agencynewbies','Nigeria','lagos','naija','nairaland',
  'LandlordLady','webdev','SaaS','startups','IndieHackers','buildinpublic',
  'androiddev','iOSProgramming',
  // Peekr
  'Teachers','education','Professors','PublicSpeaking','churchtech',
  'photography','eventplanning','Weddings','AV','hometheater','techsupport',
  'SubstituteTeachers','OnlineLearning','edtech','wedding','weddingplanning',
  'Christianity','church','Reformed','DIY','weddingphotography',
  'cleaning','housekeeping',
])

// ── Product context for reply drafts ─────────────────────────────────────────
const PRODUCT_CONTEXT = {
  Signova: {
    url: 'getsignova.com',
    description: `Signova is a legal document generator. You answer a few questions and get a professional document in under 3 minutes.
Key facts you know from using it:
- 27 document types: NDAs, freelance contracts, tenancy agreements, privacy policies, employment contracts, partnership agreements, loan agreements, deeds of assignment, quit notices, and more
- Free to preview the full document. $4.99 to download the clean PDF. No account needed.
- Jurisdiction-aware: Nigerian Labour Act, Lagos State Tenancy Law, Kenyan law, UK law, Canadian law, Indian Contract Act — not just US templates
- Unique feature: paste a WhatsApp negotiation and it auto-fills the contract fields
- Accepts card payments globally and USDT crypto for users in Africa
- Built by a Nigerian founder who watched a friend lose money with no contract
When to mention it: when someone needs a specific document, can't afford a lawyer, is in a non-US jurisdiction, or just got burned by a verbal agreement.
When NOT to mention it: when the problem is legal advice (not document generation), when the post is emotional, or when the person already has a lawyer.`,
  },
  Peekr: {
    url: 'getpeekr.com',
    description: `Peekr is a free iOS app that lets you share photos, videos, documents, and live camera streams from your phone to any group — instantly. Viewers scan a QR code and watch in their browser. No app download for viewers.
Key facts you know from using it:
- Works for teachers sharing content with a classroom without cables or Apple TV
- Works for event/wedding photographers sharing live previews with clients during a shoot
- Works for wedding hosts building a shared guest photo gallery — guests scan and upload their own photos
- Works for church congregations displaying song lyrics from a phone
- Works for presenters sharing slides or documents with a room
- Free tier: up to 5 viewers, 30 min sessions, photos only
- Personal $4.99/month: 10 viewers, 2 hour sessions, video and documents
- Pro $14.99/month: unlimited viewers, live camera streaming
- After an event, a shared gallery with AI-curated "Best Shots" is available for 7 days
When to mention it: when someone needs to share their phone screen without a cable, wants to share photos live at an event, or needs a wireless presentation tool.
When NOT to mention it: when the problem is about remote/online sharing (Peekr is for in-person groups), or when a simpler solution clearly exists.`,
  },
  FieldOps: {
    url: 'ebenova.net',
    description: `FieldOps is a web-based operations platform for Nigerian service businesses — cleaning companies, logistics firms, facility managers.
Key facts:
- Replaces WhatsApp group chats and paper records with a proper system
- Booking management, staff mobile app, job scheduling, automated invoicing
- Built for African service business owners who run operations informally
When to mention it: when someone is running a cleaning or field service business and struggling with scheduling, staff management, or invoicing.
When NOT to mention it: generic small business questions not specific to field/service operations.`,
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

  const prompt = `You are a Reddit community member who helps people with real problems. You have genuine expertise in the topic area below. You are NOT a marketer — you are a helpful person who occasionally mentions tools when they directly solve someone's exact problem.

YOUR EXPERTISE AREA: ${ctx.description}

REDDIT POST:
Title: ${post.title}
Subreddit: r/${post.subreddit}
Body: ${post.body || '(no body text)'}

━━━ STEP 1: SKIP FILTER (check ALL of these) ━━━
Respond ONLY with the word SKIP if ANY are true:
- Post is emotional, relational, or about a person — not a task or tool problem
- Person is venting, celebrating, joking, or seeking validation
- Keyword matched incidentally (e.g. "share" in social sense, not tech sense)
- Post is in a subreddit where self-promotion causes bans (r/Teachers, r/freelance)
  AND the post does not explicitly ask "what tool/app/software should I use"
- The problem is already solved in the thread
- The post is more than 48 hours old (likely buried)

━━━ STEP 2: CHOOSE YOUR REPLY STRATEGY ━━━
If the post passes Step 1, choose ONE strategy based on the post type:

STRATEGY A — "Genuine Advice First, Tool Optional"
Use when: Person has a problem, not asking for a tool specifically.
Structure: Give 2-3 sentences of real, actionable advice. Only mention ${post.product} if it's the single most natural solution — phrase it as "I've used [product] for this" not "check out [product]". If mentioning feels forced, don't mention it at all.

STRATEGY B — "Direct Answer to Tool Request"  
Use when: Person explicitly asks "what app/tool/software" for this.
Structure: Answer directly. Name ${post.product} as one option among others if relevant. Include one specific reason why it fits their situation. Keep it under 4 sentences.

STRATEGY C — "Helpful Comment, No Product Mention"
Use when: Post is in a sensitive subreddit (Teachers, freelance) OR product mention would feel like an ad.
Structure: Write a genuinely helpful 2-3 sentence reply with real advice. Do NOT mention ${post.product} at all. This builds account credibility and is sometimes the right call.

STRATEGY D — "Empathy Then Practical Step"
Use when: Person is frustrated (client won't pay, landlord problem, scope creep).
Structure: One sentence acknowledging the frustration. Then one concrete next step they can take right now. Only mention ${post.product} if it directly enables that next step.

━━━ REPLY RULES (apply to all strategies) ━━━
- Write like a real Reddit user: casual, direct, no corporate language
- Never use phrases like "check out", "I recommend", "great tool", "you should try"
- If mentioning ${post.product}: use "I use" or "there's a thing called" or "someone built"
- Never mention the URL unless the person asked for links
- Never use bullet points, headers, or markdown formatting
- Maximum 4 sentences total
- Do not start with "I" — vary your opening

Respond with SKIP or the reply text only. No labels, no strategy name, no explanation.`

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
  // — Signova: already-aware —
  { keyword: 'contract template',       section: 'business',    product: 'Signova'  },
  { keyword: 'tenancy agreement',       section: 'properties',  product: 'Signova'  },
  { keyword: 'client refused to pay',   section: 'business',    product: 'Signova'  },
  { keyword: 'deed of assignment',      section: 'properties',  product: 'Signova'  },
  { keyword: 'freelance contract',      section: 'career',      product: 'Signova'  },
  { keyword: 'NDA agreement',           section: 'business',    product: 'Signova'  },
  { keyword: 'quit notice',             section: 'properties',  product: 'Signova'  },
  { keyword: 'legal document',          section: 'business',    product: 'Signova'  },
  // — Signova: Lagos Tenancy Bill 2025 — active legislation, high search volume —
  { keyword: 'tenancy bill',            section: 'properties',  product: 'Signova'  },
  { keyword: 'lagos tenancy law',       section: 'properties',  product: 'Signova'  },
  { keyword: 'landlord tenant dispute', section: 'properties',  product: 'Signova'  },
  { keyword: 'tenant refused to pay',   section: 'properties',  product: 'Signova'  },
  { keyword: 'eviction notice',         section: 'properties',  product: 'Signova'  },
  // — Signova: Nigerian freelancer trigger moments —
  { keyword: 'how to get paid freelance',section: 'career',     product: 'Signova'  },
  { keyword: 'client owes me money',    section: 'business',    product: 'Signova'  },
  { keyword: 'partnership agreement',   section: 'business',    product: 'Signova'  },
  // — Peekr —
  { keyword: 'share to classroom',      section: 'education',   product: 'Peekr'    },
  // — FieldOps —
  { keyword: 'cleaning company lagos',  section: 'business',    product: 'FieldOps' },
  { keyword: 'facility management',     section: 'business',    product: 'FieldOps' },
  { keyword: 'cleaning business app',   section: 'business',    product: 'FieldOps' },
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

      console.log(`[monitor] Reddit API response: ${posts.length} posts found for "${keyword}"`)
      if (posts.length > 0) {
        console.log(`[monitor] Top 3 posts: ${posts.slice(0, 3).map(p => p.data.title).join(' | ')}`)
      }

      for (const post of posts) {
        const p = post.data
        if (seenIds.has(p.id)) continue
        const createdAt = p.created_utc * 1000
        const ageMs = Date.now() - createdAt
        // Only alert on posts from last 60 minutes — guards against restarts missing content
        if (ageMs > 60 * 60 * 1000) continue
        seenIds.add(p.id)
        console.log(`[monitor] 🎯 NEW MATCH FOUND: "${keyword}" → ${p.title}`)
        console.log(`[monitor] Post URL: https://reddit.com${p.permalink}`)
        console.log(`[monitor] Post age: ${p.created_utc} (${Math.floor((Date.now() - createdAt) / 3600000)} hours old)`)
        results.push({
          id:        p.id,
          title:     p.title || p.body?.slice(0, 100) || '(no title)',
          url:       `https://reddit.com${p.permalink}`,
          subreddit: p.subreddit,
          author:    p.author,
          score:     p.score,
          comments:  p.num_comments,
          body:      (p.selftext || p.body || '').slice(0, 600),
          createdAt: new Date(createdAt).toUTCString(),
          keyword,
          approved:  APPROVED_SUBREDDITS.has(p.subreddit),
        })
      }
    } catch (err) {
      console.error(`[monitor] fetch error for "${keyword}":`, err.message)
    }

    // Polite delay between requests — avoid rate limiting
    await delay(2000)

    // Memory cleanup: clear old posts if we exceed the limit
    if (seenIds.size > MAX_POSTS_IN_MEMORY) {
      const idsToRemove = Array.from(seenIds).slice(0, 5000)
      idsToRemove.forEach(id => seenIds.delete(id))
      console.log(`[monitor] 🧹 Cleared ${idsToRemove.length} old posts from memory (seenIds: ${seenIds.size})`)
    }
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
      const snippet = html.slice(matchIdx, matchIdx + 700)
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600)
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
  try {
    console.log(`\n[monitor] ========== POLLING CYCLE START: ${new Date().toISOString()} ==========`)
    console.log(`[monitor] Searching ${KEYWORDS.length} keywords across Reddit`)
    console.log(`[monitor] Nairaland: ${NAIRALAND_KEYWORDS.length} keywords\n`)
    const allMatches = []
    let matchesFound = 0

    // Reddit
    for (const { keyword, subreddits, product } of KEYWORDS) {
      console.log(`[monitor] Searching "${keyword}" in r/${subreddits ? subreddits.join(', r/') : 'all of Reddit'}`)
      const matches = await searchReddit(keyword, subreddits)
      if (matches.length > 0) {
        matches.forEach(m => { m.product = product })
        console.log(`[monitor] Reddit "${keyword}": ${matches.length} new`)
        matchesFound += matches.length
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
        matchesFound += matches.length
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

    console.log(`\n[monitor] ========== POLLING CYCLE END: ${new Date().toISOString()} ==========`)
    console.log(`[monitor] Total matches this cycle: ${matchesFound}`)
    console.log(`[monitor] Next poll in ${POLL_MINUTES} minutes\n`)
  } catch (error) {
    console.error(`[monitor] ❌ Polling error: ${error.message}`)
    console.error(`[monitor] Stack: ${error.stack}`)
    // Don't rethrow — let next cycle retry
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
