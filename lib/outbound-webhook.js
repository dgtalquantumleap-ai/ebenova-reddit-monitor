// lib/outbound-webhook.js — fire-and-forget outbound webhook delivery for
// per-monitor `webhookUrl` configurations. Used by:
//   - monitor-v2.js runMonitor → sends a `new_match` event for each approved
//     match found in the cycle (does NOT block the cycle on delivery)
//   - api-server.js POST /v1/monitors/:id/test-webhook → sends a sample
//     payload synchronously so the dashboard's "Test webhook" button can
//     show success/failure inline
//
// Delivery rules (per spec):
//   - https:// URLs only — http is rejected
//   - 5-second timeout per request
//   - On failure: log [webhook] delivery failed for {monitorId}: {reason}
//     and return a structured result; never throw, never retry
//   - The runMonitor loop fires these and forgets — failed deliveries are
//     logged but the cycle proceeds

const TIMEOUT_MS = 5000

/**
 * Build the standard "new_match" or "test" payload from a match record.
 * Pulls only the fields documented in the public spec — no productContext,
 * no internal storedAt, no draftedBy. Adds `postAgeHours` as a convenience.
 */
export function buildPayload({ event, monitorId, match, sentAt }) {
  if (!monitorId) throw new Error('buildPayload: monitorId required')
  const m = match
    ? {
        id: match.id,
        title: match.title,
        url: match.url,
        subreddit: match.subreddit,
        author: match.author,
        score: match.score,
        comments: match.comments,
        body: match.body,
        createdAt: match.createdAt,
        keyword: match.keyword,
        source: match.source,
        sentiment: match.sentiment ?? null,
        intent: match.intent ?? null,
        intentConfidence: match.intentConfidence ?? null,
        draft: match.draft ?? null,
        postAgeHours: match.createdAt
          ? Math.round((Date.now() - new Date(match.createdAt).getTime()) / 36e5 * 10) / 10
          : null,
        approved: !!match.approved,
      }
    : null
  return {
    event: event || 'new_match',
    monitorId,
    match: m,
    sentAt: sentAt || new Date().toISOString(),
  }
}

/**
 * POST a payload to a webhook URL with a hard 5s timeout.
 *
 * @returns {Promise<{ delivered: boolean, reason?: string, status?: number, error?: string }>}
 */
export async function sendOutboundWebhook(url, payload, opts = {}) {
  if (!url) return { delivered: false, reason: 'no-url' }
  let target
  try { target = new URL(String(url).trim()) } catch (_) { return { delivered: false, reason: 'invalid-url' } }
  if (target.protocol !== 'https:') return { delivered: false, reason: 'not-https' }

  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  try {
    const res = await fetch(target.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': opts.userAgent || 'EbenovaInsights/2.0 (webhook)',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { delivered: false, reason: 'non-2xx', status: res.status }
    return { delivered: true, status: res.status }
  } catch (err) {
    return { delivered: false, reason: 'network', error: err.message }
  }
}

/**
 * Fire-and-forget wrapper for the monitor-v2 cycle. Never throws, never
 * blocks. Logs failures. Returns nothing — callers must not await.
 */
export function fireWebhook(url, payload, monitorId) {
  sendOutboundWebhook(url, payload)
    .then(r => {
      if (!r.delivered) {
        const detail = r.status ? ` (status ${r.status})` : r.error ? ` (${r.error})` : ''
        console.warn(`[webhook] delivery failed for ${monitorId}: ${r.reason}${detail}`)
      }
    })
    .catch(err => console.warn(`[webhook] threw for ${monitorId}: ${err.message}`))
}
