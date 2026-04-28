// lib/slack-feedback.js — Posts demo feedback to a dedicated Slack channel.
// Best-effort: never throws. Returns { delivered, reason }.

const NPS_EMOJI = (score) => score >= 9 ? '🟢' : score >= 7 ? '🟡' : '🔴'
const CATEGORY_EMOJI = {
  bug: '🐛',
  idea: '💡',
  praise: '🎉',
  pricing: '💰',
  other: '💬',
}

export async function sendFeedbackToSlack({ email, plan, npsScore, category, message }) {
  const webhook = process.env.SLACK_FEEDBACK_WEBHOOK_URL
  if (!webhook) return { delivered: false, reason: 'no_webhook' }

  const npsLabel = npsScore >= 9 ? 'Promoter' : npsScore >= 7 ? 'Passive' : 'Detractor'
  const catEmoji = CATEGORY_EMOJI[category] || '💬'
  const npsEmoji = NPS_EMOJI(npsScore)
  const safeMsg = String(message || '').slice(0, 1500).replace(/\n/g, '\n> ')

  const payload = {
    text: `${catEmoji} New feedback from ${email}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${catEmoji} ${(category || 'other').toUpperCase()} — ${email}` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Plan:*\n${plan || 'unknown'}` },
          { type: 'mrkdwn', text: `*NPS:*\n${npsEmoji} ${npsScore}/10 (${npsLabel})` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Message:*\n> ${safeMsg}` },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Submitted ${new Date().toISOString()}` }],
      },
    ],
  }

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return { delivered: false, reason: 'slack_error', status: res.status }
    return { delivered: true }
  } catch (err) {
    return { delivered: false, reason: 'network_error', error: err.message }
  }
}
