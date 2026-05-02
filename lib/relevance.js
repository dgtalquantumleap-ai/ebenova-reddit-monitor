// lib/relevance.js — post-fetch relevance gate
//
// Every scraper sends a keyword to a platform and gets back results. Platforms
// don't always return tight matches: Medium splits keywords into tags, HN and
// Quora rank loosely, Reddit occasionally matches individual words separately.
//
// This function checks whether a match's title+body actually contains the
// keyword before it reaches the engagement gate and classification pipeline.
//
//   phrase      → exact case-insensitive substring match
//   keyword /
//   competitor  → every individual word in the keyword must appear somewhere
//                 in title+body (AND logic, not proximity)

/**
 * @param {{ title?: string, body?: string }} match
 * @param {string} keyword
 * @param {string} [kwType]  'phrase' | 'keyword' | 'competitor'
 * @returns {boolean}
 */
export function passesRelevanceCheck(match, keyword, kwType) {
  const haystack = `${match.title || ''} ${match.body || ''}`.toLowerCase()
  const needle   = (keyword || '').toLowerCase()
  if (!needle) return true
  if (kwType === 'phrase') return haystack.includes(needle)
  return needle.split(/\s+/).filter(Boolean).every(w => haystack.includes(w))
}
