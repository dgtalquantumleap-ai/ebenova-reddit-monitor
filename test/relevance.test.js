import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { passesRelevanceCheck } from '../lib/relevance.js'

// ── keyword type (AND-word logic) ─────────────────────────────────────────────

test('keyword: single word found in title → passes', () => {
  assert.equal(passesRelevanceCheck({ title: 'scope creep is real', body: '' }, 'scope', 'keyword'), true)
})

test('keyword: single word missing → fails', () => {
  assert.equal(passesRelevanceCheck({ title: 'hello world', body: '' }, 'freelance', 'keyword'), false)
})

test('keyword: all words present in title → passes', () => {
  assert.equal(passesRelevanceCheck({ title: 'scope creep nightmare', body: '' }, 'scope creep', 'keyword'), true)
})

test('keyword: only one word present → fails', () => {
  assert.equal(passesRelevanceCheck({ title: 'scope disaster', body: '' }, 'scope creep', 'keyword'), false)
})

test('keyword: words split across title and body → passes', () => {
  assert.equal(passesRelevanceCheck({ title: 'scope issue', body: 'massive creep' }, 'scope creep', 'keyword'), true)
})

test('keyword: case-insensitive match → passes', () => {
  assert.equal(passesRelevanceCheck({ title: 'SCOPE CREEP problem', body: '' }, 'scope creep', 'keyword'), true)
})

test('keyword: empty keyword → always passes', () => {
  assert.equal(passesRelevanceCheck({ title: 'anything', body: '' }, '', 'keyword'), true)
})

test('keyword: defaults to keyword logic when kwType omitted', () => {
  assert.equal(passesRelevanceCheck({ title: 'scope creep', body: '' }, 'scope creep'), true)
  assert.equal(passesRelevanceCheck({ title: 'something else', body: '' }, 'scope creep'), false)
})

// ── phrase type (exact substring) ─────────────────────────────────────────────

test('phrase: exact phrase present → passes', () => {
  assert.equal(passesRelevanceCheck({ title: 'dealing with scope creep today', body: '' }, 'scope creep', 'phrase'), true)
})

test('phrase: words present but not adjacent → fails', () => {
  assert.equal(passesRelevanceCheck({ title: 'scope issue and creep', body: '' }, 'scope creep', 'phrase'), false)
})

test('phrase: exact phrase in body → passes', () => {
  assert.equal(passesRelevanceCheck({ title: 'help', body: 'massive scope creep on this project' }, 'scope creep', 'phrase'), true)
})

test('phrase: case-insensitive → passes', () => {
  assert.equal(passesRelevanceCheck({ title: 'SCOPE CREEP situation', body: '' }, 'scope creep', 'phrase'), true)
})

test('phrase: single-word phrase — substring match is fine', () => {
  // "freelancer" contains "freelance" as a substring — phrase match passes
  assert.equal(passesRelevanceCheck({ title: 'freelancer issues', body: '' }, 'freelance', 'phrase'), true)
  assert.equal(passesRelevanceCheck({ title: 'i am a freelance dev', body: '' }, 'freelance', 'phrase'), true)
  // Completely unrelated word → fails
  assert.equal(passesRelevanceCheck({ title: 'unrelated topic', body: '' }, 'freelance', 'phrase'), false)
})

// ── competitor type (same AND-word logic as keyword) ─────────────────────────

test('competitor: all words present → passes', () => {
  assert.equal(passesRelevanceCheck({ title: 'DocuSign too expensive for me', body: '' }, 'DocuSign too expensive', 'competitor'), true)
})

test('competitor: missing word → fails', () => {
  assert.equal(passesRelevanceCheck({ title: 'DocuSign pricing', body: '' }, 'DocuSign too expensive', 'competitor'), false)
})

// ── retrieval containment gate (competitor pipeline) ─────────────────────────
// Competitor matches are gated on the BRAND NAME (not the expanded query phrase)
// at the injection boundary in monitor-v2.js. These pin that contract: a loose
// Reddit/HN hit for an expanded query like "Deloitte Digital vs" is admitted only
// if the brand actually appears in title+body.

test('containment: off-brand cross-domain hit is rejected on brand name', () => {
  // Real production leak: "Deloitte Digital vs" fuzzy-matched a wrestling thread.
  const wrestling = { title: 'Best of the Super Juniors 33 B Block Standings', body: 'Welcome back to my coverage of the block standings' }
  assert.equal(passesRelevanceCheck(wrestling, 'Deloitte Digital', 'competitor'), false)
})

test('containment: genuine brand mention is admitted', () => {
  const real = { title: 'Anyone switching off Deloitte Digital?', body: 'We are evaluating alternatives to Deloitte Digital for our rebrand.' }
  assert.equal(passesRelevanceCheck(real, 'Deloitte Digital', 'competitor'), true)
})

test('containment: single-token brand must still appear', () => {
  assert.equal(passesRelevanceCheck({ title: 'random unrelated post', body: '' }, 'Salesforce', 'competitor'), false)
  assert.equal(passesRelevanceCheck({ title: 'thinking of leaving Salesforce', body: '' }, 'Salesforce', 'competitor'), true)
})

// ── edge cases ────────────────────────────────────────────────────────────────

test('missing title and body → fails for non-empty keyword', () => {
  assert.equal(passesRelevanceCheck({}, 'scope creep', 'keyword'), false)
})

test('undefined title/body fields handled gracefully', () => {
  assert.equal(passesRelevanceCheck({ title: undefined, body: undefined }, 'scope creep', 'keyword'), false)
})
