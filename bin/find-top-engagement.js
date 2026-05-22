#!/usr/bin/env node
// bin/find-top-engagement.js — rank monitors by reply-tracker outcomes.
//
// PR #29 stores outcome records at `insights:outcomes:<monitorId>` (Redis
// list, newest first). PR #76 adds click counts at
// `insights:clicks:<matchId>`. We aggregate these per monitor and surface
// the leaderboard so the operator knows who has the strongest engagement
// proof — the right candidate to ask for a testimonial.

import { Redis } from '@upstash/redis'
import { loadEnv } from '../lib/env.js'

loadEnv()

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

const ids = await redis.smembers('insights:active_monitors') || []
const rows = []

for (const id of ids) {
  const raw = await redis.get(`insights:monitor:${id}`)
  if (!raw) continue
  const m = typeof raw === 'string' ? JSON.parse(raw) : raw

  // PR #29 stores engagement on the match record itself, not in a separate
  // list. Walk the recent matches list and aggregate the engagement field.
  // PR #76 stores clicks at `match:<matchId>:clicks` as a simple counter.
  const matchIds = (await redis.lrange(`insights:matches:${id}`, 0, 499)) || []
  let positive = 0, totalCommentDelta = 0, totalScoreDelta = 0, totalClicks = 0
  let outcomes = 0, posted = 0
  let bestMatch = null  // for the top-quote in the testimonial ask
  for (const matchId of matchIds) {
    try {
      const raw = await redis.get(`insights:match:${id}:${matchId}`)
      if (!raw) continue
      const match = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (match.postedAt) posted++
      const e = match.engagement
      if (e && e.checkedAt) {
        outcomes++
        const cd = Number(e.commentsDelta || 0)
        const sd = Number(e.scoreDelta    || 0)
        if (cd > 0 || sd > 0) positive++
        totalCommentDelta += cd
        totalScoreDelta   += sd
        if (!bestMatch || cd > (bestMatch.commentsDelta || 0)) {
          bestMatch = { title: match.title, url: match.url, commentsDelta: cd, scoreDelta: sd }
        }
      }
      // click counter (set by PR #76 redirect handler)
      const ck = await redis.get(`match:${matchId}:clicks`)
      const n = Number(ck)
      if (Number.isFinite(n) && n > 0) totalClicks += n
    } catch (_) { /* skip bad records */ }
  }

  rows.push({
    name:           m.name || '(unnamed)',
    id,
    owner:          m.alertEmail || '?',
    outcomeCount:   outcomes,
    positive,
    posted,
    totalCommentDelta,
    totalScoreDelta,
    totalClicks,
    productContext: m.productContext || '',
    totalMatches:   m.totalMatchesFound || 0,
    bestMatch,
  })
}

rows.sort((a, b) => {
  // Sort by: positive outcomes desc, then totalCommentDelta desc, then totalClicks desc.
  if (b.positive !== a.positive) return b.positive - a.positive
  if (b.totalCommentDelta !== a.totalCommentDelta) return b.totalCommentDelta - a.totalCommentDelta
  return b.totalClicks - a.totalClicks
})

console.log('Engagement leaderboard (sorted by positive outcomes → comments driven → clicks):')
console.log('─'.repeat(80))
for (const r of rows) {
  console.log(`▸ ${r.name} [${r.owner}]`)
  console.log(`  total matches:    ${r.totalMatches}  ·  posted: ${r.posted}  ·  outcomes scanned: ${r.outcomeCount}`)
  console.log(`  positive: ${r.positive}  ·  comments-driven: ${r.totalCommentDelta}  ·  score-delta: ${r.totalScoreDelta}  ·  clicks: ${r.totalClicks}`)
  if (r.bestMatch && r.bestMatch.title) {
    console.log(`  best:  +${r.bestMatch.commentsDelta} comments / +${r.bestMatch.scoreDelta} score`)
    console.log(`         "${r.bestMatch.title.slice(0, 80)}${r.bestMatch.title.length > 80 ? '…' : ''}"`)
    console.log(`         ${r.bestMatch.url || '(no url)'}`)
  }
  console.log()
}
