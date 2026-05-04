import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { draftCall, _internals } from '../lib/draft-call.js'

const SAMPLE = {
  title: 'Need a tool for X',
  body: 'I am looking for...',
  subreddit: 'SaaS',
  productContext: 'I run a tool that helps people do Y',
}

test('returns null draft when no provider env vars set', async () => {
  delete process.env.GROQ_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  const r = await draftCall(SAMPLE)
  assert.equal(r.draft, null)
  assert.equal(r.model, null)
})

test('PR #28: competitor-mode prompt addendum exists and matches the spec', () => {
  const text = _internals.COMPETITOR_PROMPT_ADDITION
  assert.match(text, /unhappy with or evaluating a competitor product/)
  assert.match(text, /Acknowledge their frustration without naming competitors/)
  assert.match(text, /Position an alternative naturally and helpfully/)
  assert.match(text, /Never say "our product"/)
  assert.match(text, /founder or power user who switched/)
  assert.match(text, /Maximum 3 sentences/)
})

test('PR #28: competitorMode=true appends the addendum to the prompt sent to providers', async () => {
  process.env.GROQ_API_KEY = 'k'
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  const captured = { promptCompetitor: null, promptNormal: null }
  const originalFetch = global.fetch
  let callIndex = 0
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body)
    const userMsg = body.messages.find(m => m.role === 'user')?.content ?? ''
    if (callIndex === 0) captured.promptCompetitor = userMsg
    else if (callIndex === 1) captured.promptNormal = userMsg
    callIndex++
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: 'A short helpful reply with no banned phrases or markdown formatting.' } }] }),
    }
  }
  try {
    await draftCall({ ...SAMPLE, competitorMode: true })
    await draftCall({ ...SAMPLE, competitorMode: false })
    assert.ok(captured.promptCompetitor, 'competitor-mode call should reach the provider')
    assert.ok(captured.promptNormal,     'non-competitor call should also reach the provider')
    assert.equal(captured.promptCompetitor.startsWith(captured.promptNormal), true,
      'competitor prompt should be the normal prompt + the addendum suffix')
    assert.match(captured.promptCompetitor, /Maximum 3 sentences/)
    assert.equal(/Maximum 3 sentences/.test(captured.promptNormal), false)
  } finally {
    global.fetch = originalFetch
    delete process.env.GROQ_API_KEY
  }
})

test('buildChain returns GROQ_QUALITY, GROQ_FAST, DEEPSEEK when all keys set', () => {
  process.env.GROQ_API_KEY = 'k1'
  process.env.DEEPSEEK_API_KEY = 'k2'
  const chain = _internals.buildChain()
  assert.equal(chain[0].name, 'groq-quality')
  assert.equal(chain[1].name, 'groq-fast')
  assert.equal(chain[2].name, 'deepseek')
  delete process.env.GROQ_API_KEY
  delete process.env.DEEPSEEK_API_KEY
})

test('buildChain returns only DEEPSEEK when only DEEPSEEK_API_KEY is set', () => {
  delete process.env.GROQ_API_KEY
  process.env.DEEPSEEK_API_KEY = 'k'
  const chain = _internals.buildChain()
  assert.equal(chain.length, 1)
  assert.equal(chain[0].name, 'deepseek')
  delete process.env.DEEPSEEK_API_KEY
})

test('buildChain skips providers without env keys', () => {
  process.env.GROQ_API_KEY = 'k1'
  delete process.env.DEEPSEEK_API_KEY
  const chain = _internals.buildChain()
  assert.equal(chain.length, 2)
  assert.equal(chain[0].name, 'groq-quality')
  assert.equal(chain[1].name, 'groq-fast')
  delete process.env.GROQ_API_KEY
})

test('returns successful draft tagged with model name', async () => {
  process.env.GROQ_API_KEY = 'test'
  delete process.env.DEEPSEEK_API_KEY
  const originalFetch = global.fetch
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: 'Honestly used a CSV tool for this. Saved my month-end mess after years of pain.' } }] }),
  })
  try {
    const r = await draftCall(SAMPLE)
    assert.equal(r.model, 'groq-quality')
    assert.ok(r.draft && r.draft.length > 10)
  } finally {
    global.fetch = originalFetch
    delete process.env.GROQ_API_KEY
  }
})

test('falls through to peer when primary returns SKIP', async () => {
  process.env.GROQ_API_KEY = 'test'
  process.env.DEEPSEEK_API_KEY = 'test'
  const originalFetch = global.fetch
  global.fetch = async (url) => {
    if (url.includes('groq.com')) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'SKIP' } }] }) }
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Solid reply that mentions a concrete tactic. Saved me 2 hours per week on month-end work.' } }] }) }
  }
  try {
    const r = await draftCall(SAMPLE)
    assert.equal(r.model, 'deepseek')
    assert.ok(r.draft.includes('Solid reply'))
  } finally {
    global.fetch = originalFetch
    delete process.env.GROQ_API_KEY
    delete process.env.DEEPSEEK_API_KEY
  }
})

test('falls through to peer when primary throws', async () => {
  process.env.GROQ_API_KEY = 'test'
  process.env.DEEPSEEK_API_KEY = 'test'
  const originalFetch = global.fetch
  global.fetch = async (url) => {
    if (url.includes('groq.com')) return { ok: false, status: 503, text: async () => 'down' }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Backup model wrote this clean reply with a concrete step you can take today.' } }] }) }
  }
  try {
    const r = await draftCall(SAMPLE)
    assert.equal(r.model, 'deepseek')
  } finally {
    global.fetch = originalFetch
    delete process.env.GROQ_API_KEY
    delete process.env.DEEPSEEK_API_KEY
  }
})

test('returns null when all providers fail', async () => {
  process.env.GROQ_API_KEY = 'test'
  process.env.DEEPSEEK_API_KEY = 'test'
  const originalFetch = global.fetch
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'down' })
  try {
    const r = await draftCall(SAMPLE)
    assert.equal(r.draft, null)
    assert.equal(r.model, null)
  } finally {
    global.fetch = originalFetch
    delete process.env.GROQ_API_KEY
    delete process.env.DEEPSEEK_API_KEY
  }
})

test('regenerates with stricter nudge on AI tell, falls through if regen also fails', async () => {
  process.env.GROQ_API_KEY = 'test'
  process.env.DEEPSEEK_API_KEY = 'test'
  const originalFetch = global.fetch
  let groqCalls = 0
  global.fetch = async (url) => {
    if (url.includes('groq.com')) {
      groqCalls++
      // Both initial and regen attempts return an AI-tell
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Great question, I hope this helps you out today.' } }] }) }
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Backup wrote this without the AI tells. Specific and short.' } }] }) }
  }
  try {
    const r = await draftCall(SAMPLE)
    // groq-quality tries twice (initial + regen), groq-fast tries twice (initial + regen)
    assert.equal(groqCalls, 4)
    assert.equal(r.model, 'deepseek')
  } finally {
    global.fetch = originalFetch
    delete process.env.GROQ_API_KEY
    delete process.env.DEEPSEEK_API_KEY
  }
})
