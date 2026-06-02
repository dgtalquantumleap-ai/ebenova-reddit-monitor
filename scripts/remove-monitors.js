// scripts/remove-monitors.js
// Removes specific monitors and all their Redis data.
// Usage: railway run node scripts/remove-monitors.js [--dry-run]

import { loadEnv } from '../lib/env.js'
loadEnv()

import { Redis } from '@upstash/redis'

const REMOVE_NAMES = [
  'Hair, Beauty & Grooming',
  'Nigerian Savings Monitor',
  'SmallBiz Social Eavesdrop',
]

const dryRun = process.argv.includes('--dry-run')

function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('Redis env vars not set')
  return new Redis({ url, token })
}

async function main() {
  const redis = getRedis()
  const monitorIds = (await redis.smembers('insights:active_monitors')) || []
  console.log(`\nScanning ${monitorIds.length} active monitors...\n`)

  for (const id of monitorIds) {
    let raw
    try { raw = await redis.get(`insights:monitor:${id}`) } catch { continue }
    if (!raw) continue
    const monitor = typeof raw === 'string' ? JSON.parse(raw) : raw
    const name = monitor.name || ''

    if (!REMOVE_NAMES.some(n => name.includes(n.split(',')[0]))) continue

    console.log(`\nRemoving: "${name}" (${id})`)
    console.log(`  owner: ${monitor.owner}`)

    // Collect all keys to delete
    const keysToDelete = [
      `insights:monitor:${id}`,
    ]

    // Match list + individual match keys
    const matchIds = await redis.lrange(`insights:matches:${id}`, 0, -1) || []
    console.log(`  matches: ${matchIds.length}`)
    keysToDelete.push(`insights:matches:${id}`)
    for (const mid of matchIds) {
      keysToDelete.push(`insights:match:${id}:${mid}`)
    }

    // Other per-monitor keys
    keysToDelete.push(
      `monitor:${id}:expanded_keywords`,
      `monitor:${id}:suggested_subreddits`,
      `monitor:${id}:zero_match_cycles`,
      `insights:matches:${id}`,
      `author:list:${id}`,
    )

    // Seen keys (3-day TTL, will expire anyway but clean up what we can via scan)
    // Skip full scan of seen:v2:{id}:* — too many keys, let TTL handle them

    console.log(`  keys to delete: ${keysToDelete.length}`)
    if (!dryRun) {
      for (const key of keysToDelete) {
        await redis.del(key).catch(() => {})
      }
      // Remove from active set
      await redis.srem('insights:active_monitors', id)
      // Remove from owner's monitor set
      if (monitor.owner) {
        await redis.srem(`insights:monitors:${monitor.owner}`, id)
      }
      console.log(`  ✅ Deleted`)
    } else {
      console.log(`  [dry run — no writes]`)
    }
  }

  console.log('\nDone.\n')
  process.exit(0)
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
