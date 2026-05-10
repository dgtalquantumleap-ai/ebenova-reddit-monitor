#!/usr/bin/env node
// bin/keyword-audit.js — read-only AI keyword audit for active monitors.
//
// For each monitor (or one specific id), prints:
//   - The current user-defined keywords
//   - The AI-recommended broader keyword set (one DeepSeek call per monitor)
//   - The cached `expanded_keywords` if any
// Operator reviews each suggestion and decides whether to apply via the
// dashboard's edit-monitor flow or PATCH /v1/monitors/:id.
//
// This script never writes to monitor records — that's intentional. Updating
// a user's keyword config without their consent is a CLAUDE.md hard
// constraint ("Never break existing monitors"). For the cache fields, see
// bin/regen-keyword-expansion.js (sibling script).
//
// Usage:
//   node bin/keyword-audit.js                    # all active monitors
//   node bin/keyword-audit.js --monitor <id>     # one specific
//   node bin/keyword-audit.js --zero-match       # only monitors that have 0 matches
//
// Env required: UPSTASH_REDIS_REST_URL/TOKEN, plus DEEPSEEK_API_KEY (or the
// fallback chain — Groq, Claude). Run via `railway run` to inherit prod env.

import { Redis } from '@upstash/redis'
import { loadEnv } from '../lib/env.js'
import { routeAI } from '../lib/ai-router.js'

loadEnv()

const args = process.argv.slice(2)
const monitorIdx = args.indexOf('--monitor')
const monitorFilter = monitorIdx >= 0 ? args[monitorIdx + 1] : null
const zeroMatchOnly = args.includes('--zero-match')

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

async function getMonitor(id) {
  const raw = await redis.get(`insights:monitor:${id}`)
  if (!raw) return null
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null }
}

async function pickTargets() {
  if (monitorFilter) return [monitorFilter]
  const ids = (await redis.smembers('insights:active_monitors')) || []
  if (!zeroMatchOnly) return ids
  const out = []
  for (const id of ids) {
    const matches = (await redis.lrange(`insights:matches:${id}`, 0, 999)) || []
    if (matches.length === 0) out.push(id)
  }
  return out
}

// Builds an audit prompt the AI can answer in JSON. The router will pick
// DEEPSEEK by default per TASK_ROUTING.expand_keywords, with Groq fallback.
function buildPrompt(productContext, currentKeywords) {
  return `You are a B2B sales intelligence analyst. Below is a product description and the keyword set this customer is using to search Reddit, Hacker News, GitHub, and other developer communities for potential customers.

The current keywords may be too narrow (e.g. brand-name comparisons that have low Reddit volume) or too generic (e.g. industry-wide terms that drown out signal). Your job is to suggest 8-12 BETTER keywords this monitor should use to surface buyer-intent posts.

Good keywords:
- Capture pain points or jobs-to-be-done in the user's voice ("how do I find...", "looking for a tool that...", "frustrated with...")
- Are specific enough to filter out noise but broad enough to actually appear weekly on Reddit
- Mix general category terms with specific use-case phrases
- Avoid product names/brand comparisons unless those have known traffic

Return ONLY a JSON object with this shape:
{
  "audit": "<one sentence on what's strong/weak about the current keywords>",
  "suggested": ["<keyword1>", "<keyword2>", ...]
}

PRODUCT CONTEXT:
${productContext || '(none provided)'}

CURRENT KEYWORDS (${currentKeywords.length}):
${currentKeywords.map(k => `- ${k}`).join('\n') || '(none)'}`
}

function parseAudit(text) {
  if (!text) return null
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  const raw = fence ? fence[1] : text
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    const obj = JSON.parse(raw.slice(start, end + 1))
    if (!obj || typeof obj !== 'object') return null
    return {
      audit: typeof obj.audit === 'string' ? obj.audit : '',
      suggested: Array.isArray(obj.suggested)
        ? obj.suggested.filter(s => typeof s === 'string').map(s => s.trim()).filter(Boolean).slice(0, 15)
        : [],
    }
  } catch { return null }
}

const targets = await pickTargets()
console.log(`Auditing ${targets.length} monitor(s)\n`)

for (const id of targets) {
  const m = await getMonitor(id)
  if (!m) { console.warn(`  ${id}: monitor record not found, skipping\n`); continue }
  const kws = (m.keywords || []).map(k => typeof k === 'string' ? k : (k?.keyword || '')).filter(Boolean)
  const expandedRaw = await redis.get(`monitor:${id}:expanded_keywords`)
  let expanded = []
  if (expandedRaw) try { expanded = typeof expandedRaw === 'string' ? JSON.parse(expandedRaw) : expandedRaw } catch {}

  console.log(`▸ ${m.name || '(unnamed)'}  [${id}]`)
  console.log(`  Owner:           ${m.alertEmail || '?'}`)
  console.log(`  productContext:  ${(m.productContext || '(empty)').slice(0, 140)}${(m.productContext || '').length > 140 ? '…' : ''}`)
  console.log(`  Current keywords (${kws.length}):`)
  for (const k of kws.slice(0, 12)) console.log(`    · "${k}"`)
  if (kws.length > 12) console.log(`    … +${kws.length - 12} more`)
  if (expanded.length) {
    console.log(`  Cached expansions (${expanded.length}): ${expanded.slice(0, 6).map(e => `"${e}"`).join(', ')}${expanded.length > 6 ? `, +${expanded.length - 6}` : ''}`)
  } else {
    console.log(`  Cached expansions: (none)`)
  }

  if (kws.length === 0 && !m.productContext) {
    console.log(`  → SKIP — no keywords + no productContext (user needs to fill these in)\n`)
    continue
  }

  const prompt = buildPrompt(m.productContext || '', kws)
  let r
  try {
    r = await routeAI({ task: 'expand_keywords', prompt, maxTokens: 600, temperature: 0.6, jsonMode: true })
  } catch (err) {
    console.log(`  → AI call threw: ${err.message}\n`)
    continue
  }
  if (!r?.ok) {
    console.log(`  → AI call failed (${r?.error || 'unknown'})`)
    if (r?.attempts) for (const a of r.attempts) console.log(`     ${a.provider}: ${a.status}${a.error ? ' — ' + a.error.slice(0, 80) : ''}`)
    console.log('')
    continue
  }
  const audit = parseAudit(r.text)
  if (!audit) {
    console.log(`  → AI returned non-JSON output (model: ${r.model})`)
    console.log(`     Raw text: ${(r.text || '').slice(0, 200)}\n`)
    continue
  }
  console.log(`  AI verdict (${r.model}):`)
  console.log(`    "${audit.audit}"`)
  console.log(`  Suggested keywords (${audit.suggested.length}):`)
  for (const s of audit.suggested) console.log(`    · "${s}"`)
  console.log('')
}

console.log('Apply via the dashboard edit-monitor flow, or:')
console.log('  curl -X PATCH /v1/monitors/<id> -d \'{"keywords":[{"keyword":"<new1>"}, ...]}\'')
