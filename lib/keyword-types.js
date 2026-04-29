// lib/keyword-types.js — keyword type system + legacy-format migration.
//
// Each keyword stored on a monitor declares whether it's a 'keyword' (your
// own product / market signal) or a 'competitor' (matches you might want
// to win over with a friendlier reply). The default for any keyword that
// doesn't declare a type — including pre-PR-#28 monitors stored as plain
// strings — is 'keyword'. Legacy monitors are auto-migrated on read; we
// never break an existing monitor's keyword list.

export const VALID_KEYWORD_TYPES = ['keyword', 'competitor']
const VALID_SET = new Set(VALID_KEYWORD_TYPES)

/**
 * Normalize a single keyword entry from any of the supported input shapes:
 *   - 'plain string'                                          → { keyword, type: 'keyword' }
 *   - { keyword: '...', subreddits, productContext }          → adds type: 'keyword'
 *   - { keyword: '...', type: 'competitor', ... }             → preserves type
 *   - { term: '...', type: 'keyword' }                        → renames to keyword
 *
 * Unknown / invalid type values fall back to 'keyword' silently. Returns
 * null for empty/junk input so the caller can filter.
 */
export function normalizeKeyword(input) {
  if (input == null) return null

  if (typeof input === 'string') {
    const k = input.trim()
    if (k.length < 2) return null
    return { keyword: k, type: 'keyword', subreddits: [], productContext: '' }
  }

  if (typeof input !== 'object') return null

  // Accept either `keyword` (current API field) or `term` (spec also uses this)
  const term = String(input.keyword ?? input.term ?? '').trim()
  if (term.length < 2) return null

  const rawType = String(input.type ?? 'keyword').trim().toLowerCase()
  const type = VALID_SET.has(rawType) ? rawType : 'keyword'

  const subreddits = Array.isArray(input.subreddits) ? input.subreddits.slice(0, 10) : []
  const productContext = String(input.productContext || '').slice(0, 500)

  return { keyword: term, type, subreddits, productContext }
}

/**
 * Normalize and clean an array of keyword entries, dropping falsy / junk
 * results from normalizeKeyword.
 */
export function normalizeKeywordList(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const raw of input) {
    const k = normalizeKeyword(raw)
    if (k) out.push(k)
  }
  return out
}

export function isValidKeywordType(type) {
  return typeof type === 'string' && VALID_SET.has(type.trim().toLowerCase())
}

// ── ISO week labels for share-of-voice keys ─────────────────────────────────
// SoV counters are bucketed by ISO week (Mon-Sun). We use the standard
// "YYYY-Www" format (e.g. "2026-W17") so keys sort lexically.

/**
 * @param {Date} d
 * @returns {string}  "YYYY-Www"  (week number is zero-padded to 2 digits)
 */
export function isoWeekLabel(d = new Date()) {
  // Copy to UTC midnight on Thursday of the current week — ISO 8601 says
  // a week's "year" is the calendar year of its Thursday.
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dow = tmp.getUTCDay() || 7   // Sunday = 7 (not 0)
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dow)
  const yearStart = Date.UTC(tmp.getUTCFullYear(), 0, 1)
  const weekNum = Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7)
  const ww = String(weekNum).padStart(2, '0')
  return `${tmp.getUTCFullYear()}-W${ww}`
}

/**
 * @param {Date} d
 * @returns {string} the previous ISO week's label
 */
export function previousIsoWeekLabel(d = new Date()) {
  const earlier = new Date(d.getTime() - 7 * 24 * 60 * 60 * 1000)
  return isoWeekLabel(earlier)
}
