import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { suggestSubreddits, _internals } from '../lib/subreddit-suggester.js'

const { _parseSuggested } = _internals

test('_parseSuggested handles plain JSON array', () => {
  const result = _parseSuggested('["SaaS","smallbusiness","Entrepreneur"]')
  assert.deepEqual(result, ['saas', 'smallbusiness', 'entrepreneur'])
})

test('_parseSuggested strips r/ prefix', () => {
  const result = _parseSuggested('["r/SaaS","r/Freelance","Entrepreneur"]')
  assert.deepEqual(result, ['saas', 'freelance', 'entrepreneur'])
})

test('_parseSuggested handles fenced code block', () => {
  const text = '```json\n["SaaS","smallbusiness"]\n```'
  assert.deepEqual(_parseSuggested(text), ['saas', 'smallbusiness'])
})

test('_parseSuggested returns [] for malformed input', () => {
  assert.deepEqual(_parseSuggested('not json at all'), [])
  assert.deepEqual(_parseSuggested(''), [])
  assert.deepEqual(_parseSuggested(null), [])
})

test('_parseSuggested caps at 10 results', () => {
  const arr = Array.from({ length: 15 }, (_, i) => `sub${i}`)
  const result = _parseSuggested(JSON.stringify(arr))
  assert.equal(result.length, 10)
})

test('suggestSubreddits returns [] when no context or keywords', async () => {
  const result = await suggestSubreddits('', [])
  assert.deepEqual(result, [])
})
