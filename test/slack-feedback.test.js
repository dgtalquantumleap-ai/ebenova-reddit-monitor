import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { sendFeedbackToSlack } from '../lib/slack-feedback.js'

test('returns delivered:false when SLACK_FEEDBACK_WEBHOOK_URL is missing', async () => {
  delete process.env.SLACK_FEEDBACK_WEBHOOK_URL
  const r = await sendFeedbackToSlack({ email: 'a@x.com', plan: 'growth', npsScore: 9, category: 'praise', message: 'love it' })
  assert.equal(r.delivered, false)
  assert.equal(r.reason, 'no_webhook')
})

test('posts a Slack-formatted payload when webhook configured', async () => {
  process.env.SLACK_FEEDBACK_WEBHOOK_URL = 'https://hooks.slack.com/test'
  let captured
  const originalFetch = global.fetch
  global.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) }
    return { ok: true, status: 200 }
  }
  try {
    const r = await sendFeedbackToSlack({ email: 'a@x.com', plan: 'growth', npsScore: 9, category: 'praise', message: 'love it' })
    assert.equal(r.delivered, true)
    assert.equal(captured.url, 'https://hooks.slack.com/test')
    const serialized = JSON.stringify(captured.body)
    assert.ok(serialized.includes('a@x.com'))
    assert.ok(serialized.includes('growth'))
    assert.ok(serialized.includes('9'))
    assert.ok(serialized.includes('love it'))
  } finally {
    global.fetch = originalFetch
    delete process.env.SLACK_FEEDBACK_WEBHOOK_URL
  }
})

test('returns delivered:false when Slack returns non-2xx', async () => {
  process.env.SLACK_FEEDBACK_WEBHOOK_URL = 'https://hooks.slack.com/test'
  const originalFetch = global.fetch
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' })
  try {
    const r = await sendFeedbackToSlack({ email: 'a@x.com', plan: 'starter', npsScore: 0, category: 'bug', message: 'broken' })
    assert.equal(r.delivered, false)
    assert.equal(r.reason, 'slack_error')
  } finally {
    global.fetch = originalFetch
    delete process.env.SLACK_FEEDBACK_WEBHOOK_URL
  }
})

test('returns delivered:false on fetch throw without crashing', async () => {
  process.env.SLACK_FEEDBACK_WEBHOOK_URL = 'https://hooks.slack.com/test'
  const originalFetch = global.fetch
  global.fetch = async () => { throw new Error('network down') }
  try {
    const r = await sendFeedbackToSlack({ email: 'a@x.com', plan: 'starter', npsScore: 5, category: 'idea', message: 'hi' })
    assert.equal(r.delivered, false)
    assert.equal(r.reason, 'network_error')
  } finally {
    global.fetch = originalFetch
    delete process.env.SLACK_FEEDBACK_WEBHOOK_URL
  }
})
