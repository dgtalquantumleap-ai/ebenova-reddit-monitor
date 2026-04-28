// lib/llm/deepseek.js — Deepseek Chat client.
// OpenAI-compatible API with native JSON-mode. Mirrors callGroqJSON's
// interface so it can drop in as a peer in find-suggest's fallback chain.
//
// Pricing (per 1M tokens, 2026): $0.27 in / $1.10 out — cheaper input than
// Groq, more expensive output. Quality comparable to Llama 3.3 70b on
// structured-JSON tasks.

const MODEL = 'deepseek-chat'
const MAX_TOKENS = 1024
const ENDPOINT = 'https://api.deepseek.com/chat/completions'

function extractJSON(text) {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]) } catch {}
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch {}
  }
  try { return JSON.parse(text.trim()) } catch {}
  throw new Error('Could not parse JSON from Deepseek response')
}

async function callOnce({ apiKey, system, user, jsonMode, model, maxTokens }) {
  const body = {
    model: model || MODEL,
    max_tokens: maxTokens || MAX_TOKENS,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }
  if (jsonMode) body.response_format = { type: 'json_object' }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    const err = new Error(`Deepseek ${res.status}: ${errBody.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

export async function callDeepseekJSON({ system, user, apiKey }) {
  const key = apiKey || process.env.DEEPSEEK_API_KEY
  if (!key) throw new Error('DEEPSEEK_API_KEY not set')

  let text
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      text = await callOnce({ apiKey: key, system, user, jsonMode: true })
      break
    } catch (err) {
      lastErr = err
      const status = err.status
      if ((status === undefined || status >= 500) && attempt < 2) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)))
        continue
      }
      throw err
    }
  }
  if (text === undefined) throw lastErr

  try {
    return extractJSON(text)
  } catch {
    const fixUser = `Your previous response was not valid JSON. Return only the JSON object, no commentary, no markdown fences. Original request:\n\n${user}`
    const text2 = await callOnce({ apiKey: key, system, user: fixUser, jsonMode: true })
    try {
      return extractJSON(text2)
    } catch {
      throw new Error('Deepseek returned invalid JSON after retry')
    }
  }
}

// Plain-text completion (no JSON mode) — used for reply drafts.
// Returns trimmed string content or throws on failure.
export async function callDeepseekText({ system, user, apiKey, maxTokens, temperature }) {
  const key = apiKey || process.env.DEEPSEEK_API_KEY
  if (!key) throw new Error('DEEPSEEK_API_KEY not set')

  const body = {
    model: MODEL,
    max_tokens: maxTokens || 320,
    temperature: temperature ?? 0.8,
    messages: system
      ? [{ role: 'system', content: system }, { role: 'user', content: user }]
      : [{ role: 'user', content: user }],
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    const err = new Error(`Deepseek ${res.status}: ${errBody.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  const data = await res.json()
  return (data.choices?.[0]?.message?.content || '').trim()
}
