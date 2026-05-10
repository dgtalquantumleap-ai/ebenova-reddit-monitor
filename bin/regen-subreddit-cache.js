#!/usr/bin/env node
// bin/regen-subreddit-cache.js — re-run the AI subreddit suggester for one
// monitor or for every monitor that has zero matches.
//
// Why this exists: api-server.js fires `suggestSubreddits` once,
// fire-and-forget, when a monitor is created. If that call failed (cost
// cap, network blip, AI provider outage), the monitor never gets a
// `monitor:<id>:suggested_subreddits` cache and falls back to global
// Reddit search across all subreddits — which has poor recall for niche
// commercial keywords. This script re-runs the suggester on demand so
// the operator can heal a monitor without recreating it.
//
// Usage:
//   node bin/regen-subreddit-cache.js <monitorId>       # one specific monitor
//   node bin/regen-subreddit-cache.js --zero-match      # every active monitor with zero matches
//   node bin/regen-subreddit-cache.js --missing         # every active monitor that has no cache yet
//   node bin/regen-subreddit-cache.js --dry-run         # don't write, just print what would happen
//
// Env required: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, plus
// whichever AI provider key suggestSubreddits routes to (DEEPSEEK by default).

import { Redis } from '@upstash/redis'
import { loadEnv } from '../lib/env.js'
import { suggestSubreddits } from '../lib/subreddit-suggester.js'

loadEnv()

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const mode = args.find(a => !a.startsWith('--')) ||
  (args.includes('--zero-match') ? '__zero_match__' :
   args.includes('--missing')    ? '__missing__'    : null)

if (!mode) {
  console.error('Usage: node bin/regen-subreddit-cache.js <monitorId> | --zero-match | --missing  [--dry-run]')
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
  if (mode !== '__zero_match__' && mode !== '__missing__') {
    return [mode]   // explicit ID
  }
  const ids = (await redis.smembers('insights:active_monitors')) || []
  const out = []
  for (const id of ids) {
    const matchCount = (await redis.lrange(`insights:matches:${id}`, 0, 999)).length
    const hasCache = await redis.get(`monitor:${id}:suggested_subreddits`)
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

console.log(`Targets: ${targets.length}`)
for (const id of targets) {
  const m = await getMonitor(id)
  if (!m) { console.warn(`  ${id}: monitor record not found, skipping`); continue }
  const kws = (m.keywords || []).map(k => typeof k === 'string' ? k : (k?.keyword || '')).filter(Boolean)
  console.log(`\n▸ ${m.name || '(unnamed)'}  [${id}]`)
  console.log(`  Owner:       ${m.alertEmail || m.ownerEmail || '?'}`)
  console.log(`  Keywords:    ${kws.length} (${kws.slice(0, 3).map(k => `"${k}"`).join(', ')}${kws.length > 3 ? ', …' : ''})`)
  console.log(`  productCtx:  ${(m.productContext || '').slice(0, 80)}${(m.productContext || '').length > 80 ? '…' : ''}`)

  if (kws.length === 0 && !m.productContext) {
    console.log('  → SKIP — no keywords + no productContext, suggester would return []')
    continue
  }

  const before = await redis.get(`monitor:${id}:suggested_subreddits`)
  let beforeArr = []
  if (before) try { beforeArr = typeof before === 'string' ? JSON.parse(before) : before } catch {}
  console.log(`  Before:      ${beforeArr.length ? beforeArr.slice(0, 5).map(s => 'r/' + s).join(', ') + (beforeArr.length > 5 ? ` (+${beforeArr.length - 5})` : '') : '(no cache)'}`)

  const suggested = await suggestSubreddits(m.productContext || '', kws)
  if (!suggested.length) {
    console.log(`  After:       (suggester returned [] — leaving cache as-is)`)
    continue
  }
  console.log(`  After:       ${suggested.slice(0, 5).map(s => 'r/' + s).join(', ')}${suggested.length > 5 ? ` (+${suggested.length - 5})` : ''}`)

  if (dryRun) {
    console.log('  [dry-run] not writing to Redis')
    continue
  }
  // Match the api-server fire-and-forget call signature: 7-day TTL.
  await redis.setex(`monitor:${id}:suggested_subreddits`, 86400 * 7, JSON.stringify(suggested))
  console.log(`  ✓ Cache updated.`)
}

console.log('\nDone.')
