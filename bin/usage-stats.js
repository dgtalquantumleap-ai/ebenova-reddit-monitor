#!/usr/bin/env node
// bin/usage-stats.js — read-only usage report for Ebenova Insights.
//
// Reads the production Redis (via Upstash REST) and prints:
//   - Total signups (insights:signup:* keys)
//   - Active monitors (insights:active_monitors set)
//   - Unique monitor owners (insights:monitors:* set keys)
//   - Breakdown by plan (apikey:* records)
//   - Recent signup activity (last 7 / 30 days)
//   - Geographic distribution (signup country header captures + optional
//     batch IP→country resolution via free public service)
//
// Usage:
//   node bin/usage-stats.js              # counts only
//   node bin/usage-stats.js --geo        # also resolve unknown IPs to countries
//   node bin/usage-stats.js --json       # machine-readable JSON output
//
// Env required: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN.
//
// Privacy note: --geo sends each user's stored signup IP to ip-api.com's
// free endpoint (no key, ~45 req/min limit) for country resolution. The
// IP never leaves your operator machine on a default run.

import { Redis } from '@upstash/redis'
import { loadEnv } from '../lib/env.js'

loadEnv()

const args = new Set(process.argv.slice(2))
const FLAGS = {
  geo:  args.has('--geo'),
  json: args.has('--json'),
}

function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    console.error('FATAL: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN must be set.')
    process.exit(1)
  }
  return new Redis({ url, token })
}

// SCAN with MATCH — paginates until cursor returns to '0'. Upstash REST
// SCAN returns [cursor, keys] same as Redis. Caps at 5000 keys to keep
// runtime sane.
async function scanAll(redis, pattern, cap = 5000) {
  const out = []
  let cursor = '0'
  let iterations = 0
  do {
    const r = await redis.scan(cursor, { match: pattern, count: 200 })
    cursor = String(r[0])
    const keys = r[1] || []
    for (const k of keys) {
      out.push(k)
      if (out.length >= cap) return out
    }
    iterations++
    if (iterations > 50) break  // safety
  } while (cursor !== '0')
  return out
}

async function gatherStats() {
  const redis = getRedis()

  // 1. Signup count
  const signupKeys = await scanAll(redis, 'insights:signup:*')
  // 2. Apikey count + plan breakdown + signup metadata
  const apikeyKeys = await scanAll(redis, 'apikey:*')
  // Filter out the payment_failures sub-keys (apikey:KEY:payment_failures).
  const userKeys = apikeyKeys.filter(k => !k.includes(':payment_failures'))

  const byPlan = { starter: 0, growth: 0, scale: 0, other: 0 }
  const byCountry = {}                  // signupCountry → count
  const ipsToResolve = []               // [{ key, ip }] for --geo path
  const signupTimestamps = []           // ISO strings
  const userSummaries = []              // for --json output

  for (const k of userKeys) {
    let raw
    try { raw = await redis.get(k) } catch (_) { continue }
    if (!raw) continue
    let data
    try { data = typeof raw === 'string' ? JSON.parse(raw) : raw } catch (_) { continue }
    if (!data || !data.insights) continue

    const plan = (data.insightsPlan || 'starter').toLowerCase()
    if (Object.prototype.hasOwnProperty.call(byPlan, plan)) byPlan[plan]++
    else byPlan.other++

    if (data.createdAt) signupTimestamps.push(data.createdAt)

    if (data.signupCountry) {
      byCountry[data.signupCountry] = (byCountry[data.signupCountry] || 0) + 1
    } else if (data.signupIp && FLAGS.geo) {
      ipsToResolve.push({ key: k, ip: data.signupIp })
    }

    userSummaries.push({
      owner:       data.owner,
      plan:        plan,
      createdAt:   data.createdAt || null,
      country:     data.signupCountry || null,
      ip:          data.signupIp || null,
      source:      data.source || 'self-signup',
    })
  }

  // 3. Monitor counts
  let activeMonitors = 0
  try { activeMonitors = await redis.scard('insights:active_monitors') } catch (_) {}
  const ownerSetKeys = await scanAll(redis, 'insights:monitors:*')
  const uniqueOwners = ownerSetKeys.length

  // 4. Activity buckets
  const now = Date.now()
  const ms7d  = 7  * 24 * 60 * 60 * 1000
  const ms30d = 30 * 24 * 60 * 60 * 1000
  let signups7d = 0, signups30d = 0
  for (const ts of signupTimestamps) {
    const t = new Date(ts).getTime()
    if (!Number.isFinite(t)) continue
    if (now - t <= ms7d)  signups7d++
    if (now - t <= ms30d) signups30d++
  }

  // 5. Optional geo resolution for users with IP but no country header
  const geoResolved = { resolved: 0, failed: 0 }
  if (FLAGS.geo && ipsToResolve.length > 0) {
    console.error(`[geo] Resolving ${ipsToResolve.length} IP(s) via ip-api.com (rate-limited; throttled to ~1/sec)…`)
    for (const entry of ipsToResolve) {
      try {
        const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(entry.ip)}?fields=status,countryCode`, {
          signal: AbortSignal.timeout(8000),
        })
        if (res.ok) {
          const d = await res.json()
          if (d.status === 'success' && d.countryCode) {
            const cc = String(d.countryCode).toUpperCase().slice(0, 2)
            byCountry[cc] = (byCountry[cc] || 0) + 1
            // Reflect on the in-memory summary so JSON output is consistent.
            const u = userSummaries.find(s => s.ip === entry.ip && !s.country)
            if (u) u.country = cc
            geoResolved.resolved++
          } else {
            geoResolved.failed++
          }
        } else {
          geoResolved.failed++
        }
      } catch (_) {
        geoResolved.failed++
      }
      // Throttle: ip-api.com free is ~45/min — sleep 1.4s between calls.
      await new Promise(r => setTimeout(r, 1400))
    }
  }

  return {
    counts: {
      totalUsers:    userKeys.length,
      totalSignups:  signupKeys.length,
      activeMonitors,
      uniqueOwners,
      signups7d,
      signups30d,
    },
    byPlan,
    byCountry,
    geoResolved,
    users: userSummaries,
    ipsAwaitingGeo: ipsToResolve.length,
  }
}

function pad(s, n) { return String(s).padEnd(n) }
function num(n) { return String(n).padStart(6) }

function renderTable(stats) {
  const lines = []
  lines.push('━'.repeat(60))
  lines.push('  Ebenova Insights — Usage Stats')
  lines.push('  ' + new Date().toISOString())
  lines.push('━'.repeat(60))
  lines.push('')
  lines.push('Counts')
  lines.push('  ' + pad('Total users',         28) + num(stats.counts.totalUsers))
  lines.push('  ' + pad('Total signups',       28) + num(stats.counts.totalSignups))
  lines.push('  ' + pad('Active monitors',     28) + num(stats.counts.activeMonitors))
  lines.push('  ' + pad('Unique monitor owners',28) + num(stats.counts.uniqueOwners))
  lines.push('  ' + pad('Signups (last 7d)',   28) + num(stats.counts.signups7d))
  lines.push('  ' + pad('Signups (last 30d)',  28) + num(stats.counts.signups30d))
  lines.push('')
  lines.push('By plan')
  for (const [plan, count] of Object.entries(stats.byPlan)) {
    if (count === 0) continue
    lines.push('  ' + pad(plan, 28) + num(count))
  }
  lines.push('')
  lines.push('By country (signup)')
  const countries = Object.entries(stats.byCountry).sort((a, b) => b[1] - a[1])
  if (countries.length === 0) {
    lines.push('  (no country headers captured — run with --geo to resolve IPs)')
    if (stats.ipsAwaitingGeo > 0) {
      lines.push(`  ${stats.ipsAwaitingGeo} user(s) have IP recorded; not yet geo-resolved.`)
    }
  } else {
    for (const [cc, count] of countries) {
      lines.push('  ' + pad(cc, 28) + num(count))
    }
  }
  if (FLAGS.geo) {
    lines.push('')
    lines.push(`  geo-resolved: ${stats.geoResolved.resolved}, failed: ${stats.geoResolved.failed}`)
  }
  lines.push('')
  lines.push('━'.repeat(60))
  return lines.join('\n')
}

(async () => {
  try {
    const stats = await gatherStats()
    if (FLAGS.json) {
      console.log(JSON.stringify(stats, null, 2))
    } else {
      console.log(renderTable(stats))
    }
  } catch (err) {
    console.error('FATAL:', err.message)
    process.exit(1)
  }
})()
