// lib/variants-call.js — Generate 3 reply-style variants for a match.
//
// Used by POST /v1/matches/:id/variants.
// Single Groq call returns all three in JSON to minimise API round-trips.
// Falls back to null on any failure — callers must handle null gracefully.
//
// Variants:
//   valueHook    — lead with the outcome your product delivers
//   directBridge — direct "I'm building this" bridge to your product
//   empathy      — lead with understanding, then offer insight

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'
// Use the quality model for variants since they're shown to real prospects.
const GROQ_QUALITY_MODEL = process.env.GROQ_QUALITY_MODEL || 'llama-3.3-70b-versatile'
const TIMEOUT_MS = 20000

const SYSTEM_PROMPT = `You write short, genuine community replies. Each reply is 2-4 sentences, plain text, no markdown, no em dashes, no bullets, no "I hope this helps", no "Great question", no "As an AI". The reply should feel like a real person wrote it from experience.`

function buildVariantsPrompt({ title, body, productContext }) {
  return `Write 3 reply variants for this post. Return ONLY a JSON object — no markdown, no extra text.

Post title: ${title || '(none)'}
Post body: ${(body || '(none)').slice(0, 400)}
Product context: ${(productContext || '(none)').slice(0, 300)}

Return this exact shape:
{"valueHook":"...","directBridge":"...","empathy":"..."}

valueHook: Lead with the specific outcome your product delivers. Make it concrete (numbers, timeframes).
directBridge: Acknowledge their problem directly, then say you're building exactly this — offer early access or a quick chat.
empathy: Start by validating the frustration. Share what worked for you or others. Mention your product only if it fits naturally.`
}

function extractVariantsJSON(text) {
  if (!text) return null
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fence) { try { return JSON.parse(fence[1]) } catch {} }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch {}
  }
  try { return JSON.parse(text.trim()) } catch {}
  return null
}

function validateVariants(obj) {
  if (!obj || typeof obj !== 'object') return null
  const valueHook    = typeof obj.valueHook    === 'string' ? obj.valueHook.trim()    : null
  const directBridge = typeof obj.directBridge === 'string' ? obj.directBridge.trim() : null
  const empathy      = typeof obj.empathy      === 'string' ? obj.empathy.trim()      : null
  if (!valueHook && !directBridge && !empathy) return null
  return {
    valueHook:    valueHook    || '',
    directBridge: directBridge || '',
    empathy:      empathy      || '',
  }
}

/**
 * Generate 3 reply variants for a match.
 * @param {object} args
 * @param {string} args.title
 * @param {string} [args.body]
 * @param {string} [args.productContext]
 * @returns {Promise<{ valueHook: string, directBridge: string, empathy: string } | null>}
 */
export async function generateVariants({ title, body, productContext }) {
  const key = process.env.GROQ_API_KEY
  if (!key) return null
  if (!title) return null

  try {
    const res = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: GROQ_QUALITY_MODEL,
        max_tokens: 600,
        temperature: 0.8,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: buildVariantsPrompt({ title, body, productContext }) },
        ],
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`[variants-call] Groq ${res.status}`)
      return null
    }
    const data = await res.json()
    const text = data.choices?.[0]?.message?.content || ''
    return validateVariants(extractVariantsJSON(text))
  } catch (err) {
    console.warn(`[variants-call] error: ${err.message}`)
    return null
  }
}

export const _internals = { buildVariantsPrompt, extractVariantsJSON, validateVariants }
