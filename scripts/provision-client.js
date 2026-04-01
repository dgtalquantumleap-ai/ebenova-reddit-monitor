#!/usr/bin/env node
// scripts/provision-client.js
// One-shot script to provision a client monitor directly into Redis.
// Run once per client onboarding. Safe to re-run — won't duplicate if ID matches.
//
// Usage:
//   node scripts/provision-client.js
//   node scripts/provision-client.js --client=phrase2373
//   node scripts/provision-client.js --dry-run
//
// The CLIENT_CONFIGS map below holds all client configs.
// Add a new entry for each new client. IDs are stable — rerunning is safe.

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set')
  return new Redis({ url, token })
}

// ══════════════════════════════════════════════════════════════════════════════
// CLIENT CONFIGS
// Add one entry per client. monitor_id must be stable (don't change after first run).
// ══════════════════════════════════════════════════════════════════════════════

const CLIENT_CONFIGS = {

  // ── Client: Some_Phrase_2373 — AI Recruitment Platform ─────────────────────
  // Reddit DM: Mar 26, interested in semantic search for AI + recruiting
  // Plan: growth (V2 beta, $49/mo founding rate)
  phrase2373: {
    monitor_id:    'mon_phrase2373_v2',
    owner:         'phrase2373@ebenova-client',  // internal owner key (not their email yet)
    name:          'AI Recruiting Monitor — V2 Beta',
    alert_email:   process.env.PHRASE2373_EMAIL || 'akin@ebenova.dev', // swap to their email when confirmed
    plan:          'growth',
    product_context: `We run an AI-powered recruitment platform that connects software engineers and technical candidates with high-growth startups. Our platform uses AI to match candidates based on skills, experience, and cultural fit — not just keywords on a resume. Candidates get curated startup job opportunities without shotgun-applying to hundreds of listings. Startups find pre-vetted technical talent 3x faster than traditional job boards or headhunters.

Key facts:
- We focus on early-stage (Seed, Series A/B) tech startups — not big tech, not agencies
- Candidates are typically software engineers, ML engineers, product managers, data scientists
- Pain we solve for candidates: endless applications with no responses, LinkedIn spam from irrelevant recruiters, never knowing which startups are actually hiring
- Pain we solve for startups: wasting time interviewing unqualified candidates, expensive headhunters (20-30% fee), sourcing taking 3+ months

When to mention the platform:
- When a software engineer or PM is frustrated with job searching or LinkedIn spam
- When someone says they want to join a startup but don't know where to start
- When a startup founder complains about hiring difficulty or recruiter costs
- When someone asks how to find AI/ML engineering jobs
- When a candidate wants curated opportunities instead of applying blindly

When NOT to mention it:
- Corporate job seekers who want big company stability
- Recruiting agencies looking for a tool (we're not a tool for recruiters)
- Post is about work visas, salary negotiation after a specific offer, or HR compliance
- The post is clearly venting without asking for help`,

    keywords: [
      // ── Startup job seeker pain (candidate side) ───────────────────────────
      {
        keyword: 'looking for startup job',
        subreddits: ['cscareerquestions', 'startups', 'forhire', 'cscareeradvice'],
        semantic_intent: 'software engineer wants to work at a startup or early-stage company',
      },
      {
        keyword: 'how to get hired at startup',
        subreddits: ['cscareerquestions', 'startups', 'ExperiencedDevs'],
        semantic_intent: 'developer or engineer wants tips to land a job at a startup',
      },
      {
        keyword: 'startup vs big tech',
        subreddits: ['cscareerquestions', 'startups', 'ExperiencedDevs', 'cscareeradvice'],
        semantic_intent: 'engineer weighing startup opportunity against FAANG or big company',
      },
      {
        keyword: 'breaking into AI industry',
        subreddits: ['MachineLearning', 'artificial', 'cscareerquestions', 'datascience'],
        semantic_intent: 'person wants to get a job in AI or machine learning',
      },
      {
        keyword: 'ML engineer job search',
        subreddits: ['MachineLearning', 'cscareerquestions', 'datascience', 'MLjobs'],
        semantic_intent: 'ML or AI engineer looking for job opportunities',
      },
      {
        keyword: 'job search frustrating no responses',
        subreddits: ['cscareerquestions', 'recruitinghell', 'jobs', 'cscareeradvice'],
        semantic_intent: 'developer or engineer is frustrated with job applications going nowhere',
      },
      {
        keyword: 'LinkedIn recruiter spam irrelevant',
        subreddits: ['cscareerquestions', 'ExperiencedDevs', 'recruitinghell', 'cscareeradvice'],
        semantic_intent: 'engineer is tired of irrelevant recruiter messages and wants better job matching',
      },
      {
        keyword: 'find remote startup engineering job',
        subreddits: ['cscareerquestions', 'remotework', 'forhire', 'startups'],
        semantic_intent: 'software engineer looking for remote work at a startup',
      },

      // ── Startup hiring pain (company side) ────────────────────────────────
      {
        keyword: 'hiring engineers startup',
        subreddits: ['startups', 'Entrepreneur', 'YCombinator', 'SaaS', 'IndieHackers'],
        semantic_intent: 'startup founder or hiring manager struggling to find and hire engineers',
      },
      {
        keyword: 'find technical talent startup',
        subreddits: ['startups', 'Entrepreneur', 'YCombinator', 'venturecapital'],
        semantic_intent: 'early-stage startup trying to source developers or engineers',
      },
      {
        keyword: 'recruiting engineers expensive',
        subreddits: ['startups', 'Entrepreneur', 'recruiting', 'YCombinator'],
        semantic_intent: 'startup founder frustrated with expensive recruiting agencies or long hiring times',
      },
      {
        keyword: 'first engineering hire startup',
        subreddits: ['startups', 'Entrepreneur', 'YCombinator', 'SoloDevelopment'],
        semantic_intent: 'early-stage founder making their first technical hire',
      },
      {
        keyword: 'how to hire AI engineers',
        subreddits: ['startups', 'MachineLearning', 'artificial', 'Entrepreneur', 'recruiting'],
        semantic_intent: 'startup looking to hire ML or AI engineers',
      },

      // ── AI in recruiting (meta — competitors + thought leadership) ─────────
      {
        keyword: 'AI recruitment platform',
        subreddits: ['recruiting', 'HR', 'startups', 'artificial', 'SaaS'],
        semantic_intent: 'person evaluating or asking about AI tools for recruitment',
      },
      {
        keyword: 'automated candidate matching',
        subreddits: ['recruiting', 'HR', 'startups', 'artificial'],
        semantic_intent: 'recruiter or founder interested in AI-powered candidate matching',
      },
      {
        keyword: 'alternative to LinkedIn recruiting',
        subreddits: ['recruiting', 'HR', 'startups', 'cscareerquestions', 'Entrepreneur'],
        semantic_intent: 'startup or candidate looking for better alternatives to LinkedIn for hiring',
      },

      // ── YC / high-growth startup community ────────────────────────────────
      {
        keyword: 'YC startup hiring',
        subreddits: ['YCombinator', 'startups', 'Entrepreneur'],
        semantic_intent: 'YC-backed or growth-stage startup looking to hire',
      },
      {
        keyword: 'seed stage startup engineers',
        subreddits: ['YCombinator', 'startups', 'venturecapital', 'Entrepreneur'],
        semantic_intent: 'early-stage funded startup trying to build their engineering team',
      },

      // ── Product manager job search ─────────────────────────────────────────
      {
        keyword: 'product manager startup job',
        subreddits: ['product_management', 'ProductManagement', 'startups', 'cscareerquestions'],
        semantic_intent: 'product manager looking for a role at a startup',
      },
    ],
  },

  // ── Template for next client (copy + fill in) ──────────────────────────────
  // next_client: {
  //   monitor_id: 'mon_clientname_v1',
  //   owner: 'clientname@ebenova-client',
  //   name: 'Monitor Name',
  //   alert_email: 'client@email.com',
  //   plan: 'starter',
  //   product_context: `...`,
  //   keywords: [
  //     { keyword: '...', subreddits: [...], semantic_intent: '...' },
  //   ],
  // },
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVISIONING LOGIC
// ══════════════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2)
const dryRun    = args.includes('--dry-run')
const clientArg = args.find(a => a.startsWith('--client='))?.split('=')[1]

async function provisionClient(clientKey, config) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  Provisioning: ${config.name}`)
  console.log(`  Monitor ID:   ${config.monitor_id}`)
  console.log(`  Owner:        ${config.owner}`)
  console.log(`  Plan:         ${config.plan}`)
  console.log(`  Keywords:     ${config.keywords.length}`)
  console.log(`  Alert email:  ${config.alert_email}`)
  console.log(`  Dry run:      ${dryRun}`)
  console.log(`${'─'.repeat(60)}`)

  const now = new Date().toISOString()

  // Clean keywords into the format monitor-v2.js expects
  const cleanKeywords = config.keywords.map(k => ({
    keyword:        k.keyword.trim(),
    subreddits:     k.subreddits || [],
    productContext: k.semantic_intent || '',   // used as per-keyword semantic hint
    nairalandSection: k.nairalandSection || null,
  }))

  const monitor = {
    id:                 config.monitor_id,
    owner:              config.owner,
    name:               config.name,
    keywords:           cleanKeywords,
    productContext:     config.product_context,
    alertEmail:         config.alert_email,
    active:             true,
    plan:               config.plan,
    createdAt:          now,
    lastPollAt:         null,
    totalMatchesFound:  0,
    provisionedBy:      'provision-client.js',
    provisionedAt:      now,
    clientKey,
  }

  console.log('\nMonitor config:')
  console.log(JSON.stringify({
    ...monitor,
    productContext: monitor.productContext.slice(0, 120) + '…',
    keywords: monitor.keywords.map(k => `${k.keyword} [${k.subreddits.join(', ')}]`),
  }, null, 2))

  if (dryRun) {
    console.log('\n⚡ DRY RUN — nothing written to Redis')
    return
  }

  const redis = getRedis()

  // Check if already exists
  const existing = await redis.get(`insights:monitor:${config.monitor_id}`)
  if (existing) {
    const ex = typeof existing === 'string' ? JSON.parse(existing) : existing
    console.log(`\n⚠️  Monitor already exists (created ${ex.createdAt})`)
    console.log('   Updating alert_email, productContext, keywords, plan only…')
    const updated = {
      ...ex,
      name:           config.name,
      keywords:       cleanKeywords,
      productContext: config.product_context,
      alertEmail:     config.alert_email,
      plan:           config.plan,
      updatedAt:      now,
    }
    await redis.set(`insights:monitor:${config.monitor_id}`, JSON.stringify(updated))
    console.log('✅ Monitor updated')
  } else {
    await redis.set(`insights:monitor:${config.monitor_id}`, JSON.stringify(monitor))
    console.log('✅ Monitor config written')
  }

  // Add to owner's monitor set
  await redis.sadd(`insights:monitors:${config.owner}`, config.monitor_id)
  console.log(`✅ Added to insights:monitors:${config.owner}`)

  // Add to global active set (picked up by poll cycle)
  await redis.sadd('insights:active_monitors', config.monitor_id)
  console.log('✅ Added to insights:active_monitors (will run next poll cycle)')

  console.log(`\n🎉 Done! Monitor "${config.name}" is active.`)
  console.log(`   Next alert: within ${config.plan === 'growth' ? '15' : '15'} minutes`)
  console.log(`   Alert email: ${config.alert_email}`)
}

async function main() {
  const clientsToRun = clientArg
    ? [clientArg]
    : Object.keys(CLIENT_CONFIGS)

  for (const key of clientsToRun) {
    const config = CLIENT_CONFIGS[key]
    if (!config) {
      console.error(`❌ Unknown client: "${key}"`)
      console.error(`   Available: ${Object.keys(CLIENT_CONFIGS).join(', ')}`)
      process.exit(1)
    }
    await provisionClient(key, config)
  }

  console.log('\n✅ All done.\n')
  process.exit(0)
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message)
  process.exit(1)
})
