import { test } from 'node:test'
import { strict as assert } from 'node:assert'

// We test the env→ms conversion as a pure function. The actual application
// in monitor-v2.js uses the same logic.

function ageMsFromEnv(envValue, defaultHours = 3) {
  const hours = parseInt(envValue || String(defaultHours))
  if (!Number.isFinite(hours) || hours <= 0) return defaultHours * 60 * 60 * 1000
  return hours * 60 * 60 * 1000
}

test('default 3 hours when env unset', () => {
  assert.equal(ageMsFromEnv(undefined), 3 * 60 * 60 * 1000)
})

test('respects POST_MAX_AGE_HOURS=24', () => {
  assert.equal(ageMsFromEnv('24'), 24 * 60 * 60 * 1000)
})

test('falls back to default on garbage env', () => {
  assert.equal(ageMsFromEnv('not-a-number'), 3 * 60 * 60 * 1000)
})

test('falls back to default on zero or negative', () => {
  assert.equal(ageMsFromEnv('0'), 3 * 60 * 60 * 1000)
  assert.equal(ageMsFromEnv('-5'), 3 * 60 * 60 * 1000)
})
