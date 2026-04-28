import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { escapeHtml } from '../lib/html-escape.js'

test('escapes the five HTML-significant characters', () => {
  assert.equal(escapeHtml('&'), '&amp;')
  assert.equal(escapeHtml('<'), '&lt;')
  assert.equal(escapeHtml('>'), '&gt;')
  assert.equal(escapeHtml('"'), '&quot;')
  assert.equal(escapeHtml("'"), '&#39;')
})

test('escapes a script-tag payload', () => {
  assert.equal(
    escapeHtml('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;'
  )
})

test('escapes an attribute-injection payload', () => {
  assert.equal(
    escapeHtml('"><img onerror=fetch(1)>'),
    '&quot;&gt;&lt;img onerror=fetch(1)&gt;'
  )
})

test('returns empty string for null and undefined', () => {
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(undefined), '')
})

test('coerces numbers to strings', () => {
  assert.equal(escapeHtml(42), '42')
})

test('escapes ampersand exactly once (not idempotent — caller must not double-escape)', () => {
  assert.equal(escapeHtml('a & b'), 'a &amp; b')
  assert.equal(escapeHtml(escapeHtml('&')), '&amp;amp;')
})
