import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function sandbox(t) {
  const sandboxCwd = await mkdtemp(join(tmpdir(), 'insights-api-test-'))
  const child = fork(new URL('./helpers/monitor-api-sandbox.mjs', import.meta.url), [], {
    cwd: sandboxCwd,
    // Deliberately do not inherit provider credentials or load any real .env.
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      API_PORT: '0', UPSTASH_REDIS_REST_URL: 'https://redis.invalid',
      UPSTASH_REDIS_REST_TOKEN: 'synthetic', RESEND_API_KEY: 're_synthetic',
      GROQ_API_KEY: 'synthetic', DEEPSEEK_API_KEY: 'synthetic' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  t.after(async () => {
    if (child.exitCode === null) {
      const stopped = once(child, 'exit')
      child.kill()
      await stopped
    }
    await rm(sandboxCwd, { recursive: true, force: true })
  })
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(([code]) => { throw new Error(`API exited ${code}: ${output}`) }),
  ])
  assert.equal(ready.type, 'ready')
  let requestId = 0
  return {
    async request(path, body, key = 'owner-test', method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(`http://127.0.0.1:${ready.port}${path}`, {
        method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: response.status, body: await response.json() }
    },
    async snapshot() {
      const pending = once(child, 'message')
      child.send({ type: 'snapshot', requestId: ++requestId })
      const [message] = await pending
      return message
    },
  }
}

const payload = {
  name: 'Front Desk owner discovery', keywords: ['salon receptionist', 'missed client calls'],
  productContext: 'AI front desk for salon owners handling appointment enquiries and callback requests.',
  platforms: ['reddit'],
}

test('setup-only HTTP creation saves a visible owner-scoped draft with no worker, AI or email activity', { timeout: 15000 }, async t => {
  const api = await sandbox(t)
  const created = await api.request('/v1/monitors', { ...payload, setupOnly: true, emailEnabled: true })
  assert.equal(created.status, 201)
  assert.equal(created.body.active, false)
  assert.equal(created.body.setup_only, true)
  assert.equal(created.body.email_enabled, false)
  assert.equal(created.body.next_poll_eta, null)
  const state = await api.snapshot()
  const saved = JSON.parse(state.values[`insights:monitor:${created.body.monitor_id}`])
  assert.equal(saved.active, false)
  assert.equal(saved.emailEnabled, false)
  assert.equal(saved.setupOnly, true)
  assert.deepEqual(state.sets['insights:active_monitors'] || [], [])
  assert.deepEqual(state.external, [])
  const ownList = await api.request('/v1/monitors')
  assert.equal(ownList.body.monitors.length, 1)
  assert.equal(ownList.body.monitors[0].setup_only, true)
  assert.equal(ownList.body.monitors[0].active, false)
  assert.equal((await api.request('/v1/monitors', undefined, 'other-test')).body.count, 0)
  assert.equal((await api.request(`/v1/monitors/${saved.id}`, undefined, 'other-test', 'DELETE')).status, 403)
  assert.equal((await api.request(`/v1/monitors/${saved.id}`, undefined, 'owner-test', 'DELETE')).status, 200)
  assert.equal((await api.request('/v1/monitors')).body.count, 0)
})

test('malformed setup and email flags fail before storing a monitor or contacting providers', { timeout: 15000 }, async t => {
  const api = await sandbox(t)
  for (const field of ['setupOnly', 'emailEnabled']) {
    for (const value of ['false', null, 0, {}, []]) {
      const result = await api.request('/v1/monitors', { ...payload, [field]: value })
      assert.equal(result.status, 400, `${field}=${JSON.stringify(value)}`)
      assert.equal(result.body.error.code, 'INVALID_INPUT')
    }
  }
  const state = await api.snapshot()
  assert.deepEqual(state.sets['insights:monitors:owner@example.test'] || [], [])
  assert.deepEqual(state.external, [])
})

test('setup-only records respect the plan limit and deletion frees the allowance', { timeout: 15000 }, async t => {
  const api = await sandbox(t)
  const first = await api.request('/v1/monitors', { ...payload, setupOnly: true }, 'starter-test')
  assert.equal(first.status, 201)
  assert.equal((await api.request('/v1/monitors', { ...payload, setupOnly: true }, 'starter-test')).status, 429)
  await api.request(`/v1/monitors/${first.body.monitor_id}`, undefined, 'starter-test', 'DELETE')
  assert.equal((await api.request('/v1/monitors', { ...payload, setupOnly: true }, 'starter-test')).status, 201)
  assert.deepEqual((await api.snapshot()).external, [])
})

test('legacy creation remains active and opt-out suppresses only its creation email', { timeout: 15000 }, async t => {
  const api = await sandbox(t)
  const optedOut = await api.request('/v1/monitors', { ...payload, emailEnabled: false })
  assert.equal(optedOut.status, 201)
  assert.equal(optedOut.body.active, true)
  assert.equal(optedOut.body.email_enabled, false)
  const before = await api.snapshot()
  assert.ok(before.sets['insights:active_monitors'].includes(optedOut.body.monitor_id))
  assert.ok(before.external.some(call => call.host !== 'api.resend.com'), 'legacy AI initialization remains enabled')
  assert.ok(before.external.every(call => call.host !== 'api.resend.com'))
  const legacy = await api.request('/v1/monitors', payload)
  assert.equal(legacy.status, 201)
  assert.equal(legacy.body.active, true)
  assert.equal(legacy.body.email_enabled, true)
  assert.ok((await api.snapshot()).external.some(call => call.host === 'api.resend.com'))
})
