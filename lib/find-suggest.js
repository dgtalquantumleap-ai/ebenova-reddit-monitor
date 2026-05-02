// lib/find-suggest.js — Orchestration for /v1/find/suggest
//   1. sanitize user input (defense against prompt injection)
//   2. call PRIMARY (Groq or Deepseek per SUGGEST_PRIMARY env)
//   3. fall through to SECONDARY peer, then Anthropic, then template
//   4. validate response shape via zod at each stage; first that passes wins

import { z } from 'zod'
import { sanitizeForPrompt } from './llm-safe-prompt.js'
import { callAnthropicJSON } from './llm/anthropic.js'
import { callGroqJSON } from './llm/groq.js'
import { callDeepseekJSON } from './llm/deepseek.js'
import { getSystemPrompt, getProfilePrompt } from './llm/prompts.js'
import { TEMPLATES } from './templates.js'

const ProfileSchema = z.object({
  category:             z.string().min(2).max(120),
  targetCustomer:       z.string().min(5).max(300),
  competitors:          z.array(z.string().min(1).max(60)).max(8),
  customerPainLanguage: z.array(z.string().min(2).max(100)).max(10),
  positioning:          z.string().max(300),
})

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

// Provider registry. Each entry knows how to call its model and whether its
// env var is configured. Order is determined by SUGGEST_PRIMARY at request time.
const PROVIDERS = {
  groq: {
    name: 'groq',
    available: () => !!process.env.GROQ_API_KEY,
    call: ({ system, user }) => callGroqJSON({ system, user }),
  },
  deepseek: {
    name: 'deepseek',
    available: () => !!process.env.DEEPSEEK_API_KEY,
    call: ({ system, user }) => callDeepseekJSON({ system, user }),
  },
}

// Best-effort product profile extraction — never throws, returns null on failure.
async function extractProfile({ safe, client }) {
  const system = getProfilePrompt()
  const user = `<user_business_description>\n${safe}\n</user_business_description>\n\nReturn the JSON object now.`
  for (const provider of buildChain()) {
    try {
      const result = await provider.call({ system, user })
      const v = ProfileSchema.safeParse(result)
      if (v.success) return v.data
      console.warn(`[find-suggest/profile] ${provider.name} schema invalid:`, v.error.message)
    } catch (err) {
      console.warn(`[find-suggest/profile] ${provider.name} failed:`, err.message)
    }
  }
  try {
    const result = await callAnthropicJSON({ client, system, user })
    const v = ProfileSchema.safeParse(result)
    if (v.success) return v.data
  } catch (err) {
    console.warn('[find-suggest/profile] Anthropic failed:', err.message)
  }
  return null
}

// Build the ordered chain: PRIMARY → peer → Anthropic
function buildChain() {
  const primary = (process.env.SUGGEST_PRIMARY || 'groq').toLowerCase()
  const secondary = primary === 'deepseek' ? 'groq' : 'deepseek'
  return [PROVIDERS[primary], PROVIDERS[secondary]].filter(p => p && p.available())
}

// Try primary → peer → Anthropic → throw INVALID_SCHEMA / propagate
async function callWithFallback({ system, user, client }) {
  for (const provider of buildChain()) {
    try {
      const result = await provider.call({ system, user })
      const v = SuggestionSchema.safeParse(result)
      if (v.success) return { result: v.data, model: provider.name }
      console.warn(`[find-suggest] ${provider.name} schema invalid, trying next:`, v.error.message)
    } catch (err) {
      console.warn(`[find-suggest] ${provider.name} call failed, trying next:`, err.message)
    }
  }
  // Last resort: Anthropic
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

  // Pass 1: extract product profile (best-effort — never blocks keyword gen)
  const profile = await extractProfile({ safe, client })
  if (profile) {
    console.log(`[find-suggest] profile: ${profile.category} · competitors: ${profile.competitors.join(', ') || 'none'}`)
  }

  // Pass 2: generate keywords enriched with profile context
  const system = getSystemPrompt(profile)
  const user = `<user_business_description>\n${safe}\n</user_business_description>\n\nReturn the JSON object now.`

  try {
    const { result, model } = await callWithFallback({ system, user, client })
    return { ...result, profile: profile || null, generatedBy: model }
  } catch (err) {
    const reason = err.code === 'INVALID_SCHEMA' ? 'invalid_schema' : 'api_error'
    console.warn(`[find-suggest] all providers failed (${reason}):`, err.message)
    return { ...pickFallbackTemplate(description), profile: null, fallback: true, fallbackReason: reason, generatedBy: 'template' }
  }
}
