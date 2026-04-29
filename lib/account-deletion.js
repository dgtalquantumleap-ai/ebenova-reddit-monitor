// lib/account-deletion.js — Token generation, full data wipe, and audit log
// for the unsubscribe + account-delete flow. No login required: every action
// is gated by a 32-byte hex token issued at monitor creation.
//
// Why a separate module:
//   - Keeps api-server.js focused on routing
//   - Lets us test the cleanup logic in isolation against mock-redis
//   - Single source of truth for "what does deletion remove"
//
// Token storage layout:
//   unsubscribe:{token}                    → monitorId   (lookup index)
//   monitor.unsubscribeToken               → token       (round-trip on the record)
//   monitor.emailEnabled                   → bool        (true|false)
//
// Cleanup on POST /delete-account:
//   - insights:monitor:{id}                config
//   - insights:matches:{id}                match-id list
//   - insights:match:{id}:*                individual match records (lazy via list)
//   - insights:active_monitors             remove id from set
//   - insights:monitors:{owner}            remove id from set
//   - unsubscribe:{token}                  token reverse-index
//   - if owner has no other monitors after this:
//       apikey:{key}                       user record
//       insights:signup:{normalized_email} signup record
//
// Audit log (compliance):
//   deletion_log:{ISO timestamp}           { deletedAt, monitorId, reason } (30d TTL, no PII)

import { randomBytes } from 'crypto'

// 64-char hex (32 bytes), unguessable, URL-safe.
export function generateUnsubscribeToken() {
  return randomBytes(32).toString('hex')
}

/**
 * Resolve a token → monitor record. Returns null if the token doesn't exist
 * or the monitor it points to has already been deleted.
 *
 * @param {object} redis  Upstash redis client (or mock-redis)
 * @param {string} token
 * @returns {Promise<{ monitorId: string, monitor: object }|null>}
 */
export async function resolveUnsubscribeToken(redis, token) {
  if (!token || typeof token !== 'string') return null
  if (!/^[a-f0-9]{64}$/i.test(token)) return null  // strict shape check
  const monitorId = await redis.get(`unsubscribe:${token}`)
  if (!monitorId) return null
  const raw = await redis.get(`insights:monitor:${monitorId}`)
  if (!raw) return null
  const monitor = typeof raw === 'string' ? JSON.parse(raw) : raw
  return { monitorId, monitor }
}

/**
 * Flip monitor.emailEnabled. Used by both /unsubscribe (false) and
 * /resubscribe (true). Returns the updated monitor or null if not found.
 */
export async function setMonitorEmailEnabled(redis, monitorId, enabled) {
  const raw = await redis.get(`insights:monitor:${monitorId}`)
  if (!raw) return null
  const monitor = typeof raw === 'string' ? JSON.parse(raw) : raw
  const updated = { ...monitor, emailEnabled: !!enabled }
  await redis.set(`insights:monitor:${monitorId}`, JSON.stringify(updated))
  return updated
}

/**
 * Permanently delete a monitor and all data tied to it. Best-effort: every
 * step is wrapped in try/catch so a partial failure (e.g. one match key
 * missing) doesn't abort the whole wipe. Returns a summary of what got
 * removed for the response page.
 *
 * If the monitor's owner has no other monitors after this deletion, the
 * user's apikey record + signup record are also removed (full account wipe).
 *
 * @param {object} redis
 * @param {string} monitorId
 * @returns {Promise<{ deleted: string[], errors: string[], accountAlsoDeleted: boolean }>}
 */
export async function deleteMonitorAndData(redis, monitorId) {
  const deleted = []
  const errors = []

  // 1. Read the monitor first so we know who owns it (for owner-set cleanup
  //    + potential full-account wipe at the end).
  let monitor = null
  try {
    const raw = await redis.get(`insights:monitor:${monitorId}`)
    if (raw) monitor = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (err) {
    errors.push(`read monitor: ${err.message}`)
  }
  if (!monitor) {
    return { deleted, errors: [...errors, 'monitor not found'], accountAlsoDeleted: false }
  }

  // 2. Delete every individual match record. The list at insights:matches:{id}
  //    holds match IDs; each match record lives at insights:match:{id}:{postId}.
  try {
    const matchIds = await redis.lrange(`insights:matches:${monitorId}`, 0, -1) || []
    for (const postId of matchIds) {
      try {
        await redis.del(`insights:match:${monitorId}:${postId}`)
        deleted.push(`match:${postId}`)
      } catch (err) {
        errors.push(`del match:${postId}: ${err.message}`)
      }
    }
    await redis.del(`insights:matches:${monitorId}`)
    deleted.push(`matches-list`)
  } catch (err) {
    errors.push(`matches cleanup: ${err.message}`)
  }

  // 3. Remove from active-monitor set + owner-monitor set
  try {
    await redis.srem('insights:active_monitors', monitorId)
    deleted.push('active_monitors_set')
  } catch (err) {
    errors.push(`active_monitors srem: ${err.message}`)
  }
  if (monitor.owner) {
    try {
      await redis.srem(`insights:monitors:${monitor.owner}`, monitorId)
      deleted.push(`owner_set`)
    } catch (err) {
      errors.push(`owner srem: ${err.message}`)
    }
  }

  // 4. Remove the unsubscribe token reverse-index
  if (monitor.unsubscribeToken) {
    try {
      await redis.del(`unsubscribe:${monitor.unsubscribeToken}`)
      deleted.push('unsubscribe_token')
    } catch (err) {
      errors.push(`unsub token del: ${err.message}`)
    }
  }

  // 5. The monitor record itself
  try {
    await redis.del(`insights:monitor:${monitorId}`)
    deleted.push('monitor_record')
  } catch (err) {
    errors.push(`monitor del: ${err.message}`)
  }

  // 6. Full account wipe — only if the owner has no other monitors left.
  //    A starter user has 1 monitor; deletion of that monitor IS their
  //    account. Growth users with multiple monitors keep their account.
  let accountAlsoDeleted = false
  if (monitor.owner) {
    try {
      const remaining = await redis.smembers(`insights:monitors:${monitor.owner}`) || []
      if (remaining.length === 0) {
        // Find the apikey record by scanning the signup index
        const signupRaw = await redis.get(`insights:signup:${monitor.owner}`)
        if (signupRaw) {
          const signup = typeof signupRaw === 'string' ? JSON.parse(signupRaw) : signupRaw
          if (signup.key) {
            try {
              await redis.del(`apikey:${signup.key}`)
              deleted.push('apikey_record')
            } catch (err) { errors.push(`apikey del: ${err.message}`) }
          }
        }
        try {
          await redis.del(`insights:signup:${monitor.owner}`)
          deleted.push('signup_record')
        } catch (err) { errors.push(`signup del: ${err.message}`) }
        // Also clean up the (now-empty) owner monitor set
        try {
          await redis.del(`insights:monitors:${monitor.owner}`)
        } catch (_) {}
        accountAlsoDeleted = true
      }
    } catch (err) {
      errors.push(`account wipe check: ${err.message}`)
    }
  }

  return { deleted, errors, accountAlsoDeleted, owner: monitor.owner }
}

/**
 * Write a deletion audit record. No email, no PII — just the fact that
 * a monitor with this ID was deleted at this time. Held 30 days.
 */
export async function logDeletion(redis, { monitorId, reason = 'user_request' }) {
  const deletedAt = new Date().toISOString()
  const key = `deletion_log:${deletedAt}:${monitorId.slice(0, 8)}`
  try {
    await redis.set(key, JSON.stringify({ deletedAt, monitorId, reason }))
    if (typeof redis.expire === 'function') {
      await redis.expire(key, 30 * 24 * 60 * 60) // 30 days
    }
    return { logged: true, key }
  } catch (err) {
    return { logged: false, reason: err.message }
  }
}

/**
 * Best-effort removal of a contact from a Resend audience. Resend offers a
 * Contacts API; if `RESEND_AUDIENCE_ID` is configured and the contact exists
 * we delete it. Silent no-op when not configured (most setups).
 *
 * @param {object} args
 * @param {string} args.email
 * @param {string} [args.resendKey]   defaults to process.env.RESEND_API_KEY
 * @param {string} [args.audienceId]  defaults to process.env.RESEND_AUDIENCE_ID
 * @returns {Promise<{ removed: boolean, reason?: string }>}
 */
export async function removeResendContact({ email, resendKey, audienceId } = {}) {
  const key = resendKey ?? process.env.RESEND_API_KEY
  const aid = audienceId ?? process.env.RESEND_AUDIENCE_ID
  if (!key) return { removed: false, reason: 'no_resend_key' }
  if (!aid) return { removed: false, reason: 'no_audience_configured' }
  if (!email) return { removed: false, reason: 'no_email' }
  try {
    const url = `https://api.resend.com/audiences/${encodeURIComponent(aid)}/contacts/${encodeURIComponent(email)}`
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) return { removed: true }
    if (res.status === 404) return { removed: false, reason: 'contact_not_in_audience' }
    return { removed: false, reason: `resend_${res.status}` }
  } catch (err) {
    return { removed: false, reason: 'network_error', error: err.message }
  }
}

/**
 * Build the unsubscribe + delete-account footer for alert emails.
 * Uses APP_URL env for the base so the same code works on Railway URL today
 * and on a custom domain when configured. Spec calls for insights.ebenova.dev
 * — that's the future canonical, not the current Railway URL. Env-driven
 * here so we don't ship a hardcoded link to the wrong host.
 *
 * @param {string} token  monitor.unsubscribeToken
 * @returns {string} HTML fragment ready to drop into an email body
 */
export function buildEmailFooter(token) {
  const appUrl = process.env.APP_URL || 'https://ebenova-insights-production.up.railway.app'
  if (!token) {
    // Backwards-compat: a monitor created before this feature shipped may
    // not have a token. Show a generic footer so we still pass CASL/CAN-SPAM.
    return `<div style="text-align:center;padding:16px;font-size:11px;color:#666;line-height:1.7;">
      To stop these alerts, sign in to your dashboard and pause email notifications.<br>
      Ebenova Insights · monitor your buying signals · Built in Canada · Compliant with CASL &amp; NDPR
    </div>`
  }
  const unsubUrl  = `${appUrl}/unsubscribe?token=${encodeURIComponent(token)}`
  const deleteUrl = `${appUrl}/delete-account?token=${encodeURIComponent(token)}`
  return `<div style="text-align:center;padding:16px;font-size:11px;color:#666;line-height:1.7;">
    <a href="${unsubUrl}" style="color:#666;">Unsubscribe from these alerts</a>
    &nbsp;·&nbsp;
    <a href="${deleteUrl}" style="color:#c0392b;">Delete my account</a>
    <br>
    Ebenova Insights · monitor your buying signals · Built in Canada · Compliant with CASL &amp; NDPR
  </div>`
}
