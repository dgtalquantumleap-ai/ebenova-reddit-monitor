// lib/email-headers.js — RFC 2369 List-Unsubscribe + plain-text fallback.
//
// Why this matters: Gmail and Outlook downrank HTML-only emails without
// a List-Unsubscribe header. Spam filters look for both. The body footer
// already has an unsubscribe link (lib/account-deletion.js), but the
// HEADER is what mail clients render in the inbox UI as a one-click button.
//
// Used by every transactional + bulk email site:
//   monitor-v2.js          alert email
//   lib/weekly-digest.js   digest
//   lib/builder-tracker.js builder digest

/**
 * RFC 2369 List-Unsubscribe + RFC 8058 one-click unsubscribe headers.
 * Both mailto: and https:// targets included; mail clients prefer the
 * https one for a single-click unsubscribe button.
 *
 * @param {string} unsubscribeUrl  e.g. `${APP_URL}/unsubscribe?token=xxx`
 * @returns {Record<string, string>}
 */
export function buildEmailHeaders(unsubscribeUrl) {
  return {
    'List-Unsubscribe':       `<mailto:unsubscribe@ebenova.org>, <${unsubscribeUrl}>`,
    'List-Unsubscribe-Post':  'List-Unsubscribe=One-Click',
    'X-Mailer':               'Ebenova Insights',
  }
}

/**
 * Cheap HTML → plain text. No external dep — strips tags, decodes the
 * five most-common entities, collapses whitespace. Good enough for an
 * email plain-text fallback (the goal is "doesn't render as HTML soup
 * in clients that prefer text/plain"; not perfect Markdown).
 */
export function stripHtml(html) {
  if (!html) return ''
  return String(html)
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')   // drop <style> blocks entirely
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // drop <script> blocks entirely
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Build the full Resend-compatible payload extension for the three big
 * "marketing-style" emails: alerts, weekly digest, builder digest.
 * Returns { headers, replyTo, text } — spread these into resend.emails.send.
 *
 * @param {object} args
 * @param {string} args.html              the rendered HTML body
 * @param {string} args.unsubscribeUrl    user-specific unsub link
 * @param {string} [args.replyTo]         defaults to olumide@ebenova.net
 */
export function buildBulkEmailExtras({ html, unsubscribeUrl, replyTo = 'olumide@ebenova.net' }) {
  return {
    headers: buildEmailHeaders(unsubscribeUrl),
    replyTo,
    text: stripHtml(html),
  }
}
