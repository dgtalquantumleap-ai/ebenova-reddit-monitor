// lib/slack.js — Slack Block Kit alert for match digests

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
      : `r/${m.subreddit}`

    const items = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${(m.title || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}*\n${sourceLabel} · ${m.author || 'unknown'} · ${m.score || 0} pts\n${(m.body || '').slice(0, 200)}${(m.body || '').length > 200 ? '…' : ''}`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Open thread' },
          url: m.url,
        },
      },
    ]

    if (m.draft) {
      items.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `✏️ _${m.draft.slice(0, 300).replace(/\n/g, ' ')}_` }],
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
