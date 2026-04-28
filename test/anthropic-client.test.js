import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { callAnthropicJSON } from '../lib/llm/anthropic.js'

// We test JSON-extraction + retry behavior. Real API calls are not made;
// a mock client is injected.

function mockClient(responses) {
  let i = 0
  return {
    messages: {
      create: async (_opts) => {
        const r = responses[i++]
        if (r instanceof Error) throw r
        return { content: [{ type: 'text', text: r }] }
      },
    },
  }
}

test('returns parsed JSON from valid response', async () => {
  const client = mockClient(['{"keywords":["a","b"]}'])
  const r = await callAnthropicJSON({ client, system: 's', user: 'u' })
  assert.deepEqual(r, { keywords: ['a', 'b'] })
})

test('extracts JSON from response with surrounding markdown fences', async () => {
  const client = mockClient(['Here you go:\n```json\n{"x":1}\n```\nHope that helps.'])
  const r = await callAnthropicJSON({ client, system: 's', user: 'u' })
  assert.deepEqual(r, { x: 1 })
})

test('retries once on parse failure with fix-up prompt', async () => {
  const client = mockClient([
    'not valid json at all',         // first attempt: bad
    '{"recovered":true}',            // retry: good
  ])
  const r = await callAnthropicJSON({ client, system: 's', user: 'u' })
  assert.deepEqual(r, { recovered: true })
})

test('throws after second parse failure', async () => {
  const client = mockClient(['bad', 'still bad'])
  await assert.rejects(
    () => callAnthropicJSON({ client, system: 's', user: 'u' }),
    /could not parse|invalid json/i
  )
})

test('retries on transient API error (5xx)', async () => {
  const err = Object.assign(new Error('overloaded'), { status: 529 })
  const client = mockClient([err, '{"ok":true}'])
  const r = await callAnthropicJSON({ client, system: 's', user: 'u' })
  assert.deepEqual(r, { ok: true })
})
