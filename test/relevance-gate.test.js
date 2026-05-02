import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { quoteIfMultiWord } from '../lib/reddit-rss.js'
import { classifyMatch, _internals } from '../lib/classify.js'

const { validateClassification } = _internals

// ── quoteIfMultiWord ─────────────────────────────────────────────────────────

test('quoteIfMultiWord: single word not wrapped', () => {
  assert.equal(quoteIfMultiWord('freelance'), 'freelance')
})

test('quoteIfMultiWord: multi-word wrapped in double quotes', () => {
  assert.equal(quoteIfMultiWord('freelance contract'), '"freelance contract"')
})

test('quoteIfMultiWord: already-quoted string not double-wrapped', () => {
  assert.equal(quoteIfMultiWord('"freelance contract"'), '"freelance contract"')
})

test('quoteIfMultiWord: empty string returned as-is', () => {
  assert.equal(quoteIfMultiWord(''), '')
})

test('quoteIfMultiWord: null/undefined treated as empty', () => {
  assert.equal(quoteIfMultiWord(null), '')
  assert.equal(quoteIfMultiWord(undefined), '')
})

// ── Engagement filter logic ──────────────────────────────────────────────────
// Tests the pure filtering logic — mirrors what monitor-v2.js does

function shouldDropEngagement(m, monitor = {}) {
  const APPROVED_SUBREDDITS = new Set(['freelance', 'freelancers', 'SaaS'])
  const _isZeroEngagement = (m.score === 0 && m.comments === 0)
  const _isApprovedSub    = APPROVED_SUBREDDITS.has(m.subreddit)
  const _isHighTrust      = ['hackernews','medium','substack','upwork','fiverr','github','producthunt'].includes(m.source)
  return _isZeroEngagement && !_isApprovedSub && !_isHighTrust
}

test('engagement filter: score=0,comments=0,unlisted subreddit → filtered', () => {
  const m = { score: 0, comments: 0, subreddit: 'random_sub', source: 'reddit' }
  assert.equal(shouldDropEngagement(m), true)
})

test('engagement filter: score=5,comments=0,unlisted subreddit → not filtered', () => {
  const m = { score: 5, comments: 0, subreddit: 'random_sub', source: 'reddit' }
  assert.equal(shouldDropEngagement(m), false)
})

test('engagement filter: score=0,comments=3,unlisted subreddit → not filtered', () => {
  const m = { score: 0, comments: 3, subreddit: 'random_sub', source: 'reddit' }
  assert.equal(shouldDropEngagement(m), false)
})

test('engagement filter: score=0,comments=0,source=hackernews → not filtered', () => {
  const m = { score: 0, comments: 0, subreddit: 'HackerNews', source: 'hackernews' }
  assert.equal(shouldDropEngagement(m), false)
})

// ── excludeTerms logic ───────────────────────────────────────────────────────

function shouldDropExclude(m, monitor) {
  if (!monitor.excludeTerms?.length) return false
  const _postText = `${m.title} ${m.body}`.toLowerCase()
  return monitor.excludeTerms.some(t => _postText.includes(t.toLowerCase().trim()))
}

test('excludeTerms: body contains excluded term → post excluded', () => {
  const m = { title: 'Looking for freelancers', body: 'Minecraft server admin needed' }
  const monitor = { excludeTerms: ['minecraft'] }
  assert.equal(shouldDropExclude(m, monitor), true)
})

test('excludeTerms: body does not contain term → post passes', () => {
  const m = { title: 'Need a freelance developer', body: 'React project available' }
  const monitor = { excludeTerms: ['minecraft'] }
  assert.equal(shouldDropExclude(m, monitor), false)
})

test('excludeTerms: monitor with no excludeTerms → all pass (no crash)', () => {
  const m = { title: 'test', body: 'body' }
  assert.equal(shouldDropExclude(m, {}), false)
  assert.equal(shouldDropExclude(m, { excludeTerms: [] }), false)
})

test('excludeTerms: matching is case-insensitive', () => {
  const m = { title: 'MINECRAFT server', body: '' }
  const monitor = { excludeTerms: ['minecraft'] }
  assert.equal(shouldDropExclude(m, monitor), true)
})

// ── blockedSubreddits logic ──────────────────────────────────────────────────

function shouldDropBlocked(m, monitor) {
  if (!monitor.blockedSubreddits?.length) return false
  const _sub = (m.subreddit || '').toLowerCase().replace(/^r\//, '')
  return monitor.blockedSubreddits.some(b => _sub === b.toLowerCase().trim().replace(/^r\//, ''))
}

test('blockedSubreddits: subreddit matches → filtered', () => {
  const m = { subreddit: 'pregnant' }
  const monitor = { blockedSubreddits: ['pregnant'] }
  assert.equal(shouldDropBlocked(m, monitor), true)
})

test('blockedSubreddits: r/ prefix handled', () => {
  const m = { subreddit: 'pregnant' }
  const monitor = { blockedSubreddits: ['r/pregnant'] }
  assert.equal(shouldDropBlocked(m, monitor), true)
})

test('blockedSubreddits: non-matching subreddit → not filtered', () => {
  const m = { subreddit: 'freelance' }
  const monitor = { blockedSubreddits: ['pregnant'] }
  assert.equal(shouldDropBlocked(m, monitor), false)
})

test('blockedSubreddits: monitor with no blockedSubreddits → all pass', () => {
  const m = { subreddit: 'anything' }
  assert.equal(shouldDropBlocked(m, {}), false)
  assert.equal(shouldDropBlocked(m, { blockedSubreddits: [] }), false)
})

// ── classifyMatch return shape ───────────────────────────────────────────────

test('validateClassification returns object with relevanceScore field', () => {
  const r = validateClassification({ sentiment: 'positive', intent: 'buying', confidence: 'high', relevanceScore: 0.8, demandScore: 7 })
  assert.ok(r !== null)
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'relevanceScore'))
  assert.equal(r.relevanceScore, 0.8)
})

test('validateClassification returns object with demandScore field', () => {
  const r = validateClassification({ sentiment: 'neutral', intent: 'researching', confidence: 'medium', relevanceScore: 0.5, demandScore: 5 })
  assert.ok(r !== null)
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'demandScore'))
  assert.equal(r.demandScore, 5)
})

test('validateClassification defaults relevanceScore=0.5 when missing', () => {
  const r = validateClassification({ sentiment: 'neutral', intent: 'researching', confidence: 'medium' })
  assert.ok(r !== null)
  assert.equal(r.relevanceScore, 0.5)
})

test('validateClassification defaults demandScore=3 when missing', () => {
  const r = validateClassification({ sentiment: 'neutral', intent: 'researching', confidence: 'medium' })
  assert.ok(r !== null)
  assert.equal(r.demandScore, 3)
})

test('classifyMatch returns null when GROQ_API_KEY not set', async () => {
  const saved = process.env.GROQ_API_KEY
  delete process.env.GROQ_API_KEY
  try {
    const r = await classifyMatch({ title: 'test post', body: 'some body', source: 'reddit' })
    assert.equal(r, null)
  } finally {
    if (saved !== undefined) process.env.GROQ_API_KEY = saved
  }
})
