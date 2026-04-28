// lib/invite.js — Invite-code validation for demo signups.
// Currently supports one invite type (DEMO_INVITE_CODE → growth comp for 30 days).
// Designed to expand: future codes (referral, partner, beta) live here, not in signup.

export function validateInvite(code) {
  const expected = process.env.DEMO_INVITE_CODE
  if (!expected) return { valid: false }
  if (typeof code !== 'string') return { valid: false }
  const trimmed = code.trim()
  if (trimmed !== expected) return { valid: false }
  return {
    valid: true,
    plan: 'growth',
    durationDays: 30,
    source: 'demo-invite',
  }
}

const PAID_STATUSES = new Set(['active', 'trialing', 'past_due'])

export function applyInviteToUser(user, code) {
  const validation = validateInvite(code)
  if (!validation.valid) return user
  if (user?.stripeSubscriptionId && PAID_STATUSES.has(user.subscriptionStatus)) {
    return user
  }
  const expiresAt = new Date(Date.now() + validation.durationDays * 24 * 60 * 60 * 1000).toISOString()
  return {
    ...user,
    insightsPlan: validation.plan,
    compOriginalPlan: user.compOriginalPlan || user.insightsPlan || 'starter',
    compExpiresAt: expiresAt,
    source: validation.source,
  }
}
