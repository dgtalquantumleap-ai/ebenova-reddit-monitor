import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { verifyCaptcha } from '../lib/captcha.js'

test('skips silently when HCAPTCHA_SECRET_KEY unset', async () => {
  delete process.env.HCAPTCHA_SECRET_KEY
  const r = await verifyCaptcha('any-token')
  assert.equal(r.ok, true)
  assert.equal(r.skipped, true)
})

test('rejects empty token when secret IS set', async () => {
  process.env.HCAPTCHA_SECRET_KEY = 'fake-secret'
  const r = await verifyCaptcha('')
  assert.equal(r.ok, false)
  delete process.env.HCAPTCHA_SECRET_KEY
})
