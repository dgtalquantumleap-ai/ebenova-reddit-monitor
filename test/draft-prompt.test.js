import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildDraftPrompt, validateDraft, isSensitiveSubreddit, stripMarkdown, resolveTone, TONE_PRESETS } from '../lib/draft-prompt.js'

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

test('validateDraft rejects em-dash separators', () => {
  // The exact AI-tell pattern testers complained about: em dash with spaces around it.
  const r = validateDraft('I tried Notion last quarter — it works for solo but breaks at team scale.')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'em_dash_separator')
})

test('validateDraft rejects en-dash separators too', () => {
  const r = validateDraft('Solid approach – just watch the indexing strategy.')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'em_dash_separator')
})

test('validateDraft rejects bold and inline code', () => {
  assert.equal(validateDraft('You should try **this approach** instead of the old one because reasons.').ok, false)
  assert.equal(validateDraft('Run `npm install` and you are good to go for the deployment.').ok, false)
})

test('validateDraft accepts hyphens in compound words', () => {
  const r = validateDraft('I have been using a CSV reconciler for month-end work. Saves about 4 hours per cycle.')
  assert.equal(r.ok, true)
})

test('stripMarkdown removes em-dash separators but preserves compound-word hyphens', () => {
  const before = 'I tried Notion — it broke at team scale. Switched to month-end automation. Now I save 4 hours.'
  const after = stripMarkdown(before)
  assert.ok(!after.includes(' — '))
  assert.ok(after.includes('month-end'))
  assert.ok(after.includes(', it broke'))
})

test('stripMarkdown removes leading bullets / headers / numbered lists', () => {
  assert.equal(stripMarkdown('- one\n- two').includes('-'), false)
  assert.equal(stripMarkdown('# Heading\nbody').includes('#'), false)
  assert.equal(stripMarkdown('1. first\n2. second').includes('1.'), false)
})

test('stripMarkdown unwraps bold and italic', () => {
  assert.equal(stripMarkdown('use **this tool** instead'), 'use this tool instead')
  assert.equal(stripMarkdown('it _really_ matters'), 'it really matters')
  assert.equal(stripMarkdown('run `npm test`'), 'run npm test')
})

test('stripMarkdown collapses excessive whitespace', () => {
  assert.equal(stripMarkdown('one   two    three'), 'one two three')
  assert.equal(stripMarkdown('para1\n\n\n\n\npara2'), 'para1\n\npara2')
})

test('resolveTone returns a known preset for valid keys', () => {
  for (const key of Object.keys(TONE_PRESETS)) {
    const r = resolveTone(key)
    assert.equal(r, TONE_PRESETS[key])
  }
})

test('resolveTone falls back to conversational for invalid input', () => {
  assert.equal(resolveTone('hostile'), TONE_PRESETS.conversational)
  assert.equal(resolveTone(''), TONE_PRESETS.conversational)
  assert.equal(resolveTone(null), TONE_PRESETS.conversational)
  assert.equal(resolveTone(undefined), TONE_PRESETS.conversational)
})

test('buildDraftPrompt threads tone into the system instructions', () => {
  const conv = buildDraftPrompt({ title: 't', body: 'b', subreddit: 'SaaS', productContext: 'ctx', tone: 'conversational' })
  const exp  = buildDraftPrompt({ title: 't', body: 'b', subreddit: 'SaaS', productContext: 'ctx', tone: 'expert' })
  assert.ok(conv.includes(TONE_PRESETS.conversational))
  assert.ok(exp.includes(TONE_PRESETS.expert))
  // Different tones produce visibly different prompts
  assert.notEqual(conv, exp)
})

test('buildDraftPrompt includes new strict-formatting rules', () => {
  const p = buildDraftPrompt({ title: 't', body: 'b', subreddit: 'SaaS', productContext: 'ctx' })
  assert.ok(p.includes('STRICT FORMATTING RULES'))
  assert.ok(p.includes('ZERO em-dashes'))
  assert.ok(p.includes('PLAIN TEXT ONLY'))
})
