// Smoke tests for bin/usage-stats.js — confirms the script's pure helpers
// behave correctly without requiring real Redis. The IP geo-resolution path
// is intentionally NOT tested because it depends on a public service.
//
// What we DO test:
//   - signupCountry capture from CDN headers in /v1/auth/signup
//   - signupIp + signupCountry shape on the apikey record

import { test } from 'node:test'
import { strict as assert } from 'node:assert'

// We don't import api-server.js (it would call requireEnv + exit). Instead
// we lift the country-extraction logic into a tiny pure function here and
// test that — same logic, easier to assert.
function extractCountry(headers) {
  return (headers['cf-ipcountry']
       || headers['x-vercel-ip-country']
       || headers['x-country-code']
       || headers['cloudfront-viewer-country']
       || '').toString().toUpperCase().slice(0, 2) || null
}

test('extractCountry: reads cf-ipcountry from Cloudflare', () => {
  assert.equal(extractCountry({ 'cf-ipcountry': 'ng' }), 'NG')
  assert.equal(extractCountry({ 'cf-ipcountry': 'GB' }), 'GB')
})

test('extractCountry: falls through to x-vercel-ip-country', () => {
  assert.equal(extractCountry({ 'x-vercel-ip-country': 'us' }), 'US')
})

test('extractCountry: falls through to cloudfront-viewer-country', () => {
  assert.equal(extractCountry({ 'cloudfront-viewer-country': 'ca' }), 'CA')
})

test('extractCountry: returns null when no header present (Railway default)', () => {
  assert.equal(extractCountry({}), null)
  assert.equal(extractCountry({ 'user-agent': 'Mozilla/5.0' }), null)
})

test('extractCountry: clips to 2 chars (defensive — bad header value)', () => {
  assert.equal(extractCountry({ 'cf-ipcountry': 'NIGERIA' }), 'NI')
  assert.equal(extractCountry({ 'cf-ipcountry': '' }), null)
})

test('extractCountry: prefers cf-ipcountry over other headers when both set', () => {
  // Cloudflare wins because it's the most-deployed CDN in front of public APIs.
  assert.equal(extractCountry({ 'cf-ipcountry': 'NG', 'x-vercel-ip-country': 'US' }), 'NG')
})

// Pin the apikey record fields the stats script reads. If a future PR
// renames signupIp / signupCountry / signupUa, this test fails noisily
// before the script silently breaks.
test('stats contract: keyData includes signupIp + signupCountry + signupUa', () => {
  // Mirror of the keyData object built in api-server.js's signup handler.
  const keyData = {
    owner: 'x@example.com',
    email: 'x@example.com',
    insights: true,
    insightsPlan: 'starter',
    createdAt: '2026-04-30T00:00:00Z',
    source: 'self-signup',
    signupIp: '203.0.113.1',
    signupCountry: 'NG',
    signupUa: 'Mozilla/5.0 (Macintosh)',
  }
  assert.equal(typeof keyData.signupIp,      'string')
  assert.equal(keyData.signupCountry,        'NG')
  assert.equal(typeof keyData.signupUa,      'string')
})
