import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { suggestKeywords, validateSuggestion } from '../lib/keyword-suggest.js'
import { TEMPLATES } from '../lib/templates.js'

const VALID = {
  suggestedName: 'Test Monitor',
  productContext: 'A clean version of the input text used downstream',
  keywords: [
    { keyword: 'looking for', intentType: 'buying', confidence: 'high' },
    { keyword: 'frustrated with', intentType: 'pain', confidence: 'medium' },
    { keyword: 'vs alternative', intentType: 'comparison', confidence: 'low' },
    { keyword: 'how do I', intentType: 'question', confidence: 'low' },
  ],
  subreddits: ['SaaS', 'startups'],
  platforms: ['reddit'],
}

test('validates a well-formed suggestion', () => {
  const r = validateSuggestion(VALID)
  assert.equal(r.success, true)
})

test('rejects suggestion missing keywords', () => {
  const bad = { ...VALID, keywords: [] }
  const r = validateSuggestion(bad)
  assert.equal(r.success, false)
})

test('rejects keyword with bad intentType', () => {
  const bad = { ...VALID, keywords: [{ keyword: 'x', intentType: 'invalid', confidence: 'high' }] }
  const r = validateSuggestion(bad)
  assert.equal(r.success, false)
})

test('rejects platform not in allowed set', () => {
  const bad = { ...VALID, platforms: ['twitter'] }
  const r = validateSuggestion(bad)
  assert.equal(r.success, false)
})

test('falls back to template when AI throws', async () => {
  const failingClient = { messages: { create: async () => { throw new Error('API down') } } }
  const r = await suggestKeywords({
    description: 'I sell SaaS bookkeeping software for indie agencies',
    client: failingClient,
  })
  assert.equal(r.fallback, true, 'should mark as fallback')
  assert.ok(r.keywords.length >= 4, 'fallback should have keywords')
})

test('uses AI result when valid', async () => {
  const goodClient = {
    messages: {
      create: async () => ({ content: [{ type: 'text', text: JSON.stringify(VALID) }] }),
    },
  }
  const r = await suggestKeywords({ description: 'I sell something to small businesses', client: goodClient })
  assert.equal(r.fallback, undefined)
  assert.equal(r.suggestedName, 'Test Monitor')
})

test('TEMPLATES gallery has 8 buckets', () => {
  const keys = Object.keys(TEMPLATES)
  assert.equal(keys.length, 8)
})

test('rejects too-short description', async () => {
  await assert.rejects(
    () => suggestKeywords({ description: 'short', client: { messages: { create: async () => '' } } }),
    /too short/i
  )
})
