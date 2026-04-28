// Anthropic Haiku 4.5 client wrapper used by the onboarding wizard.
// Strategy:
//   - Use prompt caching on the system prompt (90% input-token discount)
//   - Retry once on parse failure with a fix-up prompt
//   - Retry on transient 5xx with exponential backoff
//   - Extract JSON from any code-fenced or embedded block in the response

import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 1024

export function getAnthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')
  return new Anthropic({ apiKey })
}

// Extract a JSON object from text. Handles:
//   - bare JSON: {...}
//   - fenced JSON: ```json\n{...}\n```
//   - JSON embedded in surrounding prose
function extractJSON(text) {
  // Try fenced ```json blocks first
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]) } catch {}
  }
  // Find first { ... last } and parse
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch {}
  }
  // Bare parse
  try { return JSON.parse(text.trim()) } catch {}
  throw new Error('Could not parse JSON from response')
}

async function callOnce({ client, system, user }) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  })
  const text = resp.content?.[0]?.text || ''
  return text
}

export async function callAnthropicJSON({ client, system, user }) {
  const c = client || getAnthropicClient()

  // Stage 1: call with retry on transient 5xx (max 3 attempts)
  let text
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      text = await callOnce({ client: c, system, user })
      break
    } catch (err) {
      lastErr = err
      const status = err.status || err.statusCode
      if (status >= 500 && attempt < 2) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)))
        continue
      }
      throw err
    }
  }
  if (text === undefined) throw lastErr

  // Stage 2: try to parse, fix-up retry on failure
  try {
    return extractJSON(text)
  } catch (parseErr) {
    const fixUser = `Your previous response was not valid JSON. Return only the JSON object, no commentary, no markdown fences. Original request:\n\n${user}`
    const text2 = await callOnce({ client: c, system, user: fixUser })
    try {
      return extractJSON(text2)
    } catch {
      throw new Error('Anthropic returned invalid JSON after retry')
    }
  }
}
