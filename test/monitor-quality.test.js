import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { validateMonitorQuality } from '../lib/monitor-quality.js'

// ── rejects the real production garbage ──────────────────────────────────────

test('rejects single generic-token keyword + vague context ("Youth" / "I advocate")', () => {
  const r = validateMonitorQuality({ keywords: [{ keyword: 'Youth' }], productContext: 'I advocate' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.code === 'KEYWORDS_TOO_GENERIC'))
  assert.ok(r.errors.some(e => e.code === 'NO_DOMAIN_ANCHOR'))
})

test('rejects a single broad word with no context', () => {
  assert.equal(validateMonitorQuality({ keywords: ['marketing'], productContext: '' }).ok, false)
})

// ── passes real, well-formed monitors ────────────────────────────────────────

test('passes a monitor with specific multi-word keywords (no productContext)', () => {
  const r = validateMonitorQuality({
    keywords: ['logistics software recommendation', 'looking for a logistics platform', 'freight tracking solution'],
    productContext: '',
  })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
})

test('passes a monitor with real product context', () => {
  const r = validateMonitorQuality({
    keywords: ['validate my business idea', 'MVP validation'],
    productContext: 'We help entrepreneurs validate business ideas before investing time or money.',
  })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
})

// ── edge cases ───────────────────────────────────────────────────────────────

test('passes a single specific (non-generic) keyword if it carries enough context', () => {
  const r = validateMonitorQuality({
    keywords: ['Kubernetes autoscaling help'],
    productContext: 'We sell a Kubernetes cost-optimization tool for platform teams.',
  })
  assert.equal(r.ok, true)
})

test('a descriptive monitor name provides the domain anchor (no false reject)', () => {
  // Real case: user put their pitch in the name field, thin productContext.
  const r = validateMonitorQuality({
    keywords: ['housing deficit solutions'],
    productContext: '',
    name: 'SouthSwift a real estate marketplace solving the housing deficit',
  })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
})

test('a descriptive name does NOT rescue a single generic-token keyword (Rule 1 still fires)', () => {
  const r = validateMonitorQuality({
    keywords: ['Youth'],
    productContext: 'I advocate',
    name: 'Corpers journey advocacy network',
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.code === 'KEYWORDS_TOO_GENERIC'))
})

test('builder_tracker mode bypasses quality checks (uses hardcoded keywords)', () => {
  const r = validateMonitorQuality({ keywords: [], productContext: '', mode: 'builder_tracker' })
  assert.equal(r.ok, true)
})

test('object-shaped and string-shaped keywords both handled', () => {
  const a = validateMonitorQuality({ keywords: [{ keyword: 'looking for a CRM' }], productContext: 'small B2B sales teams' })
  const b = validateMonitorQuality({ keywords: ['looking for a CRM'], productContext: 'small B2B sales teams' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
})
