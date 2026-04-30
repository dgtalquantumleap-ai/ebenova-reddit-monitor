// lib/platforms.js — Source of truth for which platforms a monitor can scan.
//
// A monitor stores platforms as an array on its record:
//   monitor.platforms = ['reddit', 'medium']
//
// All gating happens against this array. Legacy monitors created before this
// feature shipped don't have the field — migrateLegacyPlatforms() derives it
// from the older includeXxx flags so existing users keep their current
// scanners (and don't suddenly get HN/GitHub/ProductHunt unless they opt in).

// LinkedIn is intentionally not in VALID_PLATFORMS yet. lib/scrapers/linkedin.js
// exists and works structurally, but every viable open search backend (Google,
// Bing, DuckDuckGo) either blocks server-side requests or doesn't index
// linkedin.com/posts/. Re-add 'linkedin' here (and re-wire monitor-v2.js +
// api-server.js) once a real source is in place — e.g. an Apify LinkedIn
// actor, or a Brave/Serper API key with proven coverage.
export const VALID_PLATFORMS = [
  'reddit',
  'hackernews',
  'medium',
  'substack',
  'quora',
  'upwork',
  'fiverr',
  'github',
  'producthunt',
  'twitter',
  'jijing',
]

export const PLATFORM_LABELS = {
  reddit:      'Reddit',
  hackernews:  'Hacker News',
  medium:      'Medium',
  substack:    'Substack',
  quora:       'Quora',
  upwork:      'Upwork',
  fiverr:      'Fiverr',
  github:      'GitHub',
  producthunt: 'Product Hunt',
  twitter:     'Twitter/X',
  jijing:      'Jiji.ng',
}

export const PLATFORM_EMOJIS = {
  reddit:      '🔴',
  hackernews:  '🟠',
  medium:      '📰',
  substack:    '📧',
  quora:       '💬',
  upwork:      '💼',
  fiverr:      '🟢',
  github:      '🐙',
  producthunt: '🚀',
  twitter:     '🐦',
  jijing:      '🇳🇬',
}

const VALID_SET = new Set(VALID_PLATFORMS)

/**
 * Validate a platforms input. Accepts arrays only.
 *
 * @param {*} input
 * @returns {{ ok: true, platforms: string[] } | { ok: false, error: string }}
 */
export function validatePlatforms(input) {
  if (!Array.isArray(input)) {
    return { ok: false, error: '`platforms` must be an array' }
  }
  if (input.length === 0) {
    return { ok: false, error: '`platforms` must contain at least 1 platform' }
  }
  if (input.length > VALID_PLATFORMS.length) {
    return { ok: false, error: `\`platforms\` cannot exceed ${VALID_PLATFORMS.length} entries` }
  }
  // Lowercase + trim each entry; reject anything not in the whitelist.
  const cleaned = []
  const seen = new Set()
  for (const raw of input) {
    if (typeof raw !== 'string') {
      return { ok: false, error: 'every platform must be a string' }
    }
    const p = raw.trim().toLowerCase()
    if (!VALID_SET.has(p)) {
      return {
        ok: false,
        error: `unknown platform "${raw}". Valid options: ${VALID_PLATFORMS.join(', ')}`,
      }
    }
    if (!seen.has(p)) { seen.add(p); cleaned.push(p) }
  }
  return { ok: true, platforms: cleaned }
}

/**
 * For backward compatibility: derive a platforms array for a monitor that
 * pre-dates this feature. Old monitors had `includeMedium` / `includeSubstack`
 * etc. flags (default true) and Reddit was always-on.
 *
 * Behavior:
 *   - If monitor.platforms exists → return it as-is (after dedup/lowercase)
 *   - Else: ['reddit'] always, plus any include* flag that's truthy or absent
 *     (the old default for include* fields was "true unless explicitly false")
 *   - HN / GitHub / ProductHunt are NOT auto-added — they weren't running on
 *     legacy monitors, so legacy users don't suddenly start receiving extra
 *     platform noise. New monitors opt in explicitly.
 *
 * @param {object} monitor  the monitor record from Redis
 * @returns {string[]}
 */
export function migrateLegacyPlatforms(monitor) {
  if (Array.isArray(monitor?.platforms) && monitor.platforms.length > 0) {
    // Already migrated. Still validate to filter junk.
    const v = validatePlatforms(monitor.platforms)
    return v.ok ? v.platforms : ['reddit']
  }
  const out = ['reddit']
  if (monitor?.includeMedium      !== false) out.push('medium')
  if (monitor?.includeSubstack    !== false) out.push('substack')
  if (monitor?.includeQuora       !== false) out.push('quora')
  if (monitor?.includeUpworkForum !== false) out.push('upwork')
  if (monitor?.includeFiverrForum !== false) out.push('fiverr')
  return out
}

/**
 * Convenience: given a monitor record, return the effective platforms list
 * the worker should scan. Combines migration with validation in one call.
 */
export function getEffectivePlatforms(monitor) {
  return migrateLegacyPlatforms(monitor)
}
