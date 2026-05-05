// lib/competitor-tracker.js — Competitor keyword expansion + match tagging.

/**
 * Build Reddit/HN search phrases for a list of competitor names.
 * Returns a flat array of search strings.
 */
export function buildCompetitorKeywords(competitors = []) {
  const phrases = []
  for (const name of competitors) {
    const n = (name || '').toString().trim()
    if (!n) continue
    phrases.push(`${n} alternative`)
    phrases.push(`${n} sucks`)
    phrases.push(`switching from ${n}`)
    phrases.push(`replace ${n}`)
    phrases.push(`${n} vs`)
  }
  return phrases
}

export const _internals = { buildCompetitorKeywords }
