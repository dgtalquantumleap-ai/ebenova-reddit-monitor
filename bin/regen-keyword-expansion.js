#!/usr/bin/env node
// bin/regen-keyword-expansion.js — re-run the AI keyword expander for one
// monitor or for every active monitor that has zero matches / no cache.
//
// Sibling of bin/regen-subreddit-cache.js. Same rationale: api-server.js
// fires expandKeywords() once, fire-and-forget, when a monitor is created.
// If that call failed, the monitor never gets `monitor:<id>:expanded_keywords`
// populated and the worker scans only the user's literal keywords. This
// script regenerates the cache without touching the user's chosen keywords
// (those stay in monitor.keywords; the cache is additive).
//
// Usage:
//   node bin/regen-keyword-expansion.js <monitorId>
//   node bin/regen-keyword-expansion.js --zero-match
//   node bin/regen-keyword-expansion.js --missing
//   node bin/regen-keyword-expansion.js ... --dry-run
//
// Env required: UPSTASH_REDIS_REST_URL/TOKEN, plus a working AI provider key
// (DEEPSEEK_API_KEY default; Groq + Claude as fallback per ai-router).
// Run via `railway run` to inherit prod env.

import { Redis } from '@upstash/redis'
import { loadEnv } from '../lib/env.js'
import { expandKeywords } from '../lib/keyword-expander.js'

loadEnv()

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const mode = args.find(a => !a.startsWith('--')) ||
  (args.includes('--zero-match') ? '__zero_match__' :
   args.includes('--missing')    ? '__missing__'    : null)

if (!mode) {
  console.error('Usage: node bin/regen-keyword-expansion.js <monitorId> | --zero-match | --missing  [--dry-run]')
  process.exit(2)
}

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
  if (mode !== '__zero_match__' && mode !== '__missing__') return [mode]
  const ids = (await redis.smembers('insights:active_monitors')) || []
  const out = []
  for (const id of ids) {
    const matchCount = (await redis.lrange(`insights:matches:${id}`, 0, 999)).length
    const hasCache = await redis.get(`monitor:${id}:expanded_keywords`)
    if (mode === '__zero_match__' && matchCount === 0) out.push(id)
    if (mode === '__missing__'    && !hasCache)         out.push(id)
  }
  return out
}

const targets = await pickTargets()
if (targets.length === 0) {
  console.log('No matching monitors. Nothing to do.')
  process.exit(0)
}

console.log(`Targets: ${targets.length}${dryRun ? ' (dry-run)' : ''}\n`)
for (const id of targets) {
  const m = await getMonitor(id)
  if (!m) { console.warn(`  ${id}: monitor record not found, skipping`); continue }
  const kws = (m.keywords || [])
  console.log(`▸ ${m.name || '(unnamed)'}  [${id}]`)
  console.log(`  Owner:       ${m.alertEmail || '?'}`)
  console.log(`  Keywords:    ${kws.length}`)
  console.log(`  productCtx:  ${(m.productContext || '').slice(0, 80)}${(m.productContext || '').length > 80 ? '…' : ''}`)

  if (kws.length === 0 && !m.productContext) {
    console.log('  → SKIP — no keywords + no productContext\n')
    continue
  }

  const before = await redis.get(`monitor:${id}:expanded_keywords`)
  let beforeArr = []
  if (before) try { beforeArr = typeof before === 'string' ? JSON.parse(before) : before } catch {}
  console.log(`  Before:      ${beforeArr.length ? beforeArr.slice(0, 4).map(k => `"${k}"`).join(', ') + (beforeArr.length > 4 ? `, +${beforeArr.length - 4}` : '') : '(no cache)'}`)

  const expanded = await expandKeywords(kws, m.productContext || '')
  if (!expanded.length) {
    console.log(`  After:       (expander returned [] — leaving cache as-is)\n`)
    continue
  }
  console.log(`  After:       ${expanded.slice(0, 4).map(k => `"${k}"`).join(', ')}${expanded.length > 4 ? `, +${expanded.length - 4}` : ''}`)

  if (dryRun) {
    console.log('  [dry-run] not writing to Redis\n')
    continue
  }
  // Match the api-server fire-and-forget call signature: 7-day TTL.
  await redis.setex(`monitor:${id}:expanded_keywords`, 86400 * 7, JSON.stringify(expanded))
  console.log(`  ✓ Cache updated.\n`)
}

console.log('Done.')
