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
  'stackoverflow',
  'indiehackers',
  'g2',
  'medium',
  'substack',
  'quora',
  'upwork',
  'fiverr',
  'github',
  'producthunt',
  'twitter',
  'jijing',
  'youtube',
  'amazon',
  'rss',
  'telegram',
]

export const PLATFORM_LABELS = {
  reddit:        'Reddit',
  hackernews:    'Hacker News',
  stackoverflow: 'Stack Overflow',
  indiehackers:  'Indie Hackers',
  g2:            'G2 Reviews',
  medium:        'Medium',
  substack:      'Substack',
  quora:         'Quora',
  upwork:        'Upwork',
  fiverr:        'Fiverr',
  github:        'GitHub',
  producthunt:   'Product Hunt',
  twitter:       'Twitter/X',
  jijing:        'Jiji.ng',
  youtube:       'YouTube',
  amazon:        'Amazon Reviews',
  rss:           'RSS Feeds',
  telegram:      'Telegram',
}

export const PLATFORM_EMOJIS = {
  reddit:        '🔴',
  hackernews:    '🟠',
  stackoverflow: '🟡',
  indiehackers:  '🦸',
  g2:            '⭐',
  medium:        '📰',
  substack:      '📧',
  quora:         '💬',
  upwork:        '💼',
  fiverr:        '🟢',
  github:        '🐙',
  producthunt:   '🚀',
  twitter:       '🐦',
  jijing:        '🇳🇬',
  youtube:       '▶️',
  amazon:        '📦',
  rss:           '📡',
  telegram:      '✈️',
}

const VALID_SET = new Set(VALID_PLATFORMS)

// Platforms that are currently unavailable due to external service changes.
// The platform stays in VALID_PLATFORMS so existing monitors aren't broken;
// the chip selector in the dashboard renders these as disabled with the note
// shown here, /v1/search filters them out, and monitor-v2.js / monitor.js
// skip them in their dispatch loops (see isPlatformDisabled()).
//
// To re-enable, delete the entry and verify the scraper end-to-end against
// production traffic — the per-platform `re-enable` notes below describe
// what the upstream blocker is.
export const PLATFORM_DISABLED = {
  quora:         'Temporarily unavailable',
  // Twitter: agent-twitter-client login flow returns "code 34" on every
  // request (Twitter/X has hardened anonymous scraping). Re-enable once we
  // adopt a paid X API tier (TWITTER_BEARER_TOKEN) or a vetted third-party
  // search backend (e.g. Apify Twitter actor, twitterapi.io).
  twitter:       'Twitter/X scraping blocked (code 34 on every request)',
  // Stack Overflow: Stack Exchange API returns 400 on most search queries
  // and 429 with 300s backoffs on the rest, so cycles waste 15+ minutes
  // for zero results. Re-enable once STACK_APPS_KEY is provisioned (raises
  // quota from 300 → 10,000/day) AND the q-param format is rebuilt to
  // match Stack Exchange's tag-aware search syntax.
  stackoverflow: 'Stack Exchange API returns 400/429 on every query',
  // YouTube: GCP quota for the configured Data API v3 project is permanently
  // exhausted (observed 270+/200 keyword cap; one search costs 100 units +
  // 3 commentThreads × 1 = 103). Re-enable once GCP quota is upgraded OR
  // YOUTUBE_DAILY_MAX is bumped after expanding the quota in Cloud Console.
  youtube:       'YouTube Data API v3 daily quota exhausted',
  // Upwork: community.upwork.com returns 403 on every request (Khoros has
  // hardened the bot detection). Re-enable when an alternative data path
  // is wired in — Apify Upwork actor or a logged-in HTTP session.
  upwork:        'Upwork Community returns 403 on every request',
  // Jiji.ng: Cloudflare challenge fires on every server-side request to
  // jiji.ng/search. Re-enable when a residential-proxy fetch path or
  // Apify Jiji actor is in place.
  jijing:        'Jiji.ng returns 403 (Cloudflare challenge)',
  // Indie Hackers: every server-side fetch times out (observed 19/19
  // keyword queries timing out per cycle on the Idea Validation Tool
  // monitor on May 12 — ~6 minutes of wasted cycle wall-clock). Endpoint
  // appears to be either down or hardened against scrapers. Re-enable when
  // a different fetch path (e.g. their public RSS, or an Apify actor)
  // proves it can complete a request.
  indiehackers:  'Indie Hackers endpoint times out on every request',
  // G2: same timeout pattern as Indie Hackers. Possibly Cloudflare-walled.
  // Re-enable with a working fetch backend.
  g2:            'G2 endpoint times out on every request',
}

/**
 * Convenience predicate for runtime callers (monitor-v2.js, monitor.js,
 * api-server.js) — returns true when the platform should be skipped before
 * any network call. Keeps the disable list as the single source of truth.
 *
 * @param {string} platform
 * @returns {boolean}
 */
export function isPlatformDisabled(platform) {
  return Object.prototype.hasOwnProperty.call(PLATFORM_DISABLED, platform)
}

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
