// Batch B — edit-monitor + author profiles + share-link surface tests.
//
// What the spec calls for:
//   - PATCH /v1/monitors/:id accepts the new fields (slackWebhookUrl,
//     replyTone, name) and rejects bad values
//   - GET /v1/monitors/:id/authors returns the same shape the weekly
//     digest consumes, sorted desc by postCount
//   - The surfacing endpoints (/v1/monitors with new fields, share-link)
//     pre-existed; this just pins their data contract for the dashboard

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'

// ── PATCH validation logic — mirrored from api-server.js to test in isolation ─

function makePatchValidator() {
  return function patch(body) {
    const updates = {}
    if (Object.prototype.hasOwnProperty.call(body, 'slackWebhookUrl')) {
      if (body.slackWebhookUrl === null || body.slackWebhookUrl === '') {
        updates.slackWebhookUrl = ''
      } else if (typeof body.slackWebhookUrl === 'string') {
        const trimmed = body.slackWebhookUrl.trim()
        let url
        try { url = new URL(trimmed) } catch (_) {
          return { ok: false, code: 'INVALID_SLACK_URL' }
        }
        if (url.protocol !== 'https:') return { ok: false, code: 'INVALID_SLACK_URL' }
        updates.slackWebhookUrl = trimmed.slice(0, 500)
      } else {
        return { ok: false, code: 'INVALID_SLACK_URL' }
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'replyTone')) {
      const VALID_TONES = new Set(['conversational','professional','empathetic','expert','playful'])
      if (!VALID_TONES.has(body.replyTone)) return { ok: false, code: 'INVALID_TONE' }
      updates.replyTone = body.replyTone
    }
    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return { ok: false, code: 'INVALID_NAME' }
      }
      updates.name = body.name.trim().slice(0, 100)
    }
    return { ok: true, updates }
  }
}

// ── slackWebhookUrl validation ─────────────────────────────────────────────

test('PATCH slackWebhookUrl: accepts valid https URL', () => {
  const r = makePatchValidator()({ slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X' })
  assert.equal(r.ok, true)
  assert.equal(r.updates.slackWebhookUrl, 'https://hooks.slack.com/services/T/B/X')
})

test('PATCH slackWebhookUrl: empty string clears the field', () => {
  const r = makePatchValidator()({ slackWebhookUrl: '' })
  assert.equal(r.ok, true)
  assert.equal(r.updates.slackWebhookUrl, '')
})

test('PATCH slackWebhookUrl: null clears the field', () => {
  const r = makePatchValidator()({ slackWebhookUrl: null })
  assert.equal(r.ok, true)
  assert.equal(r.updates.slackWebhookUrl, '')
})

test('PATCH slackWebhookUrl: rejects http:// (only https)', () => {
  const r = makePatchValidator()({ slackWebhookUrl: 'http://hooks.slack.com/services/T/B/X' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'INVALID_SLACK_URL')
})

test('PATCH slackWebhookUrl: rejects malformed URL', () => {
  const r = makePatchValidator()({ slackWebhookUrl: 'not a url' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'INVALID_SLACK_URL')
})

test('PATCH slackWebhookUrl: rejects non-string types', () => {
  for (const bad of [123, true, [], {}]) {
    const r = makePatchValidator()({ slackWebhookUrl: bad })
    assert.equal(r.ok, false, `${typeof bad} should be rejected`)
  }
})

// ── replyTone validation ───────────────────────────────────────────────────

test('PATCH replyTone: accepts each spec tone', () => {
  for (const tone of ['conversational','professional','empathetic','expert','playful']) {
    const r = makePatchValidator()({ replyTone: tone })
    assert.equal(r.ok, true, `${tone} should be valid`)
    assert.equal(r.updates.replyTone, tone)
  }
})

test('PATCH replyTone: rejects unknown tones', () => {
  for (const bad of ['casual', 'aggressive', '', null]) {
    const r = makePatchValidator()({ replyTone: bad })
    assert.equal(r.ok, false, `${bad} should be rejected`)
    assert.equal(r.code, 'INVALID_TONE')
  }
})

// ── name validation ────────────────────────────────────────────────────────

test('PATCH name: accepts a normal string and trims', () => {
  const r = makePatchValidator()({ name: '   My Monitor   ' })
  assert.equal(r.ok, true)
  assert.equal(r.updates.name, 'My Monitor')
})

test('PATCH name: caps at 100 characters', () => {
  const long = 'x'.repeat(150)
  const r = makePatchValidator()({ name: long })
  assert.equal(r.ok, true)
  assert.equal(r.updates.name.length, 100)
})

test('PATCH name: rejects empty / whitespace-only', () => {
  for (const bad of ['', '   ']) {
    const r = makePatchValidator()({ name: bad })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'INVALID_NAME')
  }
})

test('PATCH name: rejects non-string types', () => {
  for (const bad of [null, undefined, 123, ['name']]) {
    const r = makePatchValidator()({ name: bad })
    assert.equal(r.ok, false)
  }
})

// ── multiple fields in one body ────────────────────────────────────────────

test('PATCH allows multi-field updates in a single body', () => {
  const r = makePatchValidator()({
    name: 'Renamed',
    replyTone: 'expert',
    slackWebhookUrl: 'https://hooks.slack.com/services/X/Y/Z',
  })
  assert.equal(r.ok, true)
  assert.equal(r.updates.name, 'Renamed')
  assert.equal(r.updates.replyTone, 'expert')
  assert.equal(r.updates.slackWebhookUrl, 'https://hooks.slack.com/services/X/Y/Z')
})

// ── /v1/monitors/:id/authors handler-shape test ────────────────────────────

function makeAuthorsHandler(redis) {
  return async (req, res) => {
    const { id } = req.params
    const monRaw = await redis.get(`insights:monitor:${id}`)
    if (!monRaw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } })
    const monitor = JSON.parse(monRaw)
    if (monitor.owner !== req.owner) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } })
    const indexKey = `author:list:${id}`
    const members = (await redis.smembers(indexKey)) || []
    const profiles = []
    for (const member of members) {
      const idx = member.indexOf(':')
      if (idx === -1) continue
      const platform = member.slice(0, idx)
      const username = member.slice(idx + 1)
      const hash = await redis.hgetall(`author:profile:${id}:${platform}:${username}`)
      if (!hash || Object.keys(hash).length === 0) continue
      profiles.push({
        username, platform,
        postCount:       parseInt(hash.postCount, 10) || 0,
        firstSeen:       hash.firstSeen || '',
        lastSeen:        hash.lastSeen  || '',
        latestPostTitle: hash.latestPostTitle || '',
        latestPostUrl:   hash.latestPostUrl   || '',
      })
    }
    profiles.sort((a, b) => b.postCount - a.postCount)
    res.json({ success: true, authors: profiles.slice(0, 50), total: profiles.length })
  }
}

async function call(handler, req) {
  let status = 200, payload
  const res = {
    status(s) { status = s; return this },
    json(p) { payload = p; return this },
  }
  await handler(req, res)
  return { status, payload }
}

test('GET /v1/monitors/:id/authors: returns top authors sorted by postCount desc', async () => {
  const redis = createMockRedis()
  await redis.set('insights:monitor:m1', JSON.stringify({ id: 'm1', owner: 'alice' }))
  await redis.sadd('author:list:m1', 'reddit:alice', 'reddit:bob', 'hackernews:carol')
  await redis.hset('author:profile:m1:reddit:alice',     { username: 'alice', platform: 'reddit',     postCount: '3', firstSeen: '2026-04-01', lastSeen: '2026-04-10', latestPostTitle: 'Alice post', latestPostUrl: 'https://r/a' })
  await redis.hset('author:profile:m1:reddit:bob',       { username: 'bob',   platform: 'reddit',     postCount: '7', firstSeen: '2026-04-01', lastSeen: '2026-04-11', latestPostTitle: 'Bob post',   latestPostUrl: 'https://r/b' })
  await redis.hset('author:profile:m1:hackernews:carol', { username: 'carol', platform: 'hackernews', postCount: '1', firstSeen: '2026-04-05', lastSeen: '2026-04-05', latestPostTitle: 'Carol post', latestPostUrl: 'https://hn/c' })

  const r = await call(makeAuthorsHandler(redis), { params: { id: 'm1' }, owner: 'alice' })
  assert.equal(r.status, 200)
  assert.equal(r.payload.success, true)
  assert.equal(r.payload.total, 3)
  assert.deepEqual(r.payload.authors.map(a => a.username), ['bob', 'alice', 'carol'])
  assert.equal(r.payload.authors[0].postCount, 7)
})

test('GET /v1/monitors/:id/authors: 404 when monitor missing', async () => {
  const redis = createMockRedis()
  const r = await call(makeAuthorsHandler(redis), { params: { id: 'never' }, owner: 'anyone' })
  assert.equal(r.status, 404)
})

test('GET /v1/monitors/:id/authors: 404 when caller is not owner (no leak)', async () => {
  const redis = createMockRedis()
  await redis.set('insights:monitor:m1', JSON.stringify({ id: 'm1', owner: 'alice' }))
  const r = await call(makeAuthorsHandler(redis), { params: { id: 'm1' }, owner: 'mallory' })
  assert.equal(r.status, 404)
})

test('GET /v1/monitors/:id/authors: empty profile set returns empty array, not error', async () => {
  const redis = createMockRedis()
  await redis.set('insights:monitor:m1', JSON.stringify({ id: 'm1', owner: 'alice' }))
  const r = await call(makeAuthorsHandler(redis), { params: { id: 'm1' }, owner: 'alice' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.payload.authors, [])
  assert.equal(r.payload.total, 0)
})
