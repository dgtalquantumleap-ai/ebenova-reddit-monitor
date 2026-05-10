#!/usr/bin/env node
// bin/apply-keywords.js — write a new keywords array onto a monitor record.
//
// This is the privileged operation that bin/keyword-audit.js (read-only)
// deliberately avoids. Use only when the operator has reviewed the
// suggested keywords and wants to apply them. Idempotent: same input
// produces same output.
//
// Usage:
//   node bin/apply-keywords.js <monitorId> --replace 'kw1' 'kw2' 'kw3'   # full replace
//   node bin/apply-keywords.js <monitorId> --append  'kw1' 'kw2'          # add to existing
//   node bin/apply-keywords.js <monitorId> ... --dry-run                  # preview only
//
// New keywords are normalized to {keyword, type:'keyword', subreddits:[],
// productContext: monitor.productContext} — same shape api-server.js
// produces from POST /v1/find/save. The monitor's subreddit-intel cache
// will be reused automatically by the worker on the next cycle.

import { Redis } from '@upstash/redis'
import { loadEnv } from '../lib/env.js'

loadEnv()

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const monitorId = args[0]
const isReplace = args.includes('--replace')
const isAppend  = args.includes('--append')
const flagIdx = args.indexOf(isReplace ? '--replace' : '--append')
if (!monitorId || (!isReplace && !isAppend) || flagIdx < 0) {
  console.error('Usage: node bin/apply-keywords.js <monitorId> --replace|--append <kw1> [kw2 ...] [--dry-run]')
  process.exit(2)
}
const newKws = args.slice(flagIdx + 1).filter(a => !a.startsWith('--')).map(s => s.trim()).filter(Boolean)
if (!newKws.length) {
  console.error('No keywords provided after --replace/--append')
  process.exit(2)
}

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

const raw = await redis.get(`insights:monitor:${monitorId}`)
if (!raw) { console.error(`Monitor ${monitorId} not found`); process.exit(1) }
const m = typeof raw === 'string' ? JSON.parse(raw) : raw

const existing = (m.keywords || []).map(k => typeof k === 'string'
  ? { keyword: k, type: 'keyword', subreddits: [], productContext: m.productContext || '' }
  : { keyword: k.keyword || '', type: k.type || 'keyword', subreddits: k.subreddits || [], productContext: k.productContext || m.productContext || '' })

const incoming = newKws.map(kw => ({
  keyword:        kw,
  type:           'keyword',
  subreddits:     [],
  productContext: m.productContext || '',
}))

let final
if (isReplace) {
  final = incoming
} else {
  // append: dedup against existing (case-insensitive)
  const lower = new Set(existing.map(e => (e.keyword || '').toLowerCase()))
  final = [...existing, ...incoming.filter(k => !lower.has(k.keyword.toLowerCase()))]
}

console.log(`Monitor: ${m.name || '(unnamed)'} [${monitorId}]`)
console.log(`Owner:   ${m.alertEmail || '?'}`)
console.log(`Mode:    ${isReplace ? 'REPLACE' : 'APPEND'}${dryRun ? ' (dry-run)' : ''}`)
console.log('')
console.log(`Current keywords (${existing.length}):`)
for (const k of existing) console.log(`  · "${k.keyword}"`)
console.log('')
console.log(`After (${final.length}):`)
for (const k of final) console.log(`  · "${k.keyword}"`)

if (dryRun) {
  console.log('\n[dry-run] not writing to Redis')
  process.exit(0)
}

const updated = { ...m, keywords: final, updatedAt: new Date().toISOString() }
await redis.set(`insights:monitor:${monitorId}`, JSON.stringify(updated))
console.log('\n✓ Monitor updated. Worker will pick up the new keyword set on the next cycle.')
