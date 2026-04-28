import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { validateInvite } from '../lib/invite.js'

test('returns valid when code matches DEMO_INVITE_CODE env', () => {
  process.env.DEMO_INVITE_CODE = 'DEMO2026'
  const r = validateInvite('DEMO2026')
  assert.equal(r.valid, true)
  assert.equal(r.plan, 'growth')
  assert.equal(r.durationDays, 30)
  assert.equal(r.source, 'demo-invite')
  delete process.env.DEMO_INVITE_CODE
})

test('returns invalid when code does not match', () => {
  process.env.DEMO_INVITE_CODE = 'DEMO2026'
  const r = validateInvite('WRONG')
  assert.equal(r.valid, false)
  delete process.env.DEMO_INVITE_CODE
})

test('returns invalid when code is empty or missing', () => {
  process.env.DEMO_INVITE_CODE = 'DEMO2026'
  assert.equal(validateInvite('').valid, false)
  assert.equal(validateInvite(undefined).valid, false)
  assert.equal(validateInvite(null).valid, false)
  delete process.env.DEMO_INVITE_CODE
})

test('returns invalid when env not set, even if code provided', () => {
  delete process.env.DEMO_INVITE_CODE
  assert.equal(validateInvite('DEMO2026').valid, false)
})

test('comparison is case-sensitive and trims whitespace', () => {
  process.env.DEMO_INVITE_CODE = 'DEMO2026'
  assert.equal(validateInvite('demo2026').valid, false)
  assert.equal(validateInvite('  DEMO2026  ').valid, true)
  delete process.env.DEMO_INVITE_CODE
})
