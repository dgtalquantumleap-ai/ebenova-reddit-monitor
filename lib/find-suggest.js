// lib/find-suggest.js — Orchestration for /v1/find/suggest
//   1. sanitize user input (defense against prompt injection)
//   2. call Anthropic with prompt-cached system + delimited user
//   3. validate response shape via zod
//   4. fall back to template if validation or call fails

import { z } from 'zod'
import { sanitizeForPrompt } from './llm-safe-prompt.js'
import { callAnthropicJSON } from './llm/anthropic.js'
import { callGroqJSON } from './llm/groq.js'
import { getSystemPrompt } from './llm/prompts.js'
import { TEMPLATES } from './templates.js'

const SuggestionSchema = z.object({
  suggestedName: z.string().min(3).max(80),
  productContext: z.string().min(10).max(2000),
  keywords: z.array(z.object({
    keyword: z.string().min(2).max(80),
    intentType: z.enum(['buying', 'pain', 'comparison', 'question']),
    confidence: z.enum(['high', 'medium', 'low']),
  })).min(4).max(25),
  subreddits: z.array(z.string()).min(1).max(15),
  platforms: z.array(z.enum(['reddit', 'hackernews', 'quora', 'medium', 'substack', 'upwork', 'fiverr', 'github', 'producthunt'])).min(1).max(9),
})

export function validateSuggestion(obj) {
  return SuggestionSchema.safeParse(obj)
}

function pickFallbackTemplate(description) {
  const d = (description || '').toLowerCase()
  if (/saas|software|product|app/.test(d)) return TEMPLATES.saas
  if (/freelanc|design|developer/.test(d)) return TEMPLATES.freelancer
  if (/agenc|consultancy/.test(d)) return TEMPLATES.agency
  if (/coach|consult|mentor/.test(d)) return TEMPLATES.coach
  if (/course|teach|tutorial/.test(d)) return TEMPLATES.course
  if (/ecommerce|store|brand/.test(d)) return TEMPLATES.ecommerce
  if (/local|near me|city|town/.test(d)) return TEMPLATES.local
  return TEMPLATES.other
}

// Try Groq first (≈10x cheaper than Anthropic), fall through to Anthropic on
// failure or schema rejection, then to template gallery as last resort.
async function callWithFallback({ system, user, client }) {
  if (process.env.GROQ_API_KEY) {
    try {
      const result = await callGroqJSON({ system, user })
      const v = SuggestionSchema.safeParse(result)
      if (v.success) return { result: v.data, model: 'groq' }
      console.warn('[find-suggest] Groq schema invalid, trying Anthropic:', v.error.message)
    } catch (err) {
      console.warn('[find-suggest] Groq call failed, trying Anthropic:', err.message)
    }
  }
  const result = await callAnthropicJSON({ client, system, user })
  const v = SuggestionSchema.safeParse(result)
  if (!v.success) {
    const err = new Error('Anthropic schema invalid: ' + v.error.message)
    err.code = 'INVALID_SCHEMA'
    throw err
  }
  return { result: v.data, model: 'anthropic' }
}

export async function suggestKeywords({ description, client }) {
  const safe = sanitizeForPrompt(description)
  if (!safe || safe.length < 20) {
    throw new Error('Description too short')
  }

  const system = getSystemPrompt()
  const user = `<user_business_description>\n${safe}\n</user_business_description>\n\nReturn the JSON object now.`

  try {
    const { result } = await callWithFallback({ system, user, client })
    return result
  } catch (err) {
    const reason = err.code === 'INVALID_SCHEMA' ? 'invalid_schema' : 'api_error'
    console.warn(`[find-suggest] both LLMs failed (${reason}):`, err.message)
    return { ...pickFallbackTemplate(description), fallback: true, fallbackReason: reason }
  }
}
