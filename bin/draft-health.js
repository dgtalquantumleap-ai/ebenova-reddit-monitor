#!/usr/bin/env node
// bin/draft-health.js — read-only audit of AI draft generation.
// Answers: "are drafts working?" "which model wrote them?" "any failure
// patterns?" — without re-generating anything.
//
// Sample drafts, group by model + monitor + intent, surface anomalies
// (empty drafts, very short drafts, drafts containing AI-isms, drafts
// without an associated draftedBy field).
//
// Usage:
//   node bin/draft-health.js                   # default: all active monitors
//   node bin/draft-health.js --monitor <id>    # one specific monitor
//   node bin/draft-health.js --samples 3       # how many drafts to print per monitor (default 2)
//
// Read-only against monitor records + match records. No writes.

import { Redis } from '@upstash/redis'
import { loadEnv } from '../lib/env.js'

loadEnv()

const args = process.argv.slice(2)
const flagIdx = args.indexOf('--monitor')
const monitorFilter = flagIdx >= 0 ? args[flagIdx + 1] : null
const samplesIdx = args.indexOf('--samples')
const samplesPer = samplesIdx >= 0 ? parseInt(args[samplesIdx + 1] || '2') : 2

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

const ids = monitorFilter ? [monitorFilter] : ((await redis.smembers('insights:active_monitors')) || [])
console.log(`Auditing ${ids.length} monitor(s)\n`)

let total = 0
let withDraft = 0
let emptyDraft = 0
let veryShortDraft = 0   // < 80 chars, suspicious
let aiIsms = 0           // has em-dash, "delve", "tapestry", "moreover", "navigating the…"
let withDraftedBy = 0
const byModel = {}
const byIntent = { with: {}, without: {} }
const samples = []
const monitorSummaries = []

const AI_ISM_PATTERNS = [
  /[—–]/,                                                                  // em / en dash
  /\b(delve|delving|tapestry|moreover|furthermore|in conclusion|navigating|leverage(?:s|d|ing)? (?:our|the))\b/i,
  /\bI hope this (?:helps|finds|message)/i,
  /\bAs an AI\b/i,
]

for (const id of ids) {
  const monitorRaw = await redis.get(`insights:monitor:${id}`)
  let m
  try { m = typeof monitorRaw === 'string' ? JSON.parse(monitorRaw) : monitorRaw } catch (_) { m = null }
  const name = m?.name || '(unnamed)'
  const owner = (m?.alertEmail || '').split('@')[0] || '?'

  const matchIds = (await redis.lrange(`insights:matches:${id}`, 0, 999)) || []
  let mTotal = 0, mWithDraft = 0, mWithoutDraft = 0
  let printedSamples = 0

  // Most-recent first (lpush — head is newest)
  for (const matchId of matchIds.slice(0, 250)) {
    const raw = await redis.get(`insights:match:${id}:${matchId}`)
    if (!raw) continue
    let mm
    try { mm = typeof raw === 'string' ? JSON.parse(raw) : raw } catch (_) { continue }
    total++; mTotal++
    const intent = mm.intent || 'unclassified'
    if (mm.draft) {
      withDraft++; mWithDraft++
      const len = String(mm.draft).length
      if (len < 5)  emptyDraft++
      else if (len < 80) veryShortDraft++
      if (mm.draftedBy) {
        withDraftedBy++
        byModel[mm.draftedBy] = (byModel[mm.draftedBy] || 0) + 1
      } else {
        byModel['(no draftedBy field)'] = (byModel['(no draftedBy field)'] || 0) + 1
      }
      if (AI_ISM_PATTERNS.some(p => p.test(mm.draft))) aiIsms++
      byIntent.with[intent] = (byIntent.with[intent] || 0) + 1

      if (printedSamples < samplesPer) {
        samples.push({
          monitor: name, owner,
          intent, intentScore: mm.intentScore,
          model: mm.draftedBy || '?',
          title: (mm.title || '').slice(0, 80),
          draft: String(mm.draft).slice(0, 220),
          draftLen: String(mm.draft).length,
        })
        printedSamples++
      }
    } else {
      mWithoutDraft++
      byIntent.without[intent] = (byIntent.without[intent] || 0) + 1
    }
  }
  monitorSummaries.push({ id, name, owner, total: mTotal, withDraft: mWithDraft, withoutDraft: mWithoutDraft })
}

// Per-monitor summary
console.log('Per-monitor draft coverage')
console.log('  ' + 'owner'.padEnd(15) + 'name'.padEnd(40) + 'matches  drafts  draft-rate')
for (const s of monitorSummaries.sort((a, b) => b.total - a.total)) {
  if (s.total === 0) continue
  const rate = ((s.withDraft / s.total) * 100).toFixed(0) + '%'
  console.log('  ' +
    s.owner.slice(0, 14).padEnd(15) +
    s.name.slice(0, 39).padEnd(40) +
    String(s.total).padStart(7) +
    String(s.withDraft).padStart(8) +
    rate.padStart(12)
  )
}

console.log('')
console.log('Aggregate')
console.log(`  Total matches sampled            ${total}`)
console.log(`  With draft                       ${withDraft}  (${((withDraft/total)*100||0).toFixed(0)}%)`)
console.log(`  Empty draft (<5 chars)           ${emptyDraft}`)
console.log(`  Very short draft (<80 chars)     ${veryShortDraft}`)
console.log(`  Drafts containing AI-isms        ${aiIsms}  (em-dash, 'delve', 'tapestry', etc.)`)
console.log(`  Drafts with draftedBy field      ${withDraftedBy} of ${withDraft}`)

console.log('')
console.log('Drafted by model')
for (const [model, n] of Object.entries(byModel).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${model.padEnd(30)} ${n}`)
}

console.log('')
console.log('Intent mix — drafted vs not drafted')
const allIntents = new Set([...Object.keys(byIntent.with), ...Object.keys(byIntent.without)])
console.log('  intent              drafted  not-drafted')
for (const it of allIntents) {
  const d = byIntent.with[it] || 0
  const u = byIntent.without[it] || 0
  console.log(`  ${it.padEnd(20)} ${String(d).padStart(7)}  ${String(u).padStart(11)}`)
}

console.log('')
console.log(`Sample drafts (${samples.length})`)
console.log('═'.repeat(80))
for (const s of samples.slice(0, Math.min(samples.length, ids.length * samplesPer))) {
  console.log(`▸ ${s.monitor} · ${s.owner} · intent=${s.intent} (score=${s.intentScore ?? '?'}) · ${s.model} · ${s.draftLen} chars`)
  console.log(`  POST:  ${s.title}${s.title.length === 80 ? '…' : ''}`)
  console.log(`  DRAFT: ${s.draft}${s.draftLen > 220 ? '…' : ''}`)
  console.log('')
}
