// Relevance evaluation harness — multi-axis, deterministic, offline.
//
// Reads the frozen truth set (test/fixtures/relevance-truthset.json) and applies
// the CURRENT production relevance gates to each row, then reports leakage PER
// FAILURE CLASS — not a single precision score. The point is to see, after any
// fix, that the already-fixed class stays at ~0 while the next dominant class
// becomes visible. No Redis, no network — run with: node scripts/relevance-eval.mjs
import { readFileSync } from 'node:fs'
import { passesRelevanceCheck } from '../lib/relevance.js'

const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/relevance-truthset.json', import.meta.url)))
const rows = fixture.rows

// Replicate the live pipeline gates (post-#84):
//   competitor rows → gate on the BRAND NAME (retrieval containment, PR #84)
//   keyword rows    → gate on the matched keyword (existing keyword/feed gate)
function admitted(r) {
  if (r.keywordType === 'competitor') {
    return !!r.competitorName && passesRelevanceCheck(r, r.competitorName, 'competitor')
  }
  return passesRelevanceCheck(r, r.query, r.keywordType || 'keyword')
}

const CLASSES = ['retrieval', 'polysemy', 'intent_inversion', 'borderline', 'relevant', 'unknown']
const tally = {}
for (const c of CLASSES) tally[c] = { total: 0, leaked: 0 }
for (const r of rows) {
  const c = tally[r.failure_type] || (tally[r.failure_type] = { total: 0, leaked: 0 })
  c.total++
  if (admitted(r)) c.leaked++
}

const pct = (n, d) => (d ? (100 * n / d).toFixed(0) : '0') + '%'
console.log(`\nRELEVANCE EVAL — ${rows.length} rows vs current gates (post-#84)\n`)
console.log(`  FAILURE CLASS      ADMITTED/TOTAL   LEAK RATE   meaning`)
console.log(`  ─────────────────────────────────────────────────────────────────────`)
const lines = {
  retrieval:        'contamination — target ~0% (fixed by #84)',
  polysemy:         'term-sense collision — NOT yet addressed',
  intent_inversion: 'seeker-vs-supplier — NOT yet addressed',
  borderline:       'persona-ambiguous',
  relevant:         'TRUE POSITIVES — must stay 100% admitted',
}
for (const c of ['retrieval', 'polysemy', 'intent_inversion', 'borderline', 'relevant', 'unknown']) {
  const t = tally[c]; if (!t || !t.total) continue
  console.log(`  ${c.padEnd(17)}  ${String(t.leaked).padStart(2)}/${String(t.total).padEnd(2).padStart(2)} admitted   ${pct(t.leaked, t.total).padStart(5)}      ${lines[c] || ''}`)
}

// Headline metrics the user asked for
const noiseClasses = ['retrieval', 'polysemy', 'intent_inversion']
const noiseTotal = noiseClasses.reduce((a, c) => a + tally[c].total, 0)
const noiseLeaked = noiseClasses.reduce((a, c) => a + tally[c].leaked, 0)
const rel = tally.relevant
console.log(`\n  A. retrieval contamination rate : ${pct(tally.retrieval.leaked, tally.retrieval.total)}  (${tally.retrieval.leaked}/${tally.retrieval.total})`)
console.log(`  B. polysemy leak rate           : ${pct(tally.polysemy.leaked, tally.polysemy.total)}  (${tally.polysemy.leaked}/${tally.polysemy.total})`)
console.log(`  C. intent-inversion leak rate   : ${pct(tally.intent_inversion.leaked, tally.intent_inversion.total)}  (${tally.intent_inversion.leaked}/${tally.intent_inversion.total})`)
console.log(`  D. true-positives retained      : ${pct(rel.leaked, rel.total)}  (${rel.leaked}/${rel.total})`)
console.log(`\n  noise still admitted overall    : ${noiseLeaked}/${noiseTotal} (${pct(noiseLeaked, noiseTotal)})  ← the number a fix must drive down`)
console.log(`  dominant remaining leak class   : ${['polysemy','intent_inversion'].sort((a,b)=>tally[b].leaked-tally[a].leaked)[0]}\n`)
