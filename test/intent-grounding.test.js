import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { groundingContext, detectStance, groundIntent } from '../lib/intent-grounding.js'

const SEEK = { developerAudience: false, desiredStance: 'seek' }

// ── groundingContext: developer-audience detection ───────────────────────────

test('groundingContext: dev-tool monitor → developerAudience true', () => {
  const ctx = groundingContext({ keywords: [{ keyword: 'MCP server' }, { keyword: 'LLM integration' }] })
  assert.equal(ctx.developerAudience, true)
})

test('groundingContext: business monitor → developerAudience false', () => {
  const ctx = groundingContext({
    keywords: [{ keyword: 'validate my business idea' }, { keyword: 'MVP validation' }],
    productContext: 'We help entrepreneurs validate business ideas before coding.',
  })
  assert.equal(ctx.developerAudience, false)
})

test('groundingContext: builder_tracker mode → desiredStance announce', () => {
  assert.equal(groundingContext({ mode: 'builder_tracker' }).desiredStance, 'announce')
  assert.equal(groundingContext({ mode: 'keyword' }).desiredStance, 'seek')
})

// ── Check A: domain-sense (polysemy) ─────────────────────────────────────────

test('domain: GitHub code-artifact on non-dev monitor → rejected', () => {
  const m = { source: 'github', title: 'Add CIFAR-10 evaluation pipeline', body: '## Goal MVP validation harness' }
  assert.equal(groundIntent(m, SEEK).admit, false)
})

test('domain: same GitHub post on a developer-audience monitor → admitted', () => {
  const m = { source: 'github', title: 'Add CIFAR-10 evaluation pipeline', body: '' }
  assert.equal(groundIntent(m, { developerAudience: true, desiredStance: 'seek' }).admit, true)
})

test('domain: reddit post is never domain-rejected by source', () => {
  const m = { source: 'reddit', subreddit: 'Entrepreneur', title: 'how do I validate my idea', body: '' }
  assert.equal(groundIntent(m, SEEK).admit, true)
})

// ── Check B: actor stance (intent inversion) ─────────────────────────────────

test('stance: "I built X" announce post on a demand monitor → rejected', () => {
  assert.equal(detectStance({ title: 'I built a working SaaS with AI in one weekend', body: '' }), 'announce')
  assert.equal(groundIntent({ source: 'reddit', title: 'I built a working SaaS with AI in one weekend', body: '' }, SEEK).admit, false)
})

test('stance: "Show HN" announce post → rejected on demand monitor', () => {
  assert.equal(groundIntent({ source: 'hackernews', title: 'Show HN: Ouijit, a terminal manager', body: '' }, SEEK).admit, false)
})

test('stance: "built solo" supply post → rejected', () => {
  const m = { source: 'hackernews', title: 'ReadyToTalk – AI receptionist for small businesses, built solo with AI agents', body: '' }
  assert.equal(groundIntent(m, SEEK).admit, false)
})

test('stance: genuine seeker with co-occurring "building" is PRESERVED (true positive)', () => {
  // The fixture true positive: "building SaaS" + explicit "looking for partner".
  const m = { source: 'hackernews', title: 'Solo founder building SaaS. looking for partner', body: 'looking for a partner' }
  assert.equal(detectStance(m), 'seek')
  assert.equal(groundIntent(m, SEEK).admit, true)
})

test('stance: neutral discussion post is not rejected', () => {
  const m = { source: 'reddit', title: 'The VA problem isnt where you find them', body: 'Most VA horror stories follow the same pattern.' }
  assert.equal(detectStance(m), 'neutral')
  assert.equal(groundIntent(m, SEEK).admit, true)
})

test('stance: feedback request is treated as supply, not demand', () => {
  const m = { source: 'reddit', title: 'Built an AML tool. Looking for brutal feedback', body: '' }
  assert.equal(groundIntent(m, SEEK).admit, false)
})
