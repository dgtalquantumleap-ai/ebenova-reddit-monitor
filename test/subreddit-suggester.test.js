import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { _internals } from '../lib/subreddit-suggester.js'

const { _parseSuggested } = _internals

test('_parseSuggested handles plain JSON array', () => {
  const r = _parseSuggested('["smallbusiness","Entrepreneur","Insurance"]')
  assert.deepEqual(r, ['smallbusiness', 'Entrepreneur', 'Insurance'])
})

test('_parseSuggested strips r/ prefix', () => {
  const r = _parseSuggested('["r/smallbusiness","r/Entrepreneur"]')
  assert.deepEqual(r, ['smallbusiness', 'Entrepreneur'])
})

test('_parseSuggested handles fenced JSON', () => {
  const r = _parseSuggested('```json\n["webdev","SaaS"]\n```')
  assert.deepEqual(r, ['webdev', 'SaaS'])
})

test('_parseSuggested returns [] for empty input', () => {
  assert.deepEqual(_parseSuggested(''), [])
  assert.deepEqual(_parseSuggested(null), [])
})

test('_parseSuggested limits to 10 results', () => {
  const input = '["a","b","c","d","e","f","g","h","i","j","k","l"]'
  assert.equal(_parseSuggested(input).length, 10)
})
