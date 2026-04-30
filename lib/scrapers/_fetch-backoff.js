// lib/scrapers/_fetch-backoff.js — shared 429-aware fetch wrapper.
//
// Public-search scrapers (Quora, Upwork, Fiverr, HN, Amazon) share a
// failure mode: a 429 response without exponential backoff just retries
// on the next cycle and escalates the ban risk. This wrapper:
//   - retries up to maxRetries times on 429
//   - honors Retry-After header if present, else 60s baseline
//   - exponential backoff: baseline × 2^attempt, capped at 5 minutes
//   - returns null when retries are exhausted (caller treats as "skip")
//
// Reddit's RSS scraper has its own Retry-After handling already and is
// NOT routed through this — leave it alone (intentional, per audit fix
// scope).

const MAX_BACKOFF_MS = 5 * 60 * 1000

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Fetch with exponential backoff on HTTP 429. Returns:
 *   - the Response when fetch succeeds (any status other than 429), OR
 *   - null when 429 retries are exhausted.
 *
 * Network errors (fetch throws) still propagate — the caller's existing
 * try/catch handles those. Don't blanket-catch them here; an ECONNREFUSED
 * is an immediate "skip" rather than a "retry indefinitely" signal.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number}      [maxRetries=3]
 * @returns {Promise<Response | null>}
 */
export async function fetchWithBackoff(url, options = {}, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, options)
    if (res.status !== 429) return res

    const retryAfterRaw = res.headers.get?.('retry-after') ?? '60'
    const retryAfterSec = Math.max(1, parseInt(retryAfterRaw, 10) || 60)
    const delayMs = Math.min(retryAfterSec * 1000 * Math.pow(2, attempt), MAX_BACKOFF_MS)
    console.warn(`[scraper] 429 from ${new URL(url).hostname} — backing off ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`)
    await sleep(delayMs)
  }
  console.warn(`[scraper] 429 retries exhausted for ${url}`)
  return null
}

// Test-only export — pin the cap constant.
export const _internals = { MAX_BACKOFF_MS, sleep }
