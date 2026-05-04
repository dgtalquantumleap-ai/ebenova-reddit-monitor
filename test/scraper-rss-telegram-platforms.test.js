import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { VALID_PLATFORMS, PLATFORM_LABELS, PLATFORM_EMOJIS, validatePlatforms } from '../lib/platforms.js'

test('platforms: VALID_PLATFORMS includes rss', () => {
  assert.ok(VALID_PLATFORMS.includes('rss'))
})

test('platforms: VALID_PLATFORMS includes telegram', () => {
  assert.ok(VALID_PLATFORMS.includes('telegram'))
})

test('platforms: PLATFORM_LABELS has entry for rss', () => {
  assert.equal(typeof PLATFORM_LABELS.rss, 'string')
  assert.ok(PLATFORM_LABELS.rss.length > 0)
})

test('platforms: PLATFORM_LABELS has entry for telegram', () => {
  assert.equal(typeof PLATFORM_LABELS.telegram, 'string')
  assert.ok(PLATFORM_LABELS.telegram.length > 0)
})

test('platforms: validatePlatforms accepts rss and telegram', () => {
  assert.equal(validatePlatforms(['rss']).ok, true)
  assert.equal(validatePlatforms(['telegram']).ok, true)
  assert.equal(validatePlatforms(['reddit', 'rss', 'telegram']).ok, true)
})
