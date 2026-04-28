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

test('buildChain respects DRAFT_PRIMARY=groq (default)', () => {
  process.env.GROQ_API_KEY = 'k1'
  process.env.DEEPSEEK_API_KEY = 'k2'
  delete process.env.DRAFT_PRIMARY
  const chain = _internals.buildChain()
  assert.equal(chain[0].name, 'groq')
  assert.equal(chain[1].name, 'deepseek')
  delete process.env.GROQ_API_KEY
  delete process.env.DEEPSEEK_API_KEY
})

test('buildChain swaps order when DRAFT_PRIMARY=deepseek', () => {
  process.env.GROQ_API_KEY = 'k1'
  process.env.DEEPSEEK_API_KEY = 'k2'
  process.env.DRAFT_PRIMARY = 'deepseek'
  const chain = _internals.buildChain()
  assert.equal(chain[0].name, 'deepseek')
  assert.equal(chain[1].name, 'groq')
  delete process.env.GROQ_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.DRAFT_PRIMARY
})

test('buildChain skips providers without env keys', () => {
  process.env.GROQ_API_KEY = 'k1'
  delete process.env.DEEPSEEK_API_KEY
  const chain = _internals.buildChain()
  assert.equal(chain.length, 1)
  assert.equal(chain[0].name, 'groq')
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
    assert.equal(r.model, 'groq')
    assert.ok(r.draft && r.draft.length > 10)
  } finally {
    global.fetch = originalFetch
    delete process.env.GROQ_API_KEY
  }
})

test('falls through to peer when primary returns SKIP', async () => {
  process.env.GROQ_API_KEY = 'test'
  process.env.DEEPSEEK_API_KEY = 'test'
  delete process.env.DRAFT_PRIMARY
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
  delete process.env.DRAFT_PRIMARY
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
  delete process.env.DRAFT_PRIMARY
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
  delete process.env.DRAFT_PRIMARY
  const originalFetch = global.fetch
  let groqCalls = 0
  global.fetch = async (url) => {
    if (url.includes('groq.com')) {
      groqCalls++
      // First call: AI-tell. Second (regen): same AI-tell.
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Great question, I hope this helps you out today.' } }] }) }
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Backup wrote this without the AI tells. Specific and short.' } }] }) }
  }
  try {
    const r = await draftCall(SAMPLE)
    // Groq tries twice (initial + regen), both fail validation, falls to deepseek
    assert.equal(groqCalls, 2)
    assert.equal(r.model, 'deepseek')
  } finally {
    global.fetch = originalFetch
    delete process.env.GROQ_API_KEY
    delete process.env.DEEPSEEK_API_KEY
  }
})
