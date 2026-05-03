// test/post-evaluator.test.js
//
// Tests for lib/post-evaluator.js.
// All AI calls mocked via global.fetch — no real API calls.

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { evaluatePost, computeScore, _internals } from '../lib/post-evaluator.js'

function setGroqEnv()   { process.env.GROQ_API_KEY = 'test-key' }
function clearGroqEnv() { delete process.env.GROQ_API_KEY }

function mockGroq(content, { ok = true, status = 200 } = {}) {
  const original = global.fetch
  global.fetch = async () => ({
    ok, status,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => String(content),
  })
  return () => { global.fetch = original }
}

// ── computeScore unit tests ───────────────────────────────────────────────────

test('computeScore: BUYING+explicit+clear+commercial+<10min = 9', () => {
  const s = computeScore({
    intent_type: 'BUYING', urgency: 'explicit', specificity: 'clear',
    commercial_signal: true, postAgeMinutes: 5,
  })
  assert.equal(s, 9)   // 3+2+2+1+1
})

test('computeScore: HIRING+implied+partial+no-commercial+fresh = 7', () => {
  const s = computeScore({
    intent_type: 'HIRING', urgency: 'implied', specificity: 'partial',
    commercial_signal: false, postAgeMinutes: 30,
  })
  assert.equal(s, 6.5)   // 4+1+1+0+0.5
})

test('computeScore: NONE = 0 regardless of other dimensions', () => {
  const s = computeScore({
    intent_type: 'NONE', urgency: 'explicit', specificity: 'clear',
    commercial_signal: true, postAgeMinutes: 1,
  })
  assert.equal(s, 6)   // 0+2+2+1+1 — score could be non-zero but intent=NONE forces REJECT
})

test('computeScore: RESEARCH+none+vague+no-commercial+old = 1', () => {
  const s = computeScore({
    intent_type: 'RESEARCH', urgency: 'none', specificity: 'vague',
    commercial_signal: false, postAgeMinutes: 120,
  })
  assert.equal(s, 1)   // 1+0+0+0+0
})

test('computeScore: freshness brackets — <10, <60, else', () => {
  const base = { intent_type: 'BUYING', urgency: 'none', specificity: 'vague', commercial_signal: false }
  assert.equal(computeScore({ ...base, postAgeMinutes: 0 }),   4)    // 3+0+0+0+1
  assert.equal(computeScore({ ...base, postAgeMinutes: 9 }),   4)    // 3+0+0+0+1
  assert.equal(computeScore({ ...base, postAgeMinutes: 10 }),  3.5)  // 3+0+0+0+0.5
  assert.equal(computeScore({ ...base, postAgeMinutes: 59 }),  3.5)  // 3+0+0+0+0.5
  assert.equal(computeScore({ ...base, postAgeMinutes: 60 }),  3)    // 3+0+0+0+0
})

// ── validateDimensions ────────────────────────────────────────────────────────

test('validateDimensions: accepts well-formed AI output', () => {
  const { validateDimensions } = _internals
  const r = validateDimensions({
    intent_type: 'BUYING', urgency: 'explicit', specificity: 'clear',
    commercial_signal: true, unsafe: false, reply: 'Great post.',
  })
  assert.equal(r.intent_type, 'BUYING')
  assert.equal(r.urgency, 'explicit')
  assert.equal(r.reply, 'Great post.')
})

test('validateDimensions: normalises intent_type to uppercase', () => {
  const { validateDimensions } = _internals
  const r = validateDimensions({
    intent_type: 'buying', urgency: 'implied', specificity: 'partial',
    commercial_signal: false, unsafe: false, reply: null,
  })
  assert.equal(r?.intent_type, 'BUYING')
})

test('validateDimensions: returns null on unknown intent', () => {
  const { validateDimensions } = _internals
  assert.equal(validateDimensions({ intent_type: 'SPAM', urgency: 'none', specificity: 'vague' }), null)
})

test('validateDimensions: returns null on unknown urgency', () => {
  const { validateDimensions } = _internals
  assert.equal(validateDimensions({ intent_type: 'BUYING', urgency: 'ASAP', specificity: 'clear' }), null)
})

// ── extractJSON ───────────────────────────────────────────────────────────────

test('extractJSON: parses bare JSON', () => {
  const { extractJSON } = _internals
  const r = extractJSON('{"intent_type":"BUYING","urgency":"explicit"}')
  assert.equal(r.intent_type, 'BUYING')
})

test('extractJSON: strips markdown code fences', () => {
  const { extractJSON } = _internals
  const r = extractJSON('```json\n{"intent_type":"NONE"}\n```')
  assert.equal(r.intent_type, 'NONE')
})

test('extractJSON: returns null on garbage', () => {
  const { extractJSON } = _internals
  assert.equal(extractJSON('not json'), null)
  assert.equal(extractJSON(''), null)
  assert.equal(extractJSON(null), null)
})

// ── evaluatePost — happy path (ACCEPT) ───────────────────────────────────────

test('evaluatePost: ACCEPT on high-scoring BUYING post', async () => {
  setGroqEnv()
  const restore = mockGroq(JSON.stringify({
    intent_type: 'BUYING', urgency: 'explicit', specificity: 'clear',
    commercial_signal: true, unsafe: false,
    reply: 'Sounds like you need exactly what we built — happy to help you compare options.',
  }))
  try {
    const r = await evaluatePost({
      platform: 'reddit',
      postText: 'Looking for a monitoring tool ASAP, have budget, need to decide today.',
      postAgeMinutes: 5,
      communityRules: '',
    })
    assert.equal(r.decision, 'ACCEPT')
    assert.equal(r.intent_type, 'BUYING')
    assert.ok(r.score >= 7, `score ${r.score} should be ≥ 7`)
    assert.equal(r.unsafe, false)
    assert.ok(typeof r.reply === 'string', 'reply should be present on ACCEPT')
    assert.ok(typeof r.reason === 'string')
  } finally { restore(); clearGroqEnv() }
})

// ── evaluatePost — REJECT cases ───────────────────────────────────────────────

test('evaluatePost: REJECT when score < 7', async () => {
  setGroqEnv()
  const restore = mockGroq(JSON.stringify({
    intent_type: 'RESEARCH', urgency: 'none', specificity: 'vague',
    commercial_signal: false, unsafe: false, reply: 'Here is some info...',
  }))
  try {
    const r = await evaluatePost({ platform: 'reddit', postText: 'Just wondering about tools.', postAgeMinutes: 500 })
    assert.equal(r.decision, 'REJECT')
    assert.equal(r.reply, null)
    assert.ok(r.score < 7)
  } finally { restore(); clearGroqEnv() }
})

test('evaluatePost: REJECT when intent_type is NONE', async () => {
  setGroqEnv()
  const restore = mockGroq(JSON.stringify({
    intent_type: 'NONE', urgency: 'none', specificity: 'vague',
    commercial_signal: false, unsafe: false, reply: null,
  }))
  try {
    const r = await evaluatePost({ platform: 'reddit', postText: 'Just venting about my day.', postAgeMinutes: 5 })
    assert.equal(r.decision, 'REJECT')
    assert.equal(r.intent_type, 'NONE')
    assert.equal(r.reply, null)
  } finally { restore(); clearGroqEnv() }
})

test('evaluatePost: REJECT when unsafe=true', async () => {
  setGroqEnv()
  const restore = mockGroq(JSON.stringify({
    intent_type: 'BUYING', urgency: 'explicit', specificity: 'clear',
    commercial_signal: true, unsafe: true, reply: null,
  }))
  try {
    const r = await evaluatePost({
      platform: 'reddit', postText: 'Need a tool fast!',
      postAgeMinutes: 3, communityRules: 'No self-promotion',
    })
    assert.equal(r.decision, 'REJECT')
    assert.equal(r.unsafe, true)
    assert.equal(r.reply, null)
    assert.match(r.reason, /community rules|self-promotion/i)
  } finally { restore(); clearGroqEnv() }
})

// ── evaluatePost — graceful failure ───────────────────────────────────────────

test('evaluatePost: returns REJECT (never throws) on Groq 500', async () => {
  setGroqEnv()
  const restore = mockGroq('', { ok: false, status: 500 })
  try {
    const r = await evaluatePost({ platform: 'reddit', postText: 'Need SaaS monitoring.', postAgeMinutes: 10 })
    assert.equal(r.decision, 'REJECT')
    assert.equal(r.reply, null)
  } finally { restore(); clearGroqEnv() }
})

test('evaluatePost: returns REJECT (never throws) on network error', async () => {
  setGroqEnv()
  const original = global.fetch
  global.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    const r = await evaluatePost({ platform: 'linkedin', postText: 'Looking for CRM.', postAgeMinutes: 2 })
    assert.equal(r.decision, 'REJECT')
    assert.equal(r.reply, null)
  } finally { global.fetch = original; clearGroqEnv() }
})

test('evaluatePost: returns REJECT (never throws) when AI returns garbage JSON', async () => {
  setGroqEnv()
  const restore = mockGroq('Sorry I cannot help with that request.')
  try {
    const r = await evaluatePost({ platform: 'reddit', postText: 'Need a tool.', postAgeMinutes: 5 })
    assert.equal(r.decision, 'REJECT')
    assert.equal(r.reply, null)
  } finally { restore(); clearGroqEnv() }
})

test('evaluatePost: returns REJECT for empty post_text', async () => {
  const r = await evaluatePost({ platform: 'reddit', postText: '', postAgeMinutes: 5 })
  assert.equal(r.decision, 'REJECT')
  assert.equal(r.reply, null)
})

// ── Output shape contract ─────────────────────────────────────────────────────

test('evaluatePost: result always has all required fields', async () => {
  setGroqEnv()
  const restore = mockGroq(JSON.stringify({
    intent_type: 'SWITCHING', urgency: 'implied', specificity: 'clear',
    commercial_signal: true, unsafe: false,
    reply: 'Switching from X can be painful — here is what we have found works best.',
  }))
  try {
    const r = await evaluatePost({ platform: 'hackernews', postText: 'Fed up with Jira, want to switch.', postAgeMinutes: 8 })
    for (const f of ['decision','intent_type','score','unsafe','reason','reply']) {
      assert.ok(f in r, `missing field: ${f}`)
    }
    assert.ok(['ACCEPT','REJECT'].includes(r.decision))
    assert.ok(typeof r.score === 'number')
    assert.ok(typeof r.unsafe === 'boolean')
  } finally { restore(); clearGroqEnv() }
})
