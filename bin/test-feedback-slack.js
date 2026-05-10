#!/usr/bin/env node
// bin/test-feedback-slack.js — submit a Claude Code-tagged test feedback
// against the LIVE production API and verify the slackDelivery field
// landed on the Redis record. Single-shot end-to-end smoke test for the
// /v1/feedback → Slack pipeline.
//
// Usage:
//   node bin/test-feedback-slack.js [--email <email>]   # default: dgtalquantumleap@gmail.com
//   node bin/test-feedback-slack.js --apikey <key>      # bypass email lookup
//
// Env required: UPSTASH_REDIS_REST_URL/TOKEN. APP_URL (default
// https://ebenova.org) used for the POST.

import { Redis } from '@upstash/redis'
import { loadEnv } from '../lib/env.js'

loadEnv()

const args = process.argv.slice(2)
const emailIdx = args.indexOf('--email')
const targetEmail = emailIdx >= 0 ? args[emailIdx + 1] : 'dgtalquantumleap@gmail.com'
const apikeyIdx = args.indexOf('--apikey')
let apiKey = apikeyIdx >= 0 ? args[apikeyIdx + 1] : null
const apiBase = process.env.APP_URL || 'https://ebenova.org'

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

// Look up apiKey by email if not provided
if (!apiKey) {
  let cursor = '0'
  do {
    const r = await redis.scan(cursor, { match: 'apikey:*', count: 200 })
    cursor = String(r[0])
    for (const k of (r[1] || [])) {
      if (k.includes(':payment_failures')) continue
      const raw = await redis.get(k)
      if (!raw) continue
      let data
      try { data = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { continue }
      if (data?.email === targetEmail || data?.owner === targetEmail) {
        apiKey = k.replace(/^apikey:/, '')
        break
      }
    }
    if (apiKey) break
  } while (cursor !== '0')
}

if (!apiKey) {
  console.error(`No API key found for ${targetEmail}. Pass --apikey explicitly.`)
  process.exit(1)
}
console.log(`Using API key for ${targetEmail} (${apiKey.slice(0, 6)}…)`)
console.log(`POSTing to ${apiBase}/v1/feedback …`)

// Tag the message clearly so it's obvious this is automated
const message = `[Claude Code automated smoke test — ${new Date().toISOString()}] Verifying /v1/feedback → Slack delivery wiring after PR #66. Please ignore in human-review queue.`
const submission = { npsScore: 8, category: 'other', message }

const res = await fetch(`${apiBase}/v1/feedback`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
  body: JSON.stringify(submission),
})
const body = await res.text()
console.log(`HTTP ${res.status} · response: ${body.slice(0, 200)}`)
if (res.status !== 200) process.exit(1)

// The handler writes feedback:<apiKey>:<ts> with the slackDelivery annotation.
// Wait briefly then poll for the most-recent record.
console.log('\nPolling Redis for the resulting record…')
await new Promise(r => setTimeout(r, 1500))

let found = null
let cursor = '0'
do {
  const r = await redis.scan(cursor, { match: `feedback:${apiKey}:*`, count: 100 })
  cursor = String(r[0])
  for (const k of (r[1] || [])) {
    const raw = await redis.get(k)
    if (!raw) continue
    let f
    try { f = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { continue }
    if (f?.message === message) { found = { key: k, value: f }; break }
  }
  if (found) break
} while (cursor !== '0')

if (!found) {
  console.error('FAIL — no matching feedback record found in Redis. The /v1/feedback endpoint accepted the request but the archive write may have failed.')
  process.exit(1)
}

console.log(`\nFound: ${found.key}`)
console.log(`  email:           ${found.value.email}`)
console.log(`  npsScore:        ${found.value.npsScore}`)
console.log(`  category:        ${found.value.category}`)
console.log(`  submittedAt:     ${found.value.submittedAt}`)

if (!found.value.slackDelivery) {
  console.error('\nFAIL — slackDelivery field MISSING from the record. PR #66 may not be deployed yet, or the second Redis write failed.')
  process.exit(1)
}

const sd = found.value.slackDelivery
console.log('')
console.log('slackDelivery (PR #66 self-verification field):')
console.log(`  delivered:       ${sd.delivered}`)
console.log(`  reason:          ${sd.reason ?? '(null)'}`)
console.log(`  status:          ${sd.status ?? '(null)'}`)
console.log(`  error:           ${sd.error ?? '(null)'}`)
console.log(`  attemptedAt:     ${sd.attemptedAt}`)

if (sd.delivered === true) {
  console.log('\n✅ PASS — Slack delivery succeeded. Check the connected channel for the message.')
} else {
  console.log('\n❌ FAIL — Slack delivery did NOT succeed. Reason above tells you why.')
  console.log('   no_webhook     → SLACK_FEEDBACK_WEBHOOK_URL is unset on Railway')
  console.log('   slack_error    → Slack returned a non-2xx (channel deleted, webhook revoked)')
  console.log('   network_error  → fetch failed (DNS, timeout)')
  console.log('   exception      → slackFn threw a JS error (see error field)')
  process.exit(1)
}
