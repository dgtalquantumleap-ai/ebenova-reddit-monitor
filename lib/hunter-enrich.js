// lib/hunter-enrich.js — Hunter.io lead enrichment for high-intent Reddit matches.
//
// Called during the monitor cycle for Reddit matches with intentScore >= 70.
// Attempts to surface the poster's professional email and company using:
//   1. Email Finder (name + domain extracted from post content) — highest accuracy
//   2. Domain Search fallback (any verified contact at the domain)
//
// Design principles:
//   - NEVER throws. Always returns { enriched, reason?, data? }.
//   - Redis-cached with 30-day TTL — same author never queried twice per window.
//   - Gated on HUNTER_API_KEY. Silently skips if key is absent.
//   - Timeout-safe — all Hunter fetches have 8s AbortSignal.
//
// Redis key: author:enrichment:{monitorId}:{platform}:{author}

import { isPlaceholderAuthor } from './author-profiles.js'

const HUNTER_API_KEY   = process.env.HUNTER_API_KEY
const ENRICHMENT_TTL   = 60 * 60 * 24 * 30   // 30 days in seconds
const HUNTER_BASE      = 'https://api.hunter.io/v2'
const MIN_INTENT_SCORE = 70                   // only enrich high-signal matches

// ── Username → name heuristic ─────────────────────────────────────────────────
// Reddit usernames: "john_smith_dev", "JohnSmith123", "john.doe"
// Returns { firstName, lastName? } or null if unparseable.
function parseNameFromUsername(username) {
  if (!username || typeof username !== 'string') return null
  const cleaned = username.replace(/\d+$/, '').replace(/[_\-\.]+$/, '').trim()
  if (!cleaned || cleaned.length < 2) return null
  const parts = cleaned.split(/[_\-\.]+/).filter(p => p.length >= 2)
  const titleCase = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
  if (parts.length >= 2) {
    return { firstName: titleCase(parts[0]), lastName: titleCase(parts[1]) }
  }
  if (parts.length === 1) {
    const camel = cleaned.match(/[A-Z][a-z]+/g)
    if (camel && camel.length >= 2) {
      return { firstName: camel[0], lastName: camel.slice(1).join('') }
    }
    return { firstName: titleCase(cleaned) }
  }
  return null
}

// ── Domain extraction from post content ───────────────────────────────────────
// Finds "https://company.com", "www.company.com", or "at company.com" patterns.
function extractDomainFromPost(match) {
  const text = `${match.title || ''} ${match.body || ''}`
  const urlMatch = text.match(/(?:https?:\/\/|www\.)([\w-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)/i)
  if (urlMatch) return urlMatch[1].replace(/^www\./, '').toLowerCase()
  const atMatch = text.match(/\bat\s+([\w-]+\.[a-z]{2,})\b/i)
  if (atMatch) return atMatch[1].toLowerCase()
  return null
}

// ── Hunter Email Finder ───────────────────────────────────────────────────────
async function hunterEmailFinder({ firstName, lastName, domain }) {
  if (!firstName || !domain) return null
  const params = new URLSearchParams({ first_name: firstName, domain, api_key: HUNTER_API_KEY })
  if (lastName) params.set('last_name', lastName)
  try {
    const res = await fetch(`${HUNTER_BASE}/email-finder?${params}`, {
      headers: { 'User-Agent': 'ebenova-insights/2.0' },
      signal: AbortSignal.timeout(8000),
    })
    if (res.status === 401 || res.status === 403) {
      console.error('[hunter] invalid API key — check HUNTER_API_KEY in Railway env vars')
      return null
    }
    if (res.status === 429) {
      console.warn('[hunter] rate limited — skipping this match')
      return null
    }
    if (!res.ok) return null
    const data = await res.json()
    return data?.data || null
  } catch (err) {
    console.warn(`[hunter] email-finder failed: ${err.message}`)
    return null
  }
}

// ── Hunter Domain Search (fallback) ──────────────────────────────────────────
async function hunterDomainSearch(domain) {
  const params = new URLSearchParams({ domain, limit: '3', api_key: HUNTER_API_KEY })
  try {
    const res = await fetch(`${HUNTER_BASE}/domain-search?${params}`, {
      headers: { 'User-Agent': 'ebenova-insights/2.0' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const emails = data?.data?.emails || []
    if (emails.length === 0) return null
    const top = emails[0]
    return {
      email:      top.value,
      firstName:  top.first_name  || null,
      lastName:   top.last_name   || null,
      confidence: top.confidence  || null,
      company:    data?.data?.organization || null,
    }
  } catch (err) {
    console.warn(`[hunter] domain-search failed: ${err.message}`)
    return null
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
// enrichAuthor({ match, monitorId, redis })
//   → { enriched: boolean, data?: object, reason?: string, fromCache?: boolean }
//
// Attach result.data to match as m._hunterData before building alert email
// so the Lead Intel pill appears in the email match card.
export async function enrichAuthor({ match, monitorId, redis }) {
  if (!HUNTER_API_KEY)                                        return { enriched: false, reason: 'no-api-key' }
  if (!match?.author || isPlaceholderAuthor(match.author, match.source))
                                                              return { enriched: false, reason: 'placeholder-author' }
  if (match.source !== 'reddit')                             return { enriched: false, reason: 'non-reddit-source' }
  if (typeof match.intentScore === 'number' && match.intentScore < MIN_INTENT_SCORE)
                                                              return { enriched: false, reason: 'low-intent-score' }

  const author   = String(match.author).trim()
  const cacheKey = `author:enrichment:${monitorId}:${match.source}:${author}`

  // Redis cache check — avoid burning API credits on already-seen authors
  if (redis) {
    try {
      const cached = await redis.hgetall(cacheKey)
      if (cached && Object.keys(cached).length > 0) {
        if (cached.noData === '1') return { enriched: false, reason: 'cached-no-data' }
        return { enriched: true, data: cached, fromCache: true }
      }
    } catch (_) {}
  }

  const parsed = parseNameFromUsername(author)
  const domain = extractDomainFromPost(match)
  let result   = null
  let strategy = null

  // Strategy 1: email-finder — name + domain (most accurate)
  if (parsed?.firstName && domain) {
    const found = await hunterEmailFinder({ firstName: parsed.firstName, lastName: parsed.lastName, domain })
    if (found) {
      result   = {
        email:      found.email        || null,
        firstName:  found.first_name   || parsed.firstName,
        lastName:   found.last_name    || parsed.lastName || null,
        company:    found.organization || null,
        linkedinUrl: null,
        confidence: found.score        || null,
        domain,
      }
      strategy = 'email-finder'
    }
  }

  // Strategy 2: domain-search fallback
  if (!result && domain) {
    const found = await hunterDomainSearch(domain)
    if (found) {
      result   = { ...found, linkedinUrl: null, domain }
      strategy = 'domain-search'
    }
  }

  // Nothing found — store tombstone to avoid retrying
  if (!result) {
    if (redis) {
      redis.hset(cacheKey, { noData: '1', enrichedAt: new Date().toISOString() }).catch(() => {})
      redis.expire(cacheKey, ENRICHMENT_TTL).catch(() => {})
    }
    return { enriched: false, reason: 'no-hunter-data', author, domain }
  }

  // Persist enrichment to Redis
  const enrichData = {
    author,
    email:       result.email       || '',
    firstName:   result.firstName   || '',
    lastName:    result.lastName    || '',
    company:     result.company     || '',
    linkedinUrl: result.linkedinUrl || '',
    confidence:  result.confidence  != null ? String(result.confidence) : '',
    domain:      result.domain      || domain || '',
    strategy:    strategy           || '',
    enrichedAt:  new Date().toISOString(),
  }

  if (redis) {
    redis.hset(cacheKey, enrichData).catch(() => {})
    redis.expire(cacheKey, ENRICHMENT_TTL).catch(() => {})
  }

  return { enriched: true, data: enrichData }
}
