// scripts/seed-v1-monitor.js
// One-time migration: imports V1's hardcoded keyword list into Redis as 7
// focused V2 monitors (one per product). Run once, then remove monitor.js
// from start-all.js.
//
// Usage:
//   node scripts/seed-v1-monitor.js
//   node scripts/seed-v1-monitor.js --owner=you@example.com   (override owner)
//   node scripts/seed-v1-monitor.js --dry-run                 (print plan, no writes)

import { loadEnv } from '../lib/env.js'
loadEnv()

import { Redis } from '@upstash/redis'
import { randomBytes } from 'crypto'
import { generateUnsubscribeToken } from '../lib/account-deletion.js'

// ── CLI flags ─────────────────────────────────────────────────────────────────
const DRY_RUN   = process.argv.includes('--dry-run')
const ownerArg  = process.argv.find(a => a.startsWith('--owner='))
const OWNER     = ownerArg ? ownerArg.split('=')[1] : 'dgtalquantumleap@gmail.com'
const ALERT_EMAIL = OWNER
const ONE_YEAR  = 365 * 24 * 60 * 60

// ── Redis ─────────────────────────────────────────────────────────────────────
const redis = DRY_RUN ? null : new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL  || process.env.REDIS_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN,
})

// ── Platform set for all V1 monitors ─────────────────────────────────────────
// Matches the 7 platforms V1 was polling. New platforms (github, producthunt,
// twitter, youtube, jijing, amazon) are NOT enabled here — add them via the
// dashboard if needed after migration.
const V1_PLATFORMS = ['reddit', 'hackernews', 'medium', 'substack', 'quora', 'upwork', 'fiverr']

// ── Product definitions ───────────────────────────────────────────────────────
// Each entry: { name, productContext, platforms, keywords }
// keywords: [{ keyword, subreddits }]  — type defaults to 'keyword'
const PRODUCTS = [

  // ── 1. SIGNOVA ──────────────────────────────────────────────────────────────
  {
    name: 'Signova Monitor',
    productContext: `Signova is a legal document generator. You answer a few questions and get a professional document in under 3 minutes.
Key facts:
- 27 document types: NDAs, freelance contracts, tenancy agreements, privacy policies, employment contracts, partnership agreements, loan agreements, deeds of assignment, quit notices, and more
- Free to preview the full document. $4.99 to download the clean PDF. No account needed.
- Jurisdiction-aware: Nigerian Labour Act, Lagos State Tenancy Law, Kenyan law, UK law, Canadian law, Indian Contract Act — not just US templates
- Unique feature: paste a WhatsApp negotiation and it auto-fills the contract fields
- Accepts card payments globally and USDT crypto for users in Africa
- Built by a Nigerian founder who watched a friend lose money with no contract
URL: getsignova.com
When to mention: when someone needs a specific document, can't afford a lawyer, is in a non-US jurisdiction, or just got burned by a verbal agreement.
When NOT to mention: when the problem is legal advice (not document generation), when the post is emotional, or when the person already has a lawyer.`,
    platforms: V1_PLATFORMS,
    keywords: [
      { keyword: 'freelance contract',          subreddits: ['freelance','freelancers','smallbusiness','Entrepreneur','Upwork'] },
      { keyword: 'unpaid invoice',              subreddits: ['freelance','freelancers','smallbusiness'] },
      { keyword: 'NDA template',               subreddits: ['freelance','smallbusiness','startups','SoloDevelopment'] },
      { keyword: 'tenancy agreement nigeria',   subreddits: ['Nigeria','lagos','nairaland'] },
      { keyword: "client won't pay",           subreddits: ['freelance','freelancers','smallbusiness','Entrepreneur','Upwork'] },
      { keyword: 'generate legal document',    subreddits: ['freelance','smallbusiness','Entrepreneur'] },
      { keyword: 'need a contract template',   subreddits: ['freelance','smallbusiness'] },
      { keyword: 'only had verbal agreement',  subreddits: ['smallbusiness','freelance','Entrepreneur'] },
      { keyword: 'deed of assignment',         subreddits: ['Nigeria','lagos','naija'] },
      { keyword: 'contract dispute',           subreddits: ['smallbusiness','freelance','Entrepreneur'] },
      { keyword: 'landlord tenant agreement',  subreddits: ['Nigeria','lagos','LandlordLady'] },
      { keyword: 'privacy policy generator',   subreddits: ['webdev','SaaS','startups','Entrepreneur','smallbusiness'] },
      { keyword: 'how to write a contract',    subreddits: ['freelance','smallbusiness','Entrepreneur'] },
      { keyword: 'client refused to pay',      subreddits: ['freelance','freelancers','smallbusiness','Entrepreneur'] },
      { keyword: 'no written contract',        subreddits: ['freelance','freelancers','smallbusiness','Entrepreneur'] },
      { keyword: 'nothing in writing',         subreddits: ['freelance','smallbusiness','Entrepreneur'] },
      { keyword: 'tenant refuses to leave',    subreddits: ['Nigeria','lagos','LandlordLady','naija'] },
      { keyword: 'landlord problem nigeria',   subreddits: ['Nigeria','lagos','naija','nairaland'] },
      { keyword: 'how to protect my work',     subreddits: ['freelance','freelancers','SoloDevelopment','Entrepreneur'] },
      { keyword: 'privacy policy for my app',  subreddits: ['webdev','SaaS','startups','androiddev','iOSProgramming'] },
      { keyword: 'terms and conditions website',subreddits: ['webdev','SaaS','startups','Entrepreneur','smallbusiness'] },
      { keyword: 'business partnership nigeria',subreddits: ['Nigeria','lagos','naija','Entrepreneur','smallbusiness'] },
      { keyword: 'new client contract',        subreddits: ['freelance','freelancers','agency','agencynewbies'] },
      { keyword: 'tenancy bill lagos',          subreddits: ['Nigeria','lagos','naija','nairaland'] },
      { keyword: 'rent increase lagos',         subreddits: ['Nigeria','lagos','naija'] },
      { keyword: 'landlord eviction nigeria',   subreddits: ['Nigeria','lagos','naija','LandlordLady'] },
      { keyword: 'agreed on whatsapp no contract', subreddits: ['freelance','freelancers','Nigeria','smallbusiness'] },
      { keyword: 'client changed price after',  subreddits: ['freelance','freelancers','smallbusiness','Entrepreneur'] },
      { keyword: 'no written agreement dispute',subreddits: ['freelance','smallbusiness','Entrepreneur','Nigeria'] },
      { keyword: 'paid upfront no contract',    subreddits: ['freelance','smallbusiness','Nigeria','lagos'] },
      { keyword: 'verbal deal gone wrong',      subreddits: ['freelance','smallbusiness','Entrepreneur','Nigeria'] },
      { keyword: 'Nigeria payment',            subreddits: ['Nigeria','lagos','fintech'] },
      { keyword: 'bank transfer Nigeria',      subreddits: ['Nigeria','lagos','smallbusiness'] },
      { keyword: 'USDT payment Nigeria',       subreddits: ['Nigeria','CryptoCurrency','fintech'] },
      { keyword: 'crypto payment Africa',      subreddits: ['Nigeria','Kenya','Ghana','CryptoCurrency'] },
      { keyword: 'pay with crypto Nigeria',    subreddits: ['Nigeria','CryptoCurrency','lagos'] },
      { keyword: 'NDPA compliance nigeria',    subreddits: ['Nigeria','fintech','legaltech'] },
      { keyword: 'data protection nigeria',    subreddits: ['Nigeria','fintech','startups','legaltech'] },
      { keyword: 'NDPC audit nigeria',         subreddits: ['Nigeria','fintech','legaltech'] },
      { keyword: 'data processing agreement',  subreddits: ['Nigeria','fintech','SaaS','startups','legaltech'] },
      { keyword: 'privacy policy nigeria',     subreddits: ['Nigeria','webdev','startups','SaaS'] },
      { keyword: 'GDPR compliance startup',    subreddits: ['startups','SaaS','webdev','Entrepreneur'] },
      { keyword: 'kill fee creative',          subreddits: ['freelance','freelancers','copywriting','writing','graphic_design'] },
      { keyword: 'creative brief contract',    subreddits: ['graphic_design','photography','videography','copywriting'] },
      { keyword: 'photographer contract template', subreddits: ['photography','weddingphotography','freelancers'] },
      { keyword: 'copywriter contract',        subreddits: ['copywriting','freelancers','writing'] },
      { keyword: 'client ghosted after delivery', subreddits: ['freelance','freelancers','graphic_design'] },
      { keyword: 'revision clause contract',   subreddits: ['graphic_design','freelancers','photography','videography'] },
      { keyword: 'freelance contract dispute', subreddits: ['freelance','freelancers','smallbusiness'] },
      { keyword: 'content creator contract',   subreddits: ['content_marketing','freelancers','socialmediamanagement','marketing'] },
      { keyword: 'influencer contract template',subreddits: ['socialmediamanagement','marketing','freelancers'] },
      { keyword: 'videographer contract',      subreddits: ['videography','filmmakers','freelancers','weddingphotography'] },
      { keyword: 'verbal agreement',           subreddits: ['freelance','smallbusiness'] },
      { keyword: 'need contract template',     subreddits: ['freelance','Entrepreneur','smallbusiness'] },
      { keyword: 'Upwork suspended',           subreddits: ['Upwork','freelance','freelancers'] },
      { keyword: 'Fiverr suspended',           subreddits: ['Fiverr','freelance'] },
      { keyword: 'freelancer protection',      subreddits: ['freelance','Entrepreneur'] },
      { keyword: 'independent contractor agreement', subreddits: ['freelance','smallbusiness'] },
      { keyword: '1099 contract',              subreddits: ['freelance','tax','smallbusiness'] },
    ],
  },

  // ── 2. PEEKR ────────────────────────────────────────────────────────────────
  {
    name: 'Peekr Monitor',
    productContext: `Peekr is a free iOS app that lets you share photos, videos, documents, and live camera streams from your phone to any group — instantly. Viewers scan a QR code and watch in their browser. No app download for viewers.
Key facts:
- Works for teachers sharing content with a classroom without cables or Apple TV
- Works for event/wedding photographers sharing live previews with clients during a shoot
- Works for wedding hosts building a shared guest photo gallery — guests scan and upload their own photos
- Works for church congregations displaying song lyrics from a phone
- Works for presenters sharing slides or documents with a room
- Free tier: up to 5 viewers, 30 min sessions, photos only
- Personal $4.99/month: 10 viewers, 2 hour sessions, video and documents
- Pro $14.99/month: unlimited viewers, live camera streaming
- After an event, a shared gallery with AI-curated "Best Shots" is available for 7 days
URL: getpeekr.com
When to mention: when someone needs to share their phone screen without a cable, wants to share photos live at an event, or needs a wireless presentation tool.
When NOT to mention: when the problem is about remote/online sharing (Peekr is for in-person groups), or when a simpler solution clearly exists.`,
    platforms: V1_PLATFORMS,
    keywords: [
      { keyword: 'share screen to multiple people', subreddits: ['Teachers','education','Professors','churchtech'] },
      { keyword: 'share photos with group',          subreddits: ['Teachers','photography','eventplanning','Weddings'] },
      { keyword: 'present from phone',               subreddits: ['Teachers','Professors','PublicSpeaking','education'] },
      { keyword: 'QR code presentation',             subreddits: ['Teachers','Professors','education','PublicSpeaking'] },
      { keyword: 'share PDF to class',               subreddits: ['Teachers','Professors','education'] },
      { keyword: 'wireless presentation app',        subreddits: ['Teachers','AV','hometheater','techsupport'] },
      { keyword: 'show photos without projector',    subreddits: ['Teachers','photography','Weddings','eventplanning'] },
      { keyword: 'no projector classroom',           subreddits: ['Teachers','education','Professors','SubstituteTeachers'] },
      { keyword: 'share slides with students',       subreddits: ['Teachers','Professors','education','OnlineLearning'] },
      { keyword: 'google classroom alternative',     subreddits: ['Teachers','education','Professors','edtech'] },
      { keyword: 'show video to class',              subreddits: ['Teachers','Professors','education'] },
      { keyword: 'church presentation software',     subreddits: ['churchtech','Christianity','church','Reformed'] },
      { keyword: 'share photos at wedding',          subreddits: ['Weddings','wedding','weddingplanning','eventplanning'] },
      { keyword: 'display photos at event',          subreddits: ['eventplanning','Weddings','DIY','photography'] },
      { keyword: 'cast phone to screen',             subreddits: ['techsupport','Teachers','AV','hometheater'] },
      { keyword: 'present without HDMI',             subreddits: ['Teachers','techsupport','AV','Professors'] },
      { keyword: 'share screen without cable',       subreddits: ['Teachers','techsupport','AV','Professors','education'] },
      { keyword: 'show phone screen to class',       subreddits: ['Teachers','education','Professors'] },
      { keyword: 'church screen sharing',            subreddits: ['churchtech','Christianity','church','Reformed'] },
      { keyword: 'photographer share photos live',   subreddits: ['photography','weddingphotography','Weddings','eventplanning'] },
      { keyword: 'live slideshow wedding',           subreddits: ['Weddings','weddingplanning','eventplanning','photography'] },
      { keyword: 'present without laptop',           subreddits: ['Teachers','PublicSpeaking','techsupport','Professors'] },
      { keyword: 'how to show students my phone',    subreddits: ['Teachers','education','Professors','SubstituteTeachers'] },
      { keyword: 'screen mirroring without app',     subreddits: ['techsupport','Teachers','AV','hometheater'] },
      { keyword: 'share video with audience',        subreddits: ['Teachers','PublicSpeaking','eventplanning','AV'] },
      { keyword: 'show lyrics on screen church',     subreddits: ['churchtech','Christianity','church','Reformed'] },
      { keyword: 'worship display small church',     subreddits: ['churchtech','Christianity','church','Reformed'] },
      { keyword: 'photographer live preview',        subreddits: ['weddingphotography','photography','Weddings'] },
      { keyword: 'app for sharing content classroom',subreddits: ['Teachers','education','edtech','Professors'] },
      { keyword: 'free tool for teachers share',     subreddits: ['Teachers','education','edtech','SubstituteTeachers'] },
      { keyword: 'congregation song lyrics phone',   subreddits: ['churchtech','Christianity','church','Reformed'] },
      { keyword: 'wedding slideshow live guests',    subreddits: ['Weddings','weddingplanning','weddingphotography'] },
    ],
  },

  // ── 3. FIELDOPS ─────────────────────────────────────────────────────────────
  {
    name: 'FieldOps Monitor',
    productContext: `FieldOps is a web-based operations platform for Nigerian service businesses — cleaning companies, logistics firms, facility managers.
Key facts:
- Replaces WhatsApp group chats and paper records with a proper system
- Booking management, staff mobile app, job scheduling, automated invoicing
- Built for African service business owners who run operations informally
URL: ebenova.net
When to mention: when someone is running a cleaning or field service business and struggling with scheduling, staff management, or invoicing.
When NOT to mention: generic small business questions not specific to field/service operations.`,
    platforms: ['reddit', 'medium', 'quora'],
    keywords: [
      { keyword: 'cleaning business software',       subreddits: ['EntrepreneurRideAlong','smallbusiness','Entrepreneur'] },
      { keyword: 'field service management',         subreddits: ['smallbusiness','Entrepreneur','startups'] },
      { keyword: 'managing cleaning staff',          subreddits: ['smallbusiness','EntrepreneurRideAlong','Nigeria'] },
      { keyword: 'scheduling cleaning jobs',         subreddits: ['smallbusiness','cleaning','housekeeping'] },
      { keyword: 'running cleaning company nigeria', subreddits: ['Nigeria','lagos','naija'] },
      { keyword: 'invoicing for service business',   subreddits: ['smallbusiness','freelance','Entrepreneur'] },
      { keyword: 'service business management app',  subreddits: ['smallbusiness','Entrepreneur','startups'] },
      { keyword: 'booking system',                   subreddits: ['smallbusiness','Entrepreneur','CleaningBusiness'] },
      { keyword: 'service business software',        subreddits: ['smallbusiness','Entrepreneur'] },
      { keyword: 'cleaning business app',            subreddits: ['CleaningBusiness','smallbusiness'] },
      { keyword: 'HVAC software',                    subreddits: ['HVAC','smallbusiness'] },
    ],
  },

  // ── 4. EBENOVA API ──────────────────────────────────────────────────────────
  {
    name: 'Ebenova API Monitor',
    productContext: `The Ebenova API lets developers generate legal documents programmatically — NDAs, freelance contracts, privacy policies, employment agreements, and more — with a single API call.
Key facts:
- REST API, JSON in/out, responses in under 2 seconds
- 27 document types, jurisdiction-aware (Nigerian, UK, Canadian, Indian, Kenyan law)
- No per-seat pricing — pay per document generation or flat monthly
- Built for SaaS founders, legal tech startups, and AI agent builders who need document generation without building it themselves
- Works in any language with an HTTP client
URL: api.ebenova.dev
When to mention: when a developer or SaaS founder needs to generate contracts, NDAs, or legal documents inside their own product. When someone asks about document automation APIs or legal tech APIs.
When NOT to mention: when the person just needs a single document for themselves (point them to Signova instead), or when they're asking about legal advice not document generation.`,
    platforms: ['reddit', 'hackernews', 'medium', 'substack'],
    keywords: [
      { keyword: 'legal document API',              subreddits: ['webdev','SaaS','startups','IndieHackers'] },
      { keyword: 'contract generation API',         subreddits: ['webdev','SaaS','IndieHackers'] },
      { keyword: 'document automation API',         subreddits: ['webdev','SaaS'] },
      { keyword: 'API for legal tech',              subreddits: ['webdev','legaltech','SaaS'] },
      { keyword: 'generate contracts programmatically', subreddits: ['webdev','SaaS','startups'] },
      { keyword: 'NDA API',                         subreddits: ['webdev','SaaS','startups'] },
      { keyword: 'document generation API',         subreddits: ['webdev','SaaS'] },
      { keyword: 'PDF generation API',              subreddits: ['webdev','SaaS'] },
      { keyword: 'invoice API',                     subreddits: ['webdev','SaaS','freelance'] },
      { keyword: 'API for contracts',               subreddits: ['webdev','IndieHackers'] },
      { keyword: 'legal tech API',                  subreddits: ['webdev','legaltech'] },
      { keyword: 'compliance API',                  subreddits: ['fintech','SaaS'] },
      { keyword: 'KYC API',                         subreddits: ['fintech','SaaS','startups'] },
      { keyword: 'AI agent API',                    subreddits: ['artificial','SaaS'] },
      { keyword: 'document automation',             subreddits: ['webdev','SaaS'] },
    ],
  },

  // ── 5. EBENOVA MCP ──────────────────────────────────────────────────────────
  {
    name: 'Ebenova MCP Monitor',
    productContext: `The Ebenova MCP server lets AI agents (Claude Desktop, Cursor, custom agents) generate professional legal documents directly from a conversation — no copy-paste, no browser.
Key facts:
- Model Context Protocol (MCP) server — works with any MCP-compatible AI client
- Generates NDAs, contracts, privacy policies, tenancy agreements, and more via natural language
- Listed on Smithery and Glama MCP directories
- Free to try; connects to the same document engine powering Signova
URL: api.ebenova.dev
When to mention: when someone is building or using AI agents and wants them to be able to generate legal documents, or when someone is asking about useful MCP servers for Claude Desktop or Cursor.
When NOT to mention: when the person is not using Claude Desktop or an MCP-compatible tool.`,
    platforms: ['reddit', 'hackernews', 'medium'],
    keywords: [
      { keyword: 'MCP server',               subreddits: ['artificial','ClaudeAI','LocalLLaMA'] },
      { keyword: 'Claude Desktop tools',     subreddits: ['ClaudeAI','artificial'] },
      { keyword: 'AI agent tools',           subreddits: ['artificial','SaaS','startups','LocalLLaMA','LangChain'] },
      { keyword: 'model context protocol',   subreddits: ['ClaudeAI','artificial','webdev'] },
      { keyword: 'AI agent framework',       subreddits: ['artificial','webdev','SaaS'] },
      { keyword: 'Claude AI automation',     subreddits: ['ClaudeAI','artificial','automation'] },
      { keyword: 'Model Context Protocol',   subreddits: ['ClaudeAI','artificial','webdev'] },
      { keyword: 'Cursor IDE tools',         subreddits: ['CursorIDE','webdev'] },
      { keyword: 'build MCP server',         subreddits: ['ClaudeAI','webdev'] },
      { keyword: 'MCP server tutorial',      subreddits: ['ClaudeAI','artificial'] },
      { keyword: 'Smithery MCP',             subreddits: ['ClaudeAI','artificial'] },
      { keyword: 'Glama MCP',               subreddits: ['ClaudeAI','artificial'] },
    ],
  },

  // ── 6. SCOPE GUARD ──────────────────────────────────────────────────────────
  {
    name: 'Scope Guard Monitor',
    productContext: `Scope Guard is Signova's contract enforcement layer for freelancers — it helps you generate change orders, enforce satisfaction clauses, and document scope disputes before they become payment disputes.
Key facts:
- Built into Signova — not a separate product
- Generates change order documents when clients add work mid-project
- Tracks what was agreed, what changed, and what was approved in writing
- Helps freelancers who got burned by scope creep or "that's not what I meant" clients
URL: getsignova.com
When to mention: when a freelancer is dealing with scope creep, a client disputing work, or asking how to protect themselves from contract disputes mid-project.
When NOT to mention: when the post is about a payment that already failed to come in — Signova's main contract templates are more relevant then.`,
    platforms: ['reddit', 'medium', 'quora', 'upwork'],
    keywords: [
      { keyword: 'scope creep',              subreddits: ['freelance','agency','agencynewbies','SoloDevelopment','webdev','IndieHackers'] },
      { keyword: 'change order',             subreddits: ['freelance','Entrepreneur','smallbusiness'] },
      { keyword: 'satisfaction clause',      subreddits: ['freelance','legal','smallbusiness'] },
      { keyword: 'contract enforcement',     subreddits: ['freelance','legal','Entrepreneur'] },
      { keyword: 'freelance payment dispute',subreddits: ['freelance','freelancers','legal'] },
      { keyword: 'breach of contract freelance', subreddits: ['freelance','legal','Entrepreneur'] },
    ],
  },

  // ── 7. POCKETBRIDGE ─────────────────────────────────────────────────────────
  {
    name: 'PocketBridge Monitor',
    productContext: `PocketBridge is a payment API for African businesses — it handles payouts, remittances, and collections for companies operating in Nigeria, Ghana, Kenya, and other African markets.
Key facts:
- Alternative to Stripe for African-market businesses where Stripe isn't available
- Supports bank transfers, mobile money, and USDT crypto payouts
- Built for fintech startups and SaaS companies serving African users
URL: ebenova.net
When to mention: when a developer or founder is building a product for African users and struggling with payments infrastructure, or when someone explicitly asks about Stripe alternatives for Nigeria/Africa.
When NOT to mention: when the person is a consumer looking to send or receive money personally — this is a developer/business API.`,
    platforms: ['reddit', 'hackernews', 'medium'],
    keywords: [
      { keyword: 'payment API Africa',       subreddits: ['fintech','Africa','Nigeria'] },
      { keyword: 'payout API',               subreddits: ['fintech','SaaS'] },
      { keyword: 'remittance API',           subreddits: ['fintech','Nigeria','Africa'] },
      { keyword: 'Stripe alternative',       subreddits: ['SaaS','IndieHackers','Nigeria'] },
      { keyword: 'Flutterwave alternative',  subreddits: ['fintech','Nigeria','Africa'] },
    ],
  },

]

// ── Seed ──────────────────────────────────────────────────────────────────────
async function seed() {
  console.log('━'.repeat(60))
  console.log('  V1 → V2 Monitor Migration Seed')
  console.log(`  Owner:   ${OWNER}`)
  console.log(`  Products: ${PRODUCTS.length}`)
  console.log(`  Mode:     ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE — writing to Redis'}`)
  console.log('━'.repeat(60))

  const ownerSetKey = `insights:monitors:${OWNER}`
  const created = []

  for (const product of PRODUCTS) {
    const id              = `mon_${randomBytes(12).toString('hex')}`
    const unsubToken      = generateUnsubscribeToken()
    const shareToken      = randomBytes(24).toString('hex')
    const now             = new Date().toISOString()

    const monitor = {
      id,
      owner:              OWNER,
      name:               product.name,
      keywords:           product.keywords.map(k => ({
        keyword:    k.keyword,
        subreddits: k.subreddits || [],
        type:       'keyword',
      })),
      productContext:     product.productContext,
      alertEmail:         ALERT_EMAIL,
      slackWebhookUrl:    '',
      webhookUrl:         '',
      replyTone:          'conversational',
      productUrl:         '',
      utmSource:          'ebenova-insights',
      utmMedium:          'community',
      utmCampaign:        product.name.toLowerCase().replace(/\s+/g, '-'),
      platforms:          product.platforms,
      // Legacy compat flags (monitor-v2.js migrateLegacyPlatforms reads these)
      includeMedium:      product.platforms.includes('medium'),
      includeSubstack:    product.platforms.includes('substack'),
      includeQuora:       product.platforms.includes('quora'),
      includeUpworkForum: product.platforms.includes('upwork'),
      includeFiverrForum: product.platforms.includes('fiverr'),
      emailEnabled:       true,
      unsubscribeToken:   unsubToken,
      shareToken,
      mode:               'keyword',
      minConsistency:     'all',
      totalBuildersFound: 0,
      brandName:          '',
      diasporaCorridor:   null,
      dealValue:          0,
      active:             true,
      plan:               'scale',   // system monitor — no plan-limit enforcement at poll time
      createdAt:          now,
      lastPollAt:         null,
      totalMatchesFound:  0,
    }

    console.log(`\n  [${product.name}]`)
    console.log(`    id:        ${id}`)
    console.log(`    keywords:  ${monitor.keywords.length}`)
    console.log(`    platforms: ${product.platforms.join(', ')}`)

    if (!DRY_RUN) {
      await redis.set(`insights:monitor:${id}`, JSON.stringify(monitor))
      await redis.expire(`insights:monitor:${id}`, ONE_YEAR)
      await redis.set(`unsubscribe:${unsubToken}`, id)
      await redis.expire(`unsubscribe:${unsubToken}`, ONE_YEAR)
      await redis.set(`report:token:${shareToken}`, id)
      await redis.expire(`report:token:${shareToken}`, ONE_YEAR)
      await redis.sadd('insights:active_monitors', id)
      await redis.sadd(ownerSetKey, id)
      console.log(`    ✓ written to Redis`)
    } else {
      console.log(`    (dry-run — skipped writes)`)
    }

    created.push({ id, name: product.name, keywords: monitor.keywords.length })
  }

  console.log('\n' + '━'.repeat(60))
  if (DRY_RUN) {
    console.log('  DRY RUN complete — no data written.')
    console.log('  Re-run without --dry-run to apply.')
  } else {
    console.log(`  Migration complete — ${created.length} monitors created.`)
    console.log(`  Total keywords: ${created.reduce((s, m) => s + m.keywords, 0)}`)
    console.log('\n  Next step: remove monitor.js from start-all.js and redeploy.')
  }
  console.log('━'.repeat(60))
}

seed().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
