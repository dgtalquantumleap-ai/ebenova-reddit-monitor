import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Execute the actual worker function without importing its scheduling entrypoint.
const worker = readFileSync(new URL('../monitor-v2.js', import.meta.url), 'utf8')
const start = worker.indexOf('async function sendMonitorAlert(')
const end = worker.indexOf('// ── Run a single monitor', start)
assert.ok(start > 0 && end > start)
const source = worker.slice(start, end)

async function deliver(result, { disabled = false, throws = false } = {}) {
  const logs = [], errors = [], writes = [], sends = []
  const monitor = { id: 'synthetic-monitor', owner: 'owner@example.test',
    alertEmail: 'owner@example.test', unsubscribeToken: 'synthetic', emailEnabled: !disabled }
  const sandbox = {
    console: { log: (...args) => logs.push(args.join(' ')), warn: () => {}, error: (...args) => errors.push(args.join(' ')) },
    redis: { get: async () => JSON.stringify(monitor), set: async (...args) => writes.push(args) },
    resend: { emails: { send: async (...args) => { sends.push(args); if (throws) throw Error('transport failed'); return result } } },
    getResendCap: () => null, buildAlertEmail: () => '<p>Synthetic alert</p>',
    buildBulkEmailExtras: () => ({}), FROM_EMAIL: 'test@example.test',
    process: { env: { APP_URL: 'https://example.test' } },
  }
  vm.createContext(sandbox)
  vm.runInContext(`${source}\nthis.send = sendMonitorAlert`, sandbox)
  await sandbox.send(monitor, [{ keyword: 'synthetic', source: 'fixture' }])
  return { logs, errors, writes, sends }
}

test('worker must not stamp or log delivery when Resend resolves with an error', async () => {
  const r = await deliver({ data: null, error: { name: 'validation_error', message: 'refused' } })
  assert.equal(r.writes.length, 0)
  assert.equal(r.logs.some(x => /Alert (sent|accepted by provider)/.test(x)), false)
  assert.equal(r.errors.length, 1)
})

test('worker requires a nonempty provider receipt, not an empty resolved response', async () => {
  for (const result of [undefined, {}, { data: {} }, { data: { id: ' ' } }, { data: { id: 123 } }]) {
    const r = await deliver(result)
    assert.equal(r.writes.length, 0)
    assert.equal(r.logs.some(x => /Alert (sent|accepted by provider)/.test(x)), false)
  }
})

test('worker stamps provider acceptance only after a valid receipt', async () => {
  const r = await deliver({ data: { id: 'synthetic-receipt' }, error: null })
  assert.equal(r.sends.length, 1)
  assert.equal(r.writes.length, 1)
  assert.equal(r.logs.filter(x => x.includes('Alert accepted by provider')).length, 1)
  assert.ok(JSON.parse(r.writes[0][1]).lastEmailSentAt)
})

test('worker preserves opt-out and transport-failure behavior', async () => {
  const disabled = await deliver({ data: { id: 'unused' } }, { disabled: true })
  assert.equal(disabled.sends.length, 0)
  const failed = await deliver(null, { throws: true })
  assert.equal(failed.writes.length, 0)
})
