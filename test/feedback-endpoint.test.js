import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'

// We extract the handler logic into a testable factory. The actual api-server.js
// uses the same pattern — owner check before any match write.

function makeFeedbackHandler(redis) {
  return async (req, res) => {
    const auth = req.headers['authorization']?.slice(7) || ''
    const apiKeyData = await redis.get(`apikey:${auth}`)
    if (!apiKeyData) return res.status(401).json({ success: false, error: { code: 'INVALID_KEY', message: 'API key not found' } })
    const owner = JSON.parse(apiKeyData).owner

    const { monitor_id, match_id, feedback } = req.body
    if (!monitor_id || !match_id || !['up','down'].includes(feedback)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'monitor_id, match_id, feedback required' } })
    }

    // OWNER CHECK
    const monitorRaw = await redis.get(`insights:monitor:${monitor_id}`)
    if (!monitorRaw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const monitor = JSON.parse(monitorRaw)
    if (monitor.owner !== owner) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    }

    const matchKey = `insights:match:${monitor_id}:${match_id}`
    const match = await redis.get(matchKey)
    if (!match) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Match not found' } })
    const matchData = JSON.parse(match)
    matchData.feedback = feedback
    await redis.set(matchKey, JSON.stringify(matchData))
    return res.json({ success: true })
  }
}

async function postFeedback(handler, { authKey, body }) {
  const req = { headers: { authorization: `Bearer ${authKey}` }, body }
  let status = 200, payload
  const res = {
    status(s) { status = s; return this },
    json(p) { payload = p; return this },
  }
  await handler(req, res)
  return { status, payload }
}

test('feedback succeeds when caller owns the monitor', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'alice', insights: true }))
  await redis.set('insights:monitor:m1', JSON.stringify({ id: 'm1', owner: 'alice' }))
  await redis.set('insights:match:m1:x', JSON.stringify({ id: 'x' }))
  const h = makeFeedbackHandler(redis)
  const r = await postFeedback(h, { authKey: 'KEY_A', body: { monitor_id: 'm1', match_id: 'x', feedback: 'up' } })
  assert.equal(r.status, 200)
  assert.equal(r.payload.success, true)
  const stored = JSON.parse(await redis.get('insights:match:m1:x'))
  assert.equal(stored.feedback, 'up')
})

test('feedback returns 404 when caller does not own the monitor', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'alice', insights: true }))
  await redis.set('apikey:KEY_B', JSON.stringify({ owner: 'bob',   insights: true }))
  await redis.set('insights:monitor:m1', JSON.stringify({ id: 'm1', owner: 'alice' }))
  await redis.set('insights:match:m1:x', JSON.stringify({ id: 'x' }))
  const h = makeFeedbackHandler(redis)
  const r = await postFeedback(h, { authKey: 'KEY_B', body: { monitor_id: 'm1', match_id: 'x', feedback: 'up' } })
  assert.equal(r.status, 404)
  // Match must NOT have been modified
  const stored = JSON.parse(await redis.get('insights:match:m1:x'))
  assert.equal(stored.feedback, undefined)
})

test('feedback returns 401 when API key is unknown', async () => {
  const redis = createMockRedis()
  const h = makeFeedbackHandler(redis)
  const r = await postFeedback(h, { authKey: 'UNKNOWN', body: { monitor_id: 'm1', match_id: 'x', feedback: 'up' } })
  assert.equal(r.status, 401)
})
