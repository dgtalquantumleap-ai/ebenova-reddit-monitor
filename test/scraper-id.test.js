import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { hashUrlToId } from '../lib/scrapers/_id.js'

test('produces stable 12-char hex ID', () => {
  const id = hashUrlToId('https://example.com/foo')
  assert.match(id, /^[a-f0-9]{12}$/)
})

test('same URL produces same ID', () => {
  const a = hashUrlToId('https://example.com/foo')
  const b = hashUrlToId('https://example.com/foo')
  assert.equal(a, b)
})

test('two URLs sharing 40-char prefix produce DIFFERENT IDs', () => {
  // Real bug pattern from fiverr/upwork forum URLs:
  const a = hashUrlToId('https://community.fiverr.com/forums/topic-1234567890-some-very-long-thread-title-here-001')
  const b = hashUrlToId('https://community.fiverr.com/forums/topic-1234567890-some-very-long-thread-title-here-002')
  assert.notEqual(a, b, 'must differentiate URLs that share a 40-char prefix')
})

test('prefix prepends the source name', () => {
  assert.match(hashUrlToId('https://x.com/y', 'fiverr'), /^fiverr_[a-f0-9]{12}$/)
})

test('handles empty / weird inputs without throwing', () => {
  assert.equal(typeof hashUrlToId(''), 'string')
  assert.equal(typeof hashUrlToId(null), 'string')
  assert.equal(typeof hashUrlToId(undefined), 'string')
})
