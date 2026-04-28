// lib/find-suggest.js — Orchestration for /v1/find/suggest
//   1. sanitize user input (defense against prompt injection)
//   2. call Anthropic with prompt-cached system + delimited user
//   3. validate response shape via zod
//   4. fall back to template if validation or call fails

import { z } from 'zod'
import { sanitizeForPrompt } from './llm-safe-prompt.js'
import { callAnthropicJSON } from './llm/anthropic.js'
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

export async function suggestKeywords({ description, client }) {
  const safe = sanitizeForPrompt(description)
  if (!safe || safe.length < 20) {
    throw new Error('Description too short')
  }

  const system = getSystemPrompt()
  const user = `<user_business_description>\n${safe}\n</user_business_description>\n\nReturn the JSON object now.`

  let result
  try {
    result = await callAnthropicJSON({ client, system, user })
  } catch (err) {
    console.warn('[find-suggest] Anthropic call failed, falling back:', err.message)
    return { ...pickFallbackTemplate(description), fallback: true, fallbackReason: 'api_error' }
  }

  const validation = SuggestionSchema.safeParse(result)
  if (!validation.success) {
    console.warn('[find-suggest] schema validation failed, falling back:', validation.error.message)
    return { ...pickFallbackTemplate(description), fallback: true, fallbackReason: 'invalid_schema' }
  }

  return validation.data
}
