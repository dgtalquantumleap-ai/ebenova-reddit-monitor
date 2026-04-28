#!/usr/bin/env node
// One-shot backfill: scan all `apikey:*` entries, find ones with
// `stripeCustomerId` set, and write the `stripe:customer:<id> → apiKey`
// reverse index for each.
//
// Required after F4 lands so cancellation/dunning works for customers who
// upgraded BEFORE the fix (before the reverse index was being written).
//
// Usage:
//   node scripts/backfill-stripe-index.js --dry-run
//   node scripts/backfill-stripe-index.js
//
// Loads .env from cwd. Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.

import { readFileSync } from 'fs'
import { resolve } from 'path'

// Naive .env loader (matches the rest of the codebase's pattern)
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

const DRY_RUN = process.argv.includes('--dry-run')

async function main() {
  const url   = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    console.error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN required')
    process.exit(2)
  }
  const redis = new Redis({ url, token })

  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Scanning apikey:* for stripeCustomerId…\n`)

  let cursor = 0
  let scanned = 0
  let backfilled = 0
  let skipped = 0
  do {
    const [next, keys] = await redis.scan(cursor, { match: 'apikey:*', count: 100 })
    cursor = Number(next)
    for (const apiKeyEntry of keys) {
      scanned++
      const raw = await redis.get(apiKeyEntry)
      if (!raw) continue
      let data
      try { data = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { continue }
      if (!data.stripeCustomerId) continue
      const apiKey = apiKeyEntry.replace(/^apikey:/, '')
      const reverseKey = `stripe:customer:${data.stripeCustomerId}`
      const existing = await redis.get(reverseKey)
      if (existing === apiKey) { skipped++; continue }
      console.log(`${DRY_RUN ? '[DRY] ' : ''}${reverseKey} → ${apiKey.slice(0, 12)}…`)
      if (!DRY_RUN) await redis.set(reverseKey, apiKey)
      backfilled++
    }
  } while (cursor !== 0)

  console.log(`\nScanned ${scanned} api keys.`)
  console.log(`Skipped ${skipped} (already indexed).`)
  console.log(`${DRY_RUN ? 'Would have backfilled' : 'Backfilled'} ${backfilled} reverse indexes.`)
}

main().catch(err => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
