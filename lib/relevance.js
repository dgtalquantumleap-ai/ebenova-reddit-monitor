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
//   competitor  → every *meaningful* word in the keyword must appear somewhere
//                 in title+body (AND logic, not proximity). Stop-words (a, the,
//                 my, for, to, etc.) are excluded from the AND check so short
//                 function words don't inflate apparent coverage.

// Common English stop-words that add no signal to the AND-word check.
const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'my','your','our','their','its','is','are','was','were','be','been',
  'i','we','you','he','she','they','it','this','that','how','what',
  'do','does','can','could','would','should','will','have','has','had',
  'get','got','need','want','find','looking','best','good','any','some',
  'from','about','after','before','into','out','up','down','as','by',
])

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

  // For keyword/competitor: all meaningful words must appear in title+body.
  // Filter out stop-words so "how to find a technical co-founder" doesn't
  // pass just because "a" and "to" are in every post.
  const words = needle.split(/\s+/).filter(Boolean)
  const meaningful = words.filter(w => w.length > 2 && !STOP_WORDS.has(w))

  // If all words are stop-words (e.g. keyword is "it is"), fall back to
  // the full word list to avoid passing everything.
  const checkList = meaningful.length > 0 ? meaningful : words

  return checkList.every(w => haystack.includes(w))
}
