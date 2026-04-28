import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { callDeepseekJSON, callDeepseekText } from '../lib/llm/deepseek.js'

test('callDeepseekJSON throws when DEEPSEEK_API_KEY not set', async () => {
  delete process.env.DEEPSEEK_API_KEY
  await assert.rejects(
    () => callDeepseekJSON({ system: 'sys', user: 'usr' }),
    /DEEPSEEK_API_KEY not set/
  )
})

test('callDeepseekJSON parses fenced JSON', async () => {
  process.env.DEEPSEEK_API_KEY = 'test'
  const originalFetch = global.fetch
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: '```json\n{"a":1,"b":"x"}\n```' } }] }),
  })
  try {
    const r = await callDeepseekJSON({ system: 's', user: 'u' })
    assert.deepEqual(r, { a: 1, b: 'x' })
  } finally {
    global.fetch = originalFetch
    delete process.env.DEEPSEEK_API_KEY
  }
})

test('callDeepseekJSON retries on 500 then succeeds', async () => {
  process.env.DEEPSEEK_API_KEY = 'test'
  const originalFetch = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls++
    if (calls === 1) return { ok: false, status: 503, text: async () => 'busy' }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) }
  }
  try {
    const r = await callDeepseekJSON({ system: 's', user: 'u' })
    assert.deepEqual(r, { ok: true })
    assert.equal(calls, 2)
  } finally {
    global.fetch = originalFetch
    delete process.env.DEEPSEEK_API_KEY
  }
})

test('callDeepseekJSON does not retry on 400-class', async () => {
  process.env.DEEPSEEK_API_KEY = 'test'
  const originalFetch = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls++
    return { ok: false, status: 401, text: async () => 'unauthorized' }
  }
  try {
    await assert.rejects(() => callDeepseekJSON({ system: 's', user: 'u' }), /Deepseek 401/)
    assert.equal(calls, 1)
  } finally {
    global.fetch = originalFetch
    delete process.env.DEEPSEEK_API_KEY
  }
})

test('callDeepseekJSON does fix-up retry on invalid JSON', async () => {
  process.env.DEEPSEEK_API_KEY = 'test'
  const originalFetch = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls++
    if (calls === 1) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'this is not json at all really' } }] }) }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"fixed":true}' } }] }) }
  }
  try {
    const r = await callDeepseekJSON({ system: 's', user: 'u' })
    assert.deepEqual(r, { fixed: true })
    assert.equal(calls, 2)
  } finally {
    global.fetch = originalFetch
    delete process.env.DEEPSEEK_API_KEY
  }
})

test('callDeepseekText returns trimmed content', async () => {
  process.env.DEEPSEEK_API_KEY = 'test'
  const originalFetch = global.fetch
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: '   reply text here   ' } }] }),
  })
  try {
    const r = await callDeepseekText({ system: 's', user: 'u' })
    assert.equal(r, 'reply text here')
  } finally {
    global.fetch = originalFetch
    delete process.env.DEEPSEEK_API_KEY
  }
})

test('callDeepseekText omits system role when system is empty', async () => {
  process.env.DEEPSEEK_API_KEY = 'test'
  const originalFetch = global.fetch
  let captured
  global.fetch = async (_url, opts) => {
    captured = JSON.parse(opts.body)
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) }
  }
  try {
    await callDeepseekText({ user: 'just user' })
    assert.equal(captured.messages.length, 1)
    assert.equal(captured.messages[0].role, 'user')
  } finally {
    global.fetch = originalFetch
    delete process.env.DEEPSEEK_API_KEY
  }
})
