import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { applyInviteToUser } from '../lib/invite.js'

test('applyInviteToUser upgrades starter to growth comp', () => {
  process.env.DEMO_INVITE_CODE = 'DEMO2026'
  const baseUser = { owner: 'a@x.com', email: 'a@x.com', insightsPlan: 'starter', createdAt: '2026-04-28T00:00:00Z', source: 'self-signup' }
  const upgraded = applyInviteToUser(baseUser, 'DEMO2026')
  assert.equal(upgraded.insightsPlan, 'growth')
  assert.equal(upgraded.compOriginalPlan, 'starter')
  assert.equal(upgraded.source, 'demo-invite')
  assert.ok(upgraded.compExpiresAt)
  const expiry = new Date(upgraded.compExpiresAt).getTime()
  const expected = Date.now() + 30 * 24 * 60 * 60 * 1000
  assert.ok(Math.abs(expiry - expected) < 5000)
  delete process.env.DEMO_INVITE_CODE
})

test('applyInviteToUser is no-op when invite invalid', () => {
  process.env.DEMO_INVITE_CODE = 'DEMO2026'
  const baseUser = { owner: 'a@x.com', email: 'a@x.com', insightsPlan: 'starter', source: 'self-signup' }
  const r = applyInviteToUser(baseUser, 'WRONG')
  assert.equal(r.insightsPlan, 'starter')
  assert.equal(r.source, 'self-signup')
  assert.equal(r.compExpiresAt, undefined)
  delete process.env.DEMO_INVITE_CODE
})

test('applyInviteToUser preserves paid Stripe subscription', () => {
  process.env.DEMO_INVITE_CODE = 'DEMO2026'
  const paidUser = { owner: 'a@x.com', insightsPlan: 'growth', stripeSubscriptionId: 'sub_123', subscriptionStatus: 'active' }
  const r = applyInviteToUser(paidUser, 'DEMO2026')
  assert.equal(r.insightsPlan, 'growth')
  assert.equal(r.compExpiresAt, undefined)
  assert.equal(r.stripeSubscriptionId, 'sub_123')
  delete process.env.DEMO_INVITE_CODE
})

test('applyInviteToUser re-applies comp to existing demo-invite user', () => {
  process.env.DEMO_INVITE_CODE = 'DEMO2026'
  const oldComp = { owner: 'a@x.com', insightsPlan: 'growth', source: 'demo-invite', compExpiresAt: '2026-05-01T00:00:00Z', compOriginalPlan: 'starter' }
  const r = applyInviteToUser(oldComp, 'DEMO2026')
  assert.equal(r.insightsPlan, 'growth')
  assert.ok(new Date(r.compExpiresAt).getTime() > new Date('2026-05-01').getTime())
  delete process.env.DEMO_INVITE_CODE
})

test('applyInviteToUser is no-op when env not set', () => {
  delete process.env.DEMO_INVITE_CODE
  const baseUser = { owner: 'a@x.com', insightsPlan: 'starter', source: 'self-signup' }
  const r = applyInviteToUser(baseUser, 'DEMO2026')
  assert.equal(r.insightsPlan, 'starter')
  assert.equal(r.compExpiresAt, undefined)
})
