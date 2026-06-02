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
//                 in title+body (AND logic, not proximity). Pure grammatical
//                 function words (articles, prepositions, conjunctions,
//                 pronouns) are excluded — but content words like "need",
//                 "want", "build", "find" are kept because they carry signal.

// Pure grammatical function words only — articles, prepositions,
// conjunctions, auxiliary verbs, and pronouns that appear in every post
// and add zero discriminating signal. Deliberately NOT including content
// words like need/want/find/build/fail/struggle even though they're common.
const STOP_WORDS = new Set([
  // articles
  'a','an','the',
  // conjunctions
  'and','or','but','nor','so','yet',
  // prepositions
  'in','on','at','to','for','of','with','by','from','into','onto',
  'about','above','after','before','between','during','out','over',
  'through','under','up','down','as','per',
  // pronouns
  'i','me','my','we','us','our','you','your','he','him','his',
  'she','her','they','them','their','it','its','this','that',
  'these','those','who','whom','which','what',
  // pure auxiliary verbs (no semantic content on their own)
  'is','are','was','were','be','been','being',
  'am','do','does','did','will','would','shall','should',
  'may','might','must','can','could','have','has','had',
  // other function words
  'not','no','also','just','very','too','more','most','than','then',
  'if','how','when','where','why','any','some','all','each','both',
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

  // For keyword/competitor: meaningful words must appear in title+body.
  // Filter out pure function words, then require a majority (not all) of
  // the remaining words to match. This handles conversational keywords like
  // "struggling to find people to work with" where a post might say
  // "can't find co-founder" — close enough but not every word present.
  //
  // Threshold: 100% for 1-2 content words, 75% for 3-4, 60% for 5+.
  // This prevents both false negatives (too strict) and noise (too loose).
  const words = needle.split(/\s+/).filter(Boolean)
  const meaningful = words.filter(w => w.length > 1 && !STOP_WORDS.has(w))
  const checkList = meaningful.length > 0 ? meaningful : words

  const required = checkList.length <= 2 ? checkList.length
    : checkList.length <= 4 ? Math.ceil(checkList.length * 0.75)
    : Math.ceil(checkList.length * 0.60)

  const matched = checkList.filter(w => haystack.includes(w)).length
  return matched >= required
}
