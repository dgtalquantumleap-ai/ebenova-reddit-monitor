// lib/reddit-auth.js — Reddit app-only OAuth (client credentials grant).
//
// Reddit's public www.reddit.com/.json endpoints rate-limit anonymous traffic
// aggressively — ~60 req/min, dropping further if the User-Agent looks botty.
// With OAuth client credentials we get ~600 req/10min via oauth.reddit.com,
// roughly 10x headroom. App-only auth needs no user login: a server-side POST
// with Basic(client_id:client_secret) returns a bearer token.
//
// Usage:
//   const { token } = await getRedditAccessToken()       // throws if creds missing
//   const ok = isRedditAuthConfigured()                  // true if creds present
//   const url = redditOAuthHost() + '/r/SaaS/search.json' // oauth.reddit.com
//
// Token lifecycle:
//   - Cached in module scope across the worker process (~24h Reddit TTL)
//   - getRedditAccessToken() returns cached if expiry > now + safety margin
//   - 401 from a Reddit call should call invalidateRedditToken() then retry once
//   - Concurrent callers share a single in-flight refresh promise (no thundering
//     herd on cold start)
//
// Configurable via env:
//   REDDIT_CLIENT_ID       — required for OAuth
//   REDDIT_CLIENT_SECRET   — required for OAuth
//   REDDIT_USER_AGENT      — unique UA per Reddit policy (defaults to a sane value)

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token'
const OAUTH_HOST = 'https://oauth.reddit.com'
const PUBLIC_HOST = 'https://www.reddit.com'

// 5-minute safety margin: refresh before the token actually expires so we
// never use a token that could fail mid-request.
const REFRESH_MARGIN_MS = 5 * 60 * 1000

let _cachedToken = null
let _cachedExpiresAt = 0
let _inFlightRefresh = null

export function isRedditAuthConfigured() {
  return !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET)
}

export function redditOAuthHost() {
  return OAUTH_HOST
}

export function redditPublicHost() {
  return PUBLIC_HOST
}

export function redditUserAgent() {
  return process.env.REDDIT_USER_AGENT
    || 'Mozilla/5.0 (compatible; EbenovaBot/2.0; +https://ebenova-insights-production.up.railway.app)'
}

/**
 * Force the next call to fetch a fresh token. Use this when a Reddit API
 * call returns 401 (token might have been revoked / clock-skewed expiry).
 */
export function invalidateRedditToken() {
  _cachedToken = null
  _cachedExpiresAt = 0
  _inFlightRefresh = null
}

/**
 * For tests — clear all module-level state so each test starts clean.
 * Not for production code paths.
 */
export function _resetForTests() {
  invalidateRedditToken()
}

async function fetchFreshToken() {
  const id = process.env.REDDIT_CLIENT_ID
  const secret = process.env.REDDIT_CLIENT_SECRET
  if (!id || !secret) {
    throw new Error('REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET required for OAuth')
  }
  const basic = Buffer.from(`${id}:${secret}`).toString('base64')
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': redditUserAgent(),
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err = new Error(`Reddit token fetch ${res.status}: ${body.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  const data = await res.json()
  if (!data.access_token) {
    throw new Error(`Reddit token response missing access_token: ${JSON.stringify(data).slice(0, 200)}`)
  }
  // expires_in is in seconds; default to 1h if Reddit omits it
  const ttlMs = (data.expires_in || 3600) * 1000
  return {
    token: data.access_token,
    expiresAt: Date.now() + ttlMs,
  }
}

/**
 * Get a valid Reddit OAuth bearer token. Returns the cached token if it
 * still has > REFRESH_MARGIN_MS to live. Otherwise refreshes.
 *
 * Concurrent callers share the same in-flight refresh promise so we don't
 * hammer Reddit's token endpoint during cold start or after a 401 retry.
 *
 * @returns {Promise<{ token: string, expiresAt: number }>}
 */
export async function getRedditAccessToken() {
  const now = Date.now()
  if (_cachedToken && _cachedExpiresAt > now + REFRESH_MARGIN_MS) {
    return { token: _cachedToken, expiresAt: _cachedExpiresAt }
  }
  // Coalesce concurrent refreshes into a single in-flight request
  if (_inFlightRefresh) return _inFlightRefresh
  _inFlightRefresh = (async () => {
    try {
      const { token, expiresAt } = await fetchFreshToken()
      _cachedToken = token
      _cachedExpiresAt = expiresAt
      return { token, expiresAt }
    } finally {
      _inFlightRefresh = null
    }
  })()
  return _inFlightRefresh
}

/**
 * Convenience: return headers ready to pass to a Reddit fetch call.
 * Throws if OAuth not configured — caller should check isRedditAuthConfigured()
 * first if it wants to fall back to anonymous.
 */
export async function redditAuthHeaders() {
  const { token } = await getRedditAccessToken()
  return {
    'Authorization': `Bearer ${token}`,
    'User-Agent': redditUserAgent(),
  }
}
