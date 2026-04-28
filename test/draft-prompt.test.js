import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildDraftPrompt, validateDraft, isSensitiveSubreddit } from '../lib/draft-prompt.js'

test('buildDraftPrompt includes post fields', () => {
  const p = buildDraftPrompt({
    title: 'Need a tool for X',
    body: 'I am looking for...',
    subreddit: 'SaaS',
    productContext: 'I run a tool for accountants',
  })
  assert.ok(p.includes('Need a tool for X'))
  assert.ok(p.includes('I am looking for'))
  assert.ok(p.includes('r/SaaS'))
  assert.ok(p.includes('I run a tool for accountants'))
})

test('buildDraftPrompt strips r/ prefix from subreddit', () => {
  const p = buildDraftPrompt({ title: 't', body: 'b', subreddit: 'r/freelance', productContext: 'ctx' })
  assert.ok(p.includes('r/freelance'))
  assert.ok(!p.includes('r/r/freelance'))
})

test('buildDraftPrompt enables sensitivity hint for sensitive subs', () => {
  const p = buildDraftPrompt({ title: 't', body: 'b', subreddit: 'freelance', productContext: 'ctx' })
  assert.ok(p.includes('Strategy C'))
  assert.ok(p.includes('product mentions typically get removed'))
})

test('buildDraftPrompt omits sensitivity hint for non-sensitive subs', () => {
  const p = buildDraftPrompt({ title: 't', body: 'b', subreddit: 'SaaS', productContext: 'ctx' })
  assert.ok(!p.includes('product mentions typically get removed'))
})

test('buildDraftPrompt does NOT leak fake product name when omitted', () => {
  const p = buildDraftPrompt({ title: 't', body: 'b', subreddit: 'SaaS', productContext: 'ctx' })
  // Should not contain a placeholder like {productName} or undefined
  assert.ok(!p.includes('undefined'))
  assert.ok(!p.includes('{'))
  assert.ok(!p.includes('${'))
})

test('buildDraftPrompt names the product when provided', () => {
  const p = buildDraftPrompt({ title: 't', body: 'b', subreddit: 'SaaS', productContext: 'ctx', productName: 'Ledgr' })
  assert.ok(p.includes('Ledgr'))
})

test('buildDraftPrompt always includes the banned-phrase list', () => {
  const p = buildDraftPrompt({ title: 't', body: 'b', subreddit: 'SaaS', productContext: 'ctx' })
  assert.ok(p.includes('I hope this helps'))
  assert.ok(p.includes('Great question'))
  assert.ok(p.includes('check out'))
})

test('isSensitiveSubreddit detects known sensitive communities', () => {
  assert.equal(isSensitiveSubreddit('freelance'), true)
  assert.equal(isSensitiveSubreddit('Freelance'), true)
  assert.equal(isSensitiveSubreddit('r/freelance'), false) // caller should strip prefix
  assert.equal(isSensitiveSubreddit('SaaS'), false)
  assert.equal(isSensitiveSubreddit(''), false)
  assert.equal(isSensitiveSubreddit(null), false)
})

test('validateDraft accepts a clean reply', () => {
  const r = validateDraft('I have been using a CSV reconciler called Ledgr for this. Solved my month-end mess.')
  assert.equal(r.ok, true)
})

test('validateDraft rejects empty / SKIP / too-short', () => {
  assert.equal(validateDraft('').ok, false)
  assert.equal(validateDraft('SKIP').ok, false)
  assert.equal(validateDraft('hi').ok, false)
  assert.equal(validateDraft(null).ok, false)
})

test('validateDraft rejects banned phrases (case-insensitive)', () => {
  const r1 = validateDraft('Great question. Try this approach for the issue.')
  assert.equal(r1.ok, false)
  assert.equal(r1.reason, 'ai_tell')

  const r2 = validateDraft('You should check out this tool that handles it.')
  assert.equal(r2.ok, false)
  assert.equal(r2.reason, 'ai_tell')

  const r3 = validateDraft("I hope this helps with your problem and let me know if you need more.")
  assert.equal(r3.ok, false)
})

test('validateDraft rejects obvious markdown', () => {
  const r1 = validateDraft('- one\n- two\n- three')
  assert.equal(r1.ok, false)
  assert.equal(r1.reason, 'markdown')

  const r2 = validateDraft('# Heading\n\nbody text here')
  assert.equal(r2.ok, false)
})
