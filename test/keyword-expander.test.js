import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { _internals } from '../lib/keyword-expander.js'

const { _parseExpanded } = _internals

test('_parseExpanded handles plain JSON array', () => {
  const r = _parseExpanded('["freelance tools","invoice software","contract management"]')
  assert.deepEqual(r, ['freelance tools', 'invoice software', 'contract management'])
})

test('_parseExpanded handles JSON in markdown fence', () => {
  const r = _parseExpanded('```json\n["keyword one","keyword two"]\n```')
  assert.deepEqual(r, ['keyword one', 'keyword two'])
})

test('_parseExpanded returns [] for non-array JSON', () => {
  assert.deepEqual(_parseExpanded('{"key":"val"}'), [])
})

test('_parseExpanded returns [] for empty/null input', () => {
  assert.deepEqual(_parseExpanded(''), [])
  assert.deepEqual(_parseExpanded(null), [])
})

test('_parseExpanded filters non-string elements', () => {
  const r = _parseExpanded('["valid", 123, null, "also valid"]')
  assert.deepEqual(r, ['valid', 'also valid'])
})
