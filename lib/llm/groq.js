// Groq Llama 3.3 70b client wrapper — primary model for keyword suggestion.
// ~10x cheaper than Anthropic Haiku. Uses OpenAI-compatible JSON-mode for
// reliable structured output. Mirrors callAnthropicJSON's interface so it can
// be swapped in/out at the call site.

const MODEL = 'llama-3.3-70b-versatile'
const MAX_TOKENS = 1024
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'

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
  throw new Error('Could not parse JSON from Groq response')
}

async function callOnce({ apiKey, system, user, jsonMode }) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
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
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    const err = new Error(`Groq ${res.status}: ${errBody.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

export async function callGroqJSON({ system, user, apiKey }) {
  const key = apiKey || process.env.GROQ_API_KEY
  if (!key) throw new Error('GROQ_API_KEY not set')

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
      throw new Error('Groq returned invalid JSON after retry')
    }
  }
}
