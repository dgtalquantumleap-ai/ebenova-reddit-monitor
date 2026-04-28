// lib/slack.js — Slack Block Kit alert for match digests

// Slack mrkdwn requires &<> escaping (same as HTML). Apply to every interpolated
// user-derived value: title, body, draft, author, subreddit. Without this, a
// post containing < or > in the title breaks the mrkdwn rendering and can be
// used to spoof links.
const slackEscape = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export async function sendSlackAlert(webhookUrl, matches) {
  if (!webhookUrl || !matches.length) return

  const top = matches.slice(0, 5)

  const blocks = top.flatMap(m => {
    const sourceLabel =
      m.source === 'hackernews' ? 'HN'
      : m.source === 'medium'   ? '📰 Medium'
      : m.source === 'substack' ? '📧 Substack'
      : m.source === 'quora'    ? '💬 Quora'
      : m.source === 'upwork'   ? '💼 Upwork Community'
      : m.source === 'fiverr'   ? '🟢 Fiverr Community'
      : `r/${slackEscape(m.subreddit)}`

    const safeTitle = slackEscape(m.title || '')
    const safeAuthor = slackEscape(m.author || 'unknown')
    const safeBody = slackEscape((m.body || '').slice(0, 200))
    const bodyTrunc = (m.body || '').length > 200 ? '…' : ''

    const items = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${safeTitle}*\n${sourceLabel} · ${safeAuthor} · ${m.score || 0} pts\n${safeBody}${bodyTrunc}`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Open thread' },
          url: m.url,
        },
      },
    ]

    if (m.draft) {
      const safeDraft = slackEscape(m.draft.slice(0, 300).replace(/\n/g, ' '))
      // Tag the draft with which model wrote it. Useful for A/B comparing
      // Groq vs Deepseek during the demo period.
      const modelTag = m.draftedBy ? ` \`[${slackEscape(m.draftedBy)}]\`` : ''
      items.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `✏️ _${safeDraft}_${modelTag}` }],
      })
    }

    if (m.priority_score >= 8) {
      items.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '🔥 *HIGH PRIORITY*' }],
      })
    }

    items.push({ type: 'divider' })
    return items
  })

  const payload = {
    text: `📡 ${matches.length} new lead${matches.length !== 1 ? 's' : ''} found`,
    blocks,
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const body = await res.text()
      console.warn(`[slack] Webhook returned ${res.status}: ${body}`)
    }
  } catch (err) {
    console.error('[slack] Failed to send alert:', err.message)
  }
}
