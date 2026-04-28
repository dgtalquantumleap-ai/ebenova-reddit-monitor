// reddit-monitor/monitor.js
// Polls Reddit's public search API for keyword matches
// Sends email digest via Resend when new posts/comments are found
// No Reddit API key required — uses public JSON endpoints

import { createRequire } from 'module'
import { loadEnv } from './lib/env.js'

// Load .env via shared loader (dotenv) — replaces hand-rolled parser.
loadEnv()

import { Resend } from 'resend'
import { Redis } from '@upstash/redis'
import cron from 'node-cron'
import searchMedium   from './lib/scrapers/medium.js'
import searchSubstack from './lib/scrapers/substack.js'
import searchQuora    from './lib/scrapers/quora.js'
import searchUpwork   from './lib/scrapers/upwork.js'
import searchFiverr   from './lib/scrapers/fiverr.js'
import { sendSlackAlert } from './lib/slack.js'
import { escapeHtml } from './lib/html-escape.js'
import { sanitizeForPrompt } from './lib/llm-safe-prompt.js'

// ── Redis client (optional — seenIds fallback when process restarts) ──────────
function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL  || process.env.REDIS_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN
  if (!url) return null
  try { return new Redis({ url, token }) } catch { return null }
}
const redis = getRedis()
if (!redis) console.log('[monitor] ⚠️  Redis not configured — seenIds will reset on restart')

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
const POST_MAX_AGE_HOURS = parseInt(process.env.POST_MAX_AGE_HOURS || '3') // max age for email alerts

// ── Memory optimization: max posts to keep in memory ─────────────────────────
const MAX_POSTS_IN_MEMORY = 10000

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null
if (!resend) console.log('[monitor] ⚠️  RESEND_API_KEY not set — email alerts disabled')

// ── Keywords to monitor ───────────────────────────────────────────────────────
// Each entry: { keyword, subreddits (optional — omit to search all of Reddit), product }
const KEYWORDS = [

  // ── SIGNOVA — getsignova.com ─────────────────────────────────────────────
  // Legal document generator for freelancers, small businesses, Nigeria/Africa

  // — Already-aware keywords (person knows what they need) —
  { keyword: 'freelance contract',          subreddits: ['freelance','freelancers','smallbusiness','Entrepreneur','Upwork'], product: 'Signova' },
  { keyword: 'unpaid invoice',              subreddits: ['freelance','freelancers','smallbusiness'],                       product: 'Signova' },
  { keyword: 'NDA template',               subreddits: ['freelance','smallbusiness','startups','SoloDevelopment'],         product: 'Signova' },
  { keyword: 'tenancy agreement nigeria',   subreddits: ['Nigeria','lagos','nairaland'],                                   product: 'Signova' },
  { keyword: "client won't pay",           subreddits: ['freelance','freelancers','smallbusiness','Entrepreneur','Upwork'], product: 'Signova' },
  { keyword: 'scope creep',                subreddits: ['freelance','agency','agencynewbies','SoloDevelopment','webdev','IndieHackers'], product: 'Scope Guard' },
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
  { keyword: 'legal document API',              subreddits: ['webdev','SaaS','startups','IndieHackers'],                    product: 'Ebenova API' },
  { keyword: 'contract generation API',         subreddits: ['webdev','SaaS','IndieHackers'],                               product: 'Ebenova API' },
  { keyword: 'document automation API',         subreddits: ['webdev','SaaS'],                                              product: 'Ebenova API' },
  { keyword: 'API for legal tech',              subreddits: ['webdev','legaltech','SaaS'],                                  product: 'Ebenova API' },
  { keyword: 'generate contracts programmatically', subreddits: ['webdev','SaaS','startups'],                               product: 'Ebenova API' },

  // ── EBENOVA MCP — MCP Server for Claude Desktop ───────────────────────────
  // Model Context Protocol server for AI agents
  { keyword: 'MCP server',                      subreddits: ['artificial','ClaudeAI','LocalLLaMA'],                         product: 'Ebenova MCP' },
  { keyword: 'Claude Desktop tools',            subreddits: ['ClaudeAI','artificial'],                                      product: 'Ebenova MCP' },
  { keyword: 'AI agent tools',                  subreddits: ['artificial','SaaS','startups','LocalLLaMA','LangChain'],      product: 'Ebenova MCP' },
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

  // ── EBENOVA API — additional keywords ─────────────────────────────────────
  { keyword: 'NDA API',                         subreddits: ['webdev','SaaS','startups'],                                   product: 'Ebenova API' },
  { keyword: 'document generation API',         subreddits: ['webdev','SaaS'],                                              product: 'Ebenova API' },
  { keyword: 'PDF generation API',              subreddits: ['webdev','SaaS'],                                              product: 'Ebenova API' },
  { keyword: 'invoice API',                     subreddits: ['webdev','SaaS','freelance'],                                  product: 'Ebenova API' },
  { keyword: 'API for contracts',               subreddits: ['webdev','IndieHackers'],                                      product: 'Ebenova API' },
  { keyword: 'legal tech API',                  subreddits: ['webdev','legaltech'],                                         product: 'Ebenova API' },
  { keyword: 'compliance API',                  subreddits: ['fintech','SaaS'],                                             product: 'Ebenova API' },
  { keyword: 'KYC API',                         subreddits: ['fintech','SaaS','startups'],                                  product: 'Ebenova API' },
  { keyword: 'AI agent API',                    subreddits: ['artificial','SaaS'],                                          product: 'Ebenova API' },

  // ── POCKETBRIDGE — payment API for Africa ─────────────────────────────────
  { keyword: 'payment API Africa',              subreddits: ['fintech','Africa','Nigeria'],                                 product: 'PocketBridge' },
  { keyword: 'payout API',                      subreddits: ['fintech','SaaS'],                                             product: 'PocketBridge' },
  { keyword: 'remittance API',                  subreddits: ['fintech','Nigeria','Africa'],                                 product: 'PocketBridge' },
  { keyword: 'Stripe alternative',              subreddits: ['SaaS','IndieHackers','Nigeria'],                              product: 'PocketBridge' },
  { keyword: 'Flutterwave alternative',         subreddits: ['fintech','Nigeria','Africa'],                                 product: 'PocketBridge' },

  // ── EBENOVA MCP — additional keywords ─────────────────────────────────────
  { keyword: 'Model Context Protocol',          subreddits: ['ClaudeAI','artificial','webdev'],                             product: 'Ebenova MCP' },
  { keyword: 'Cursor IDE tools',                subreddits: ['CursorIDE','webdev'],                                         product: 'Ebenova MCP' },
  { keyword: 'build MCP server',                subreddits: ['ClaudeAI','webdev'],                                          product: 'Ebenova MCP' },
  { keyword: 'MCP server tutorial',             subreddits: ['ClaudeAI','artificial'],                                      product: 'Ebenova MCP' },
  { keyword: 'Smithery MCP',                    subreddits: ['ClaudeAI','artificial'],                                      product: 'Ebenova MCP' },
  { keyword: 'Glama MCP',                       subreddits: ['ClaudeAI','artificial'],                                      product: 'Ebenova MCP' },

  // ── SIGNOVA — additional freelancer keywords ───────────────────────────────
  { keyword: 'verbal agreement',                subreddits: ['freelance','smallbusiness'],                                  product: 'Signova' },
  { keyword: 'need contract template',          subreddits: ['freelance','Entrepreneur','smallbusiness'],                   product: 'Signova' },
  { keyword: 'Upwork suspended',                subreddits: ['Upwork','freelance','freelancers'],                           product: 'Signova' },
  { keyword: 'Fiverr suspended',                subreddits: ['Fiverr','freelance'],                                         product: 'Signova' },
  { keyword: 'freelancer protection',           subreddits: ['freelance','Entrepreneur'],                                   product: 'Signova' },
  { keyword: 'independent contractor agreement',subreddits: ['freelance','smallbusiness'],                                  product: 'Signova' },
  { keyword: '1099 contract',                   subreddits: ['freelance','tax','smallbusiness'],                            product: 'Signova' },

  // ── FIELDOPS — additional keywords ────────────────────────────────────────
  { keyword: 'booking system',                  subreddits: ['smallbusiness','Entrepreneur','CleaningBusiness'],            product: 'FieldOps' },
  { keyword: 'service business software',       subreddits: ['smallbusiness','Entrepreneur'],                               product: 'FieldOps' },
  { keyword: 'cleaning business app',           subreddits: ['CleaningBusiness','smallbusiness'],                           product: 'FieldOps' },
  { keyword: 'HVAC software',                   subreddits: ['HVAC','smallbusiness'],                                       product: 'FieldOps' },

  // ── NIGERIA DATA PROTECTION / NDPA COMPLIANCE (Apr 2026) ──────────────────
  // Surfaced from Rosemary Onu-Okeke (DataLex Consulting) conversation
  // Nigerian fintechs need DPAs, privacy policies, data processing agreements
  { keyword: 'NDPA compliance nigeria',        subreddits: ['Nigeria','fintech','legaltech'],                            product: 'Signova' },
  { keyword: 'data protection nigeria',        subreddits: ['Nigeria','fintech','startups','legaltech'],                 product: 'Signova' },
  { keyword: 'NDPC audit nigeria',             subreddits: ['Nigeria','fintech','legaltech'],                            product: 'Signova' },
  { keyword: 'data processing agreement',      subreddits: ['Nigeria','fintech','SaaS','startups','legaltech'],          product: 'Signova' },
  { keyword: 'privacy policy nigeria',         subreddits: ['Nigeria','webdev','startups','SaaS'],                       product: 'Signova' },
  { keyword: 'GDPR compliance startup',        subreddits: ['startups','SaaS','webdev','Entrepreneur'],                  product: 'Signova' },

  // ── FREELANCERS UNION AUDIENCE (Apr 2026) ────────────────────────────────
  // Targeting pain points that @freelancersu (85.9K followers) posts about:
  // contracts, getting paid, client disputes, creative protections
  { keyword: 'kill fee creative',              subreddits: ['freelance','freelancers','copywriting','writing','graphic_design'], product: 'Signova' },
  { keyword: 'creative brief contract',        subreddits: ['graphic_design','photography','videography','copywriting'],        product: 'Signova' },
  { keyword: 'photographer contract template', subreddits: ['photography','weddingphotography','freelancers'],                   product: 'Signova' },
  { keyword: 'copywriter contract',            subreddits: ['copywriting','freelancers','writing'],                              product: 'Signova' },
  { keyword: 'client ghosted after delivery',  subreddits: ['freelance','freelancers','graphic_design'],                         product: 'Signova' },
  { keyword: 'revision clause contract',       subreddits: ['graphic_design','freelancers','photography','videography'],         product: 'Signova' },
  { keyword: 'freelance contract dispute',     subreddits: ['freelance','freelancers','smallbusiness'],                          product: 'Signova' },
  { keyword: 'content creator contract',       subreddits: ['content_marketing','freelancers','socialmediamanagement','marketing'], product: 'Signova' },
  { keyword: 'influencer contract template',   subreddits: ['socialmediamanagement','marketing','freelancers'],                  product: 'Signova' },
  { keyword: 'videographer contract',          subreddits: ['videography','filmmakers','freelancers','weddingphotography'],      product: 'Signova' },

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
  // Ebenova API / MCP
  'artificial','ClaudeAI','LocalLLaMA','LangChain','CursorIDE','automation','legaltech',
  // Scope Guard / legal
  'legal','Upwork','Fiverr','tax',
  // FieldOps
  'CleaningBusiness','HVAC',
  // PocketBridge / Africa payments
  'fintech','Africa','Kenya','Ghana','CryptoCurrency',
  // AI Recruiting
  'recruiting','HR',
  // Freelancers Union audience — creative freelancers
  'graphic_design','copywriting','writing','photography','videography',
  'filmmakers','socialmediamanagement','marketing','content_marketing',
  'digitalnomad',
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
  'Ebenova API': {
    url: 'api.ebenova.dev',
    description: `The Ebenova API lets developers generate legal documents programmatically — NDAs, freelance contracts, privacy policies, employment agreements, and more — with a single API call.
Key facts:
- REST API, JSON in/out, responses in under 2 seconds
- 27 document types, jurisdiction-aware (Nigerian, UK, Canadian, Indian, Kenyan law)
- No per-seat pricing — pay per document generation or flat monthly
- Built for SaaS founders, legal tech startups, and AI agent builders who need document generation without building it themselves
- Works in any language with an HTTP client
When to mention it: when a developer or SaaS founder needs to generate contracts, NDAs, or legal documents inside their own product. When someone asks about document automation APIs or legal tech APIs.
When NOT to mention it: when the person just needs a single document for themselves (point them to Signova instead), or when they're asking about legal advice not document generation.`,
  },
  'Ebenova MCP': {
    url: 'api.ebenova.dev',
    description: `The Ebenova MCP server lets AI agents (Claude Desktop, Cursor, custom agents) generate professional legal documents directly from a conversation — no copy-paste, no browser.
Key facts:
- Model Context Protocol (MCP) server — works with any MCP-compatible AI client
- Generates NDAs, contracts, privacy policies, tenancy agreements, and more via natural language
- Listed on Smithery and Glama MCP directories
- Free to try; connects to the same document engine powering Signova
When to mention it: when someone is building or using AI agents and wants them to be able to generate legal documents, or when someone is asking about useful MCP servers for Claude Desktop or Cursor.
When NOT to mention it: when the person is not using Claude Desktop or an MCP-compatible tool.`,
  },
  'Scope Guard': {
    url: 'getsignova.com',
    description: `Scope Guard is Signova's contract enforcement layer for freelancers — it helps you generate change orders, enforce satisfaction clauses, and document scope disputes before they become payment disputes.
Key facts:
- Built into Signova — not a separate product
- Generates change order documents when clients add work mid-project
- Tracks what was agreed, what changed, and what was approved in writing
- Helps freelancers who got burned by scope creep or "that's not what I meant" clients
When to mention it: when a freelancer is dealing with scope creep, a client disputing work, or asking how to protect themselves from contract disputes mid-project.
When NOT to mention it: when the post is about a payment that already failed to come in — Signova's main contract templates are more relevant then.`,
  },
  PocketBridge: {
    url: 'ebenova.net',
    description: `PocketBridge is a payment API for African businesses — it handles payouts, remittances, and collections for companies operating in Nigeria, Ghana, Kenya, and other African markets.
Key facts:
- Alternative to Stripe for African-market businesses where Stripe isn't available
- Supports bank transfers, mobile money, and USDT crypto payouts
- Built for fintech startups and SaaS companies serving African users
When to mention it: when a developer or founder is building a product for African users and struggling with payments infrastructure, or when someone explicitly asks about Stripe alternatives for Nigeria/Africa.
When NOT to mention it: when the person is a consumer looking to send or receive money personally — this is a developer/business API.`,
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

  // F8: Sanitize all untrusted inputs before they enter the prompt. Reddit
  // post fields are user-controlled and could contain injection payloads
  // ("Ignore previous instructions..."). Sanitization strips control chars
  // and role tokens but preserves normal text. ctx.description is internal,
  // also sanitized as defense-in-depth in case it's ever made tenant-editable.
  const safeTitle = sanitizeForPrompt(post.title)
  const safeSubreddit = sanitizeForPrompt(post.subreddit)
  const safeBody = sanitizeForPrompt(post.body || '(no body text)')
  const safeProduct = sanitizeForPrompt(post.product)
  const safeContext = sanitizeForPrompt(ctx.description)

  const prompt = `You are a Reddit community member who helps people with real problems. You have genuine expertise in the topic area below. You are NOT a marketer — you are a helpful person who occasionally mentions tools when they directly solve someone's exact problem.

YOUR EXPERTISE AREA: ${safeContext}

REDDIT POST:
Title: ${safeTitle}
Subreddit: r/${safeSubreddit}
Body: ${safeBody}

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
Structure: Give 2-3 sentences of real, actionable advice. Only mention ${safeProduct} if it's the single most natural solution — phrase it as "I've used [product] for this" not "check out [product]". If mentioning feels forced, don't mention it at all.

STRATEGY B — "Direct Answer to Tool Request"  
Use when: Person explicitly asks "what app/tool/software" for this.
Structure: Answer directly. Name ${safeProduct} as one option among others if relevant. Include one specific reason why it fits their situation. Keep it under 4 sentences.

STRATEGY C — "Helpful Comment, No Product Mention"
Use when: Post is in a sensitive subreddit (Teachers, freelance) OR product mention would feel like an ad.
Structure: Write a genuinely helpful 2-3 sentence reply with real advice. Do NOT mention ${safeProduct} at all. This builds account credibility and is sometimes the right call.

STRATEGY D — "Empathy Then Practical Step"
Use when: Person is frustrated (client won't pay, landlord problem, scope creep).
Structure: One sentence acknowledging the frustration. Then one concrete next step they can take right now. Only mention ${safeProduct} if it directly enables that next step.

━━━ REPLY RULES (apply to all strategies) ━━━
- Write like a real Reddit user: casual, direct, no corporate language
- Never use phrases like "check out", "I recommend", "great tool", "you should try"
- If mentioning ${safeProduct}: use "I use" or "there's a thing called" or "someone built"
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

// ── Hacker News keywords ──────────────────────────────────────────────────────
// HN audience: developers, technical founders, early adopters
const HN_KEYWORDS = [
  // Ebenova API / MCP
  { keyword: 'legal document API',           product: 'Ebenova API'  },
  { keyword: 'contract generation API',      product: 'Ebenova API'  },
  { keyword: 'document automation',          product: 'Ebenova API'  },
  { keyword: 'PDF generation API',           product: 'Ebenova API'  },
  { keyword: 'model context protocol',       product: 'Ebenova MCP'  },
  { keyword: 'MCP server',                   product: 'Ebenova MCP'  },
  // Signova — dev/founder angle
  { keyword: 'freelance contract',           product: 'Signova'      },
  { keyword: 'client refused to pay',        product: 'Signova'      },
  { keyword: 'scope creep',                  product: 'Scope Guard'  },
  // PocketBridge
  { keyword: 'payment API Africa',           product: 'PocketBridge' },
  { keyword: 'Stripe alternative',           product: 'PocketBridge' },
]

// ── Seen post tracker — persists in memory, backed by Redis on restart ───────
const seenIds = new Set()
const seenHnIds = new Set()

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
        // Check memory first, then Redis fallback (handles restarts)
        if (!seenIds.has(p.id) && redis) {
          try {
            const inRedis = await redis.get(`seen:v1:${p.id}`)
            if (inRedis) seenIds.add(p.id) // backfill memory
          } catch (_) {}
        }
        if (seenIds.has(p.id)) {
          console.log(`[monitor] ⏭️ Already seen: "${p.title?.slice(0, 50)}" (${p.id})`)
          continue
        }
        const createdAt = p.created_utc * 1000
        const ageMs = Date.now() - createdAt
        const ageHours = (ageMs / (60 * 60 * 1000)).toFixed(1)
        // Only alert on posts within the configured max age (default 3 hours)
        // Guards against restarts re-alerting on very old content
        if (ageMs > POST_MAX_AGE_HOURS * 60 * 60 * 1000) {
          console.log(`[monitor] ⏰ Too old (${ageHours}h): "${p.title?.slice(0, 50)}" (max: ${POST_MAX_AGE_HOURS}h)`)
          continue
        }
        seenIds.add(p.id)
        // Persist to Redis so restarts don't re-alert on the same post (3-day TTL)
        if (redis) redis.setex(`seen:v1:${p.id}`, 60 * 60 * 24 * 3, '1').catch(() => {})
        console.log(`[monitor] 🎯 NEW MATCH FOUND: "${keyword}" → ${p.title}`)
        console.log(`[monitor] Post URL: https://reddit.com${p.permalink}`)
        console.log(`[monitor] Post age: ${ageHours} hours old`)
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
            ${p.source === 'hackernews' ? 'HN' : p.source === 'medium' ? '📰 Medium' : p.source === 'substack' ? '📧 Substack' : p.source === 'quora' ? '💬 Quora' : p.source === 'upwork' ? '💼 Upwork Community' : p.source === 'fiverr' ? '🟢 Fiverr Community' : p.source === 'indiehackers' ? 'IndieHackers' : `r/${escapeHtml(p.subreddit)}`} · ${escapeHtml(p.author)} · ${escapeHtml(p.score)} points · ${escapeHtml(p.comments)} comments
          </div>
          ${p.priority_score >= 8 ? `<div style="display:inline-block;margin-bottom:6px;background:#c9a84c;color:#000;padding:2px 8px;border-radius:3px;font-size:10px;font-weight:700;letter-spacing:0.5px;">🔥 HIGH PRIORITY</div>` : ''}
          <a href="${escapeHtml(p.url)}" style="font-size:15px;font-weight:600;color:#1a1a1a;text-decoration:none;">${escapeHtml(p.title)}</a>
          ${p.body ? `<p style="font-size:13px;color:#555;margin:7px 0 0;line-height:1.5;">${escapeHtml(p.body)}${p.body.length >= 300 ? '…' : ''}</p>` : ''}
          <a href="${escapeHtml(p.url)}" style="display:inline-block;margin-top:8px;font-size:12px;color:#c9a84c;font-weight:600;">Open thread →</a>
          ${!p.approved ? `
          <div style="margin-top:10px;padding:8px 12px;background:#fdecea;border:1px solid #f5c6cb;border-radius:6px;font-size:12px;font-weight:700;color:#c0392b;">
            ⚠️ DO NOT POST — r/${escapeHtml(p.subreddit)} is not an approved subreddit
          </div>` : ''}
          ${p.draft ? `
          <div style="margin-top:12px;padding:12px;background:#fffdf0;border:1px solid #e8d87a;border-radius:6px;">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#a08c00;margin-bottom:6px;">✏️ Suggested reply</div>
            <div style="font-size:13px;color:#333;line-height:1.6;white-space:pre-wrap;">${escapeHtml(p.draft)}</div>
          </div>` : ''}
        </div>
      `).join('')
      return `
        <div style="margin-bottom:24px;">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#aaa;margin-bottom:10px;">
            "${escapeHtml(keyword)}" (${posts.length})
          </div>
          ${items}
        </div>
      `
    }).join('')

    return `
      <div style="margin-bottom:40px;padding:20px;background:#fff;border:1px solid #eee;border-radius:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;padding-bottom:12px;border-bottom:2px solid #c9a84c;">
          <div>
            <div style="font-size:18px;font-weight:700;color:#1a1a1a;">${escapeHtml(product)}</div>
            <div style="font-size:12px;color:#888;margin-top:2px;">${totalForProduct} new mention${totalForProduct !== 1 ? 's' : ''}</div>
          </div>
          <a href="${escapeHtml(PRODUCT_LINKS[product] || '#')}" style="font-size:12px;color:#c9a84c;font-weight:600;text-decoration:none;">Visit site →</a>
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

// ── Hacker News search — Algolia API, free, no auth ──────────────────────────
async function searchHackerNews(keyword) {
  const results = []
  const encoded = encodeURIComponent(keyword)
  const since   = Math.floor((Date.now() - POST_MAX_AGE_HOURS * 60 * 60 * 1000) / 1000)
  const url     = `https://hn.algolia.com/api/v1/search_by_date?query=${encoded}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=10`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'ebenova-monitor/1.0' } })
    if (!res.ok) return results
    const data = await res.json()
    for (const hit of (data.hits || [])) {
      if (seenHnIds.has(hit.objectID)) continue
      seenHnIds.add(hit.objectID)
      const ageHours = ((Date.now() / 1000 - hit.created_at_i) / 3600).toFixed(1)
      console.log(`[hn] 🎯 NEW MATCH: "${keyword}" → ${hit.title}`)
      console.log(`[hn] URL: https://news.ycombinator.com/item?id=${hit.objectID} (${ageHours}h old)`)
      results.push({
        id:        hit.objectID,
        title:     hit.title || '(no title)',
        url:       `https://news.ycombinator.com/item?id=${hit.objectID}`,
        subreddit: 'HackerNews',
        author:    hit.author || 'unknown',
        score:     hit.points || 0,
        comments:  hit.num_comments || 0,
        body:      (hit.story_text || '').replace(/<[^>]+>/g, ' ').slice(0, 600),
        createdAt: new Date(hit.created_at_i * 1000).toUTCString(),
        keyword,
        source:    'hackernews',
        approved:  true,
      })
    }
  } catch (err) {
    console.error(`[hn] fetch error for "${keyword}":`, err.message)
  }
  return results
}

// Note: IndieHackers forum posts require Firebase auth — not publicly accessible.
// The r/IndieHackers subreddit (already in KEYWORDS) covers this audience on Reddit.

// ── Send alert email ──────────────────────────────────────────────────────────
async function sendAlert(matches) {
  if (!RESEND_API_KEY) {
    console.log('[monitor] No RESEND_API_KEY set — printing matches to console instead:')
    for (const m of matches) console.log(`  [${m.keyword}] ${m.title} — ${m.url}`)
    return
  }

  const keywords = [...new Set(matches.map(m => m.keyword))]
  const sources = [...new Set(matches.map(m => m.source || 'reddit'))]
  const platformMap = { reddit: 'Reddit', hackernews: 'HN', medium: 'Medium', substack: 'Substack', quora: 'Quora', upwork: 'Upwork', fiverr: 'Fiverr', indiehackers: 'IH' }
  const platform = sources.map(s => platformMap[s] || s).join(' + ')
  const subject  = `${platform}: ${matches.length} new mention${matches.length !== 1 ? 's' : ''} — ${keywords.slice(0, 3).join(', ')}${keywords.length > 3 ? '…' : ''}`

  if (!resend) {
    console.log(`[monitor] ⚠️  Email skipped — ${subject}`)
    console.log(`[monitor] Matches: ${JSON.stringify(matches.map(m => ({ title: m.title, url: m.url })))}`)
    return
  }

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

// ── Priority scoring ──────────────────────────────────────────────────────────
// Higher score = surface earlier in email digest
function scorePost(post) {
  let score = 0
  const ageMs = Date.now() - new Date(post.createdAt).getTime()

  // Freshness — decays fast
  if (ageMs < 15  * 60 * 1000) score += 4  // < 15 min: very fresh
  else if (ageMs < 30 * 60 * 1000) score += 2  // < 30 min
  else if (ageMs < 60 * 60 * 1000) score += 1  // < 60 min

  // Engagement signals
  if (post.score    > 50) score += 3
  else if (post.score > 10) score += 2
  else if (post.score > 2)  score += 1

  if (post.comments > 20) score += 3
  else if (post.comments > 5) score += 2
  else if (post.comments > 0) score += 1

  // High-intent subreddits
  const highIntent = ['freelance','freelancers','Nigeria','lagos','SaaS','IndieHackers','ClaudeAI']
  if (highIntent.includes(post.subreddit)) score += 2

  // Body has strong intent signals
  const body = (post.body || '').toLowerCase()
  const title = (post.title || '').toLowerCase()
  const text = title + ' ' + body
  if (/\bneed\b|\blooking for\b|\bwhat (do|should) i\b|\bany (tool|app|software|way)\b/.test(text)) score += 2
  if (/\bhelp\b|\badvice\b|\brecommend\b/.test(text)) score += 1

  // AI draft generated = higher confidence it's worth engaging
  if (post.draft) score += 2

  return score
}

// ── Utility ───────────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms))

// ── Main poll cycle ───────────────────────────────────────────────────────────
let isPolling = false

async function poll() {
  if (isPolling) {
    console.log('[monitor] ⏭️  Previous cycle still running — skipping this tick')
    return
  }
  isPolling = true
  try {
    console.log(`\n[monitor] ========== POLLING CYCLE START: ${new Date().toISOString()} ==========`)
    console.log(`[monitor] Searching ${KEYWORDS.length} keywords across Reddit + HN\n`)
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

    // Hacker News
    for (const { keyword, product } of HN_KEYWORDS) {
      console.log(`[hn] Searching "${keyword}"`)
      const matches = await searchHackerNews(keyword)
      if (matches.length > 0) {
        matches.forEach(m => { m.product = product })
        console.log(`[hn] "${keyword}": ${matches.length} new`)
        matchesFound += matches.length
        allMatches.push(...matches)
      }
      await delay(1500)
    }

    // Medium
    if (process.env.INCLUDE_MEDIUM !== 'false') {
      for (const kw of KEYWORDS) {
        const matches = await searchMedium(kw, { seenIds, delay, MAX_AGE_MS: POST_MAX_AGE_HOURS * 3600000 })
        if (matches.length > 0) {
          matches.forEach(m => { m.product = kw.product })
          console.log(`[medium] "${kw.keyword}": ${matches.length} new`)
          matchesFound += matches.length
          allMatches.push(...matches)
        }
        await delay(1500)
      }
    }

    // Substack
    if (process.env.INCLUDE_SUBSTACK !== 'false') {
      for (const kw of KEYWORDS) {
        const matches = await searchSubstack(kw, { seenIds, delay, MAX_AGE_MS: POST_MAX_AGE_HOURS * 3600000 })
        if (matches.length > 0) {
          matches.forEach(m => { m.product = kw.product })
          console.log(`[substack] "${kw.keyword}": ${matches.length} new`)
          matchesFound += matches.length
          allMatches.push(...matches)
        }
        await delay(1500)
      }
    }

    // Quora
    if (process.env.INCLUDE_QUORA !== 'false') {
      for (const kw of KEYWORDS) {
        const matches = await searchQuora(kw, { seenIds, delay, MAX_AGE_MS: POST_MAX_AGE_HOURS * 3600000 })
        if (matches.length > 0) {
          matches.forEach(m => { m.product = kw.product })
          console.log(`[quora] "${kw.keyword}": ${matches.length} new`)
          matchesFound += matches.length
          allMatches.push(...matches)
        }
        await delay(2000)
      }
    }

    // Upwork Community
    if (process.env.INCLUDE_UPWORK_FORUM !== 'false') {
      for (const kw of KEYWORDS) {
        const matches = await searchUpwork(kw, { seenIds, delay, MAX_AGE_MS: POST_MAX_AGE_HOURS * 3600000 })
        if (matches.length > 0) {
          matches.forEach(m => { m.product = kw.product })
          console.log(`[upwork] "${kw.keyword}": ${matches.length} new`)
          matchesFound += matches.length
          allMatches.push(...matches)
        }
        await delay(3000)
      }
    }

    // Fiverr Community
    if (process.env.INCLUDE_FIVERR_FORUM !== 'false') {
      for (const kw of KEYWORDS) {
        const matches = await searchFiverr(kw, { seenIds, delay, MAX_AGE_MS: POST_MAX_AGE_HOURS * 3600000 })
        if (matches.length > 0) {
          matches.forEach(m => { m.product = kw.product })
          console.log(`[fiverr] "${kw.keyword}": ${matches.length} new`)
          matchesFound += matches.length
          allMatches.push(...matches)
        }
        await delay(3000)
      }
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

      // Sort by priority score so email surfaces best leads first
      allMatches.forEach(m => { m.priority_score = scorePost(m) })
      allMatches.sort((a, b) => b.priority_score - a.priority_score)
      const highPriority = allMatches.filter(m => m.priority_score >= 8).length
      if (highPriority > 0) console.log(`[monitor] 🔥 ${highPriority} HIGH PRIORITY match(es) this cycle`)

      console.log(`[monitor] Sending alert email…`)
      await sendAlert(allMatches)
      const slackUrl = process.env.SLACK_WEBHOOK_URL
      if (slackUrl) {
        await sendSlackAlert(slackUrl, allMatches)
        console.log(`[monitor] Slack alert sent — ${allMatches.length} matches`)
      }
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
  } finally {
    isPolling = false
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
console.log('━'.repeat(60))
console.log('  Ebenova Social Monitor (Reddit + HN + Medium + Substack + Quora + Upwork + Fiverr)')
console.log(`  Reddit: ${KEYWORDS.length} · HN: ${HN_KEYWORDS.length} keywords`)
console.log(`  Polling every ${POLL_MINUTES} minutes`)
console.log(`  Post max age: ${POST_MAX_AGE_HOURS} hours (adjust with POST_MAX_AGE_HOURS)`)
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
