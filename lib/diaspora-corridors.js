// lib/diaspora-corridors.js — Diaspora corridor configurations (Roadmap #36).
//
// A "corridor" is a paired-geography monitor blueprint: a city the user is
// in, and a country the user is connected to back home. The dashboard
// surfaces this so a Lagos-based real-estate firm can target UK-Nigerian
// investors without hand-picking subreddits, and so a Houston-based
// consultancy can target US-Nigerian remittance senders without thinking
// about platform pickers at all.
//
// Each corridor is a complete monitor blueprint — keywords, platforms,
// and Reddit subreddits — that overrides the per-monitor defaults at
// poll time when monitor.diasporaCorridor is set.
//
// Subreddits are intentionally hidden from the public list endpoint
// (same pattern as keyword-presets.js): they're a worker hint, not a UI
// element, and exposing them would leak the monitor's actual scrape plan.

/**
 * @typedef {Object} DiasporaCorridor
 * @property {string}    id           stable slug (e.g. 'lagos_london')
 * @property {string}    label        human display
 * @property {string}    emoji        flag-pair glyph for the picker
 * @property {string}    description  short tagline
 * @property {string[]}  platforms    ids from VALID_PLATFORMS
 * @property {string[]}  subreddits   Reddit subreddit hints
 * @property {string[]}  keywords     pre-configured keyword phrases
 */

/** @type {DiasporaCorridor[]} */
export const DIASPORA_CORRIDORS = [
  {
    id:          'lagos_london',
    label:       'Lagos ↔ London',
    emoji:       '🇳🇬🇬🇧',
    description: 'UK Nigerians investing back home',
    platforms:   ['reddit', 'quora'],
    subreddits:  ['unitedkingdom', 'london', 'Nigeria', 'UKPersonalFinance', 'expatriados'],
    keywords: [
      'property investment Nigeria',
      'send money to Nigeria',
      'Nigerian real estate UK',
      'invest in Lagos',
      'diaspora investment Nigeria',
    ],
  },
  {
    id:          'lagos_toronto',
    label:       'Lagos ↔ Toronto',
    emoji:       '🇳🇬🇨🇦',
    description: 'Canadian diaspora seeking Nigerian goods',
    platforms:   ['reddit', 'quora'],
    subreddits:  ['canada', 'toronto', 'Nigeria', 'PersonalFinanceCanada'],
    keywords: [
      'Nigerian community Toronto',
      'send money Nigeria Canada',
      'Nigerian food Toronto',
      'invest back home Nigeria',
      'diaspora remittance',
    ],
  },
  {
    id:          'lagos_houston',
    label:       'Lagos ↔ Houston',
    emoji:       '🇳🇬🇺🇸',
    description: 'US diaspora connected to Nigeria',
    platforms:   ['reddit', 'quora'],
    subreddits:  ['houston', 'Nigeria', 'personalfinance', 'NigerianAmericans'],
    keywords: [
      'Nigerian community Houston',
      'send money to Nigeria USA',
      'Nigerian real estate investment',
      'African diaspora business',
      'remittance to Nigeria',
    ],
  },
]

const CORRIDOR_BY_ID = Object.fromEntries(DIASPORA_CORRIDORS.map(c => [c.id, c]))

/**
 * Public-shape view of a corridor (omits `subreddits` — same rationale as
 * keyword-presets.js: worker hint, not UI element).
 */
export function corridorForList(corridor) {
  if (!corridor) return null
  const { subreddits: _omit, ...rest } = corridor
  return rest
}

/** @returns {DiasporaCorridor[]} all corridors (list-shape, no subreddits) */
export function listCorridors() {
  return DIASPORA_CORRIDORS.map(corridorForList)
}

/** @param {string} id  @returns {DiasporaCorridor | null} */
export function getCorridor(id) {
  if (!id || typeof id !== 'string') return null
  return CORRIDOR_BY_ID[id] || null
}

/**
 * Return true if the corridor id is one we recognize. Used by api-server
 * to validate the diasporaCorridor field on POST/PATCH.
 */
export function isValidCorridorId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(CORRIDOR_BY_ID, id)
}
