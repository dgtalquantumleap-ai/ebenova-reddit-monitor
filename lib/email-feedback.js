import { escapeHtml } from './html-escape.js'
import { recordEmailFeedback } from './keyword-health.js'

const MATCH_TTL    = 60 * 60 * 24 * 7   // 7 days — mirrors storeMatches TTL
const FEEDBACK_TTL = 60 * 60 * 24 * 90  // 90 days for analytics

export function makeEmailFeedbackHandler({ redis, appUrl = 'https://ebenova.org' }) {
  return async (req, res) => {
    const { match_id, monitor_id, v } = req.query || {}
    if (!match_id || !monitor_id || !['yes', 'no'].includes(v)) {
      return res.status(400).send('<p>Invalid feedback link.</p>')
    }
    try {
      const matchKey = `insights:match:${monitor_id}:${match_id}`
      const raw = await redis.get(matchKey)
      if (raw) {
        const m = typeof raw === 'string' ? JSON.parse(raw) : raw
        await redis.set(matchKey, JSON.stringify({
          ...m,
          emailFeedback: v,
          emailFeedbackAt: new Date().toISOString(),
        }))
        await redis.expire(matchKey, MATCH_TTL)
        if (m.keyword) await recordEmailFeedback(redis, monitor_id, m.keyword, v)
      }
      const fbKey = `insights:email-feedback:${monitor_id}:${match_id}`
      await redis.set(fbKey, JSON.stringify({ v, ts: new Date().toISOString() }))
      await redis.expire(fbKey, FEEDBACK_TTL)
    } catch (err) {
      console.error('[email-feedback]', err.message)
    }
    res.send(buildThanksPage(v, appUrl))
  }
}

export function buildThanksPage(v, appUrl) {
  const emoji = v === 'yes' ? '👍' : '👎'
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thanks!</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;text-align:center;color:#1a1a1a;">
  <div style="font-size:48px;margin-bottom:16px;">${emoji}</div>
  <h2 style="font-size:20px;font-weight:700;margin-bottom:8px;">Thanks for the feedback!</h2>
  <p style="font-size:14px;color:#666;line-height:1.6;">This helps us improve match quality over time.</p>
  <a href="${escapeHtml(appUrl)}" style="display:inline-block;margin-top:24px;padding:10px 24px;background:#FF6B35;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Open Dashboard →</a>
</body></html>`
}

export const _internals = { buildThanksPage, MATCH_TTL, FEEDBACK_TTL }
