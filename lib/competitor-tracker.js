// lib/competitor-tracker.js — Build keyword search phrases for competitor monitoring.
// Called in monitor-v2 to generate keyword entries from monitor.competitors[].

const PHRASE_TEMPLATES = [
  name => `${name} alternative`,
  name => `${name} sucks`,
  name => `switching from ${name}`,
  name => `replace ${name}`,
  name => `${name} vs`,
]

/**
 * Build keyword objects from a list of competitor names.
 * Each name generates 5 search phrases tagged as type:'competitor'.
 * Returns [] if competitors is empty or not an array.
 */
export function buildCompetitorKeywords(competitors = [], productContext = '') {
  if (!Array.isArray(competitors) || competitors.length === 0) return []
  const keywords = []
  for (const name of competitors) {
    const n = (typeof name === 'string' ? name : '').trim()
    if (!n) continue
    for (const fn of PHRASE_TEMPLATES) {
      keywords.push({
        keyword:        fn(n),
        type:           'competitor',
        subreddits:     [],
        productContext,
        competitorName: n,
      })
    }
  }
  return keywords
}

export const _internals = { PHRASE_TEMPLATES }
