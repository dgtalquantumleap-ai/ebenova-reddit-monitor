// scripts/add-stackoverflow-to-monitors.js
// Adds 'stackoverflow' to the platforms array of monitors whose keywords
// map to known Stack Overflow tags. Skips monitors with no developer keywords
// (e.g. wedding photography, cleaning businesses) to avoid wasting quota.
//
// Usage:
//   railway run node scripts/add-stackoverflow-to-monitors.js
//   railway run node scripts/add-stackoverflow-to-monitors.js --dry-run
//   railway run node scripts/add-stackoverflow-to-monitors.js --all   (add to ALL monitors)

import { loadEnv } from '../lib/env.js'
loadEnv()

import { Redis } from '@upstash/redis'
import { buildSOParams } from '../lib/scrapers/stackoverflow.js'

function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set')
  return new Redis({ url, token })
}

const args = process.argv.slice(2)
const dryRun   = args.includes('--dry-run')
const forceAll = args.includes('--all')

// A monitor "qualifies" for Stack Overflow if at least one of its keywords
// would NOT be skipped by the scraper's buildSOParams strategy. That means
// it maps to a known SO tag OR has 1-4 meaningful non-stop-word tokens.
function monitorQualifiesForSO(monitor) {
  if (forceAll) return true
  const keywords = (monitor.keywords || []).map(k =>
    typeof k === 'string' ? k : (k.keyword || '')
  ).filter(Boolean)

  for (const kw of keywords) {
    const { strategy } = buildSOParams(kw)
    if (strategy !== 'skip') return true
  }
  return false
}

async function main() {
  const redis = getRedis()

  const monitorIds = (await redis.smembers('insights:active_monitors')) || []
  console.log(`\nFound ${monitorIds.length} active monitors\n`)

  let checked = 0, added = 0, skipped = 0, alreadyHas = 0

  for (const id of monitorIds) {
    checked++
    let raw
    try { raw = await redis.get(`insights:monitor:${id}`) } catch { continue }
    if (!raw) continue
    const monitor = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!monitor.active) { skipped++; continue }

    const currentPlatforms = Array.isArray(monitor.platforms)
      ? monitor.platforms
      : ['reddit', 'medium', 'substack', 'quora', 'upwork', 'fiverr'] // legacy default

    if (currentPlatforms.includes('stackoverflow')) {
      console.log(`  [already has SO] ${monitor.name || id}`)
      alreadyHas++
      continue
    }

    const qualifies = monitorQualifiesForSO(monitor)
    const kwSample = (monitor.keywords || []).slice(0, 3)
      .map(k => typeof k === 'string' ? k : k.keyword).join(', ')

    if (!qualifies) {
      console.log(`  [skip — no dev keywords] ${monitor.name || id} (e.g. ${kwSample})`)
      skipped++
      continue
    }

    const newPlatforms = [...currentPlatforms, 'stackoverflow']
    console.log(`  [+stackoverflow] ${monitor.name || id}`)
    console.log(`    platforms: [${currentPlatforms.join(', ')}] → [${newPlatforms.join(', ')}]`)
    console.log(`    qualifying keyword sample: ${kwSample}`)

    if (!dryRun) {
      const updated = { ...monitor, platforms: newPlatforms, updatedAt: new Date().toISOString() }
      await redis.set(`insights:monitor:${id}`, JSON.stringify(updated))
    }
    added++
  }

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Checked:       ${checked}`)
  console.log(`Added SO:      ${added}${dryRun ? ' (dry run — no writes)' : ''}`)
  console.log(`Already had:   ${alreadyHas}`)
  console.log(`Skipped:       ${skipped} (no dev keywords or inactive)`)
  if (dryRun) console.log(`\nRe-run without --dry-run to apply.`)
  console.log()
  process.exit(0)
}

main().catch(err => {
  console.error('❌ Fatal:', err.message)
  process.exit(1)
})
