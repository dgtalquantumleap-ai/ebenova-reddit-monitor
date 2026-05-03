import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { suggestKeywords, validateSuggestion, fetchProductPage } from '../lib/find-suggest.js'
import { TEMPLATES } from '../lib/templates.js'

const VALID = {
  suggestedName: 'Test Monitor',
  productContext: 'A clean version of the input description',
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

test('falls back to template when AI throws', async () => {
  const failingClient = { messages: { create: async () => { throw new Error('API down') } } }
  const r = await suggestKeywords({
    description: 'I sell SaaS bookkeeping software for indie agencies',
    client: failingClient,
  })
  assert.equal(r.fallback, true)
  assert.ok(r.keywords.length >= 4)
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
  assert.equal(Object.keys(TEMPLATES).length, 8)
})

test('rejects too-short description', async () => {
  await assert.rejects(
    () => suggestKeywords({ description: 'short', client: { messages: { create: async () => '' } } }),
    /too short/i
  )
})

// ── fetchProductPage ──────────────────────────────────────────────────────────

test('fetchProductPage: returns null when fetch throws (network error)', async () => {
  // Stub global fetch to throw
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  const result = await fetchProductPage('https://example.com')
  globalThis.fetch = origFetch
  assert.equal(result, null)
})

test('fetchProductPage: returns null on non-2xx response', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, headers: { get: () => 'text/html' }, text: async () => '' })
  const result = await fetchProductPage('https://example.com')
  globalThis.fetch = origFetch
  assert.equal(result, null)
})

test('fetchProductPage: returns null for non-HTML content type', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'application/pdf' }, text: async () => '<html>' })
  const result = await fetchProductPage('https://example.com')
  globalThis.fetch = origFetch
  assert.equal(result, null)
})

test('fetchProductPage: strips tags and returns visible text', async () => {
  const html = `<html><head><title>Acme</title><style>body{color:red}</style></head>
    <body><h1>The best contract tool</h1><script>alert(1)</script><p>For freelancers</p></body></html>`
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => html })
  const result = await fetchProductPage('https://example.com')
  globalThis.fetch = origFetch
  assert.ok(result.includes('best contract tool'))
  assert.ok(result.includes('For freelancers'))
  assert.ok(!result.includes('<h1>'))
  assert.ok(!result.includes('alert(1)'))
  assert.ok(!result.includes('color:red'))
})

test('fetchProductPage: truncates to PAGE_CONTENT_MAX_CHARS (3000)', async () => {
  const html = `<p>${'x'.repeat(10000)}</p>`
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'text/html' }, text: async () => html })
  const result = await fetchProductPage('https://example.com')
  globalThis.fetch = origFetch
  assert.ok(result !== null)
  assert.ok(result.length <= 3000)
})

test('suggestKeywords: productUrl is fetched and succeeds without affecting output shape', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => 'text/html' },
    text: async () => '<p>AI contract generator for freelancers</p>',
  })
  const goodClient = {
    messages: {
      create: async () => ({ content: [{ type: 'text', text: JSON.stringify(VALID) }] }),
    },
  }
  const r = await suggestKeywords({
    description: 'I sell contract software to freelancers',
    productUrl: 'https://example.com',
    client: goodClient,
  })
  globalThis.fetch = origFetch
  assert.equal(r.suggestedName, 'Test Monitor')
  assert.equal(r.fallback, undefined)
})

test('suggestKeywords: page fetch failure does not break keyword generation', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('timeout') }
  const goodClient = {
    messages: {
      create: async () => ({ content: [{ type: 'text', text: JSON.stringify(VALID) }] }),
    },
  }
  const r = await suggestKeywords({
    description: 'I sell contract software to freelancers',
    productUrl: 'https://example.com',
    client: goodClient,
  })
  globalThis.fetch = origFetch
  assert.equal(r.suggestedName, 'Test Monitor')
})
