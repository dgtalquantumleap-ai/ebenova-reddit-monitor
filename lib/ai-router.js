// lib/ai-router.js — task-aware AI provider routing.
//
// Each named task declares its preferred provider. On failure (unavailable
// API key, cost-cap hit, network error, non-2xx), the router falls through
// to GROQ_QUALITY → GROQ_FAST → DEEPSEEK by default, or a per-task override.
// Every attempt is logged so a stalled task shows up in cycle logs immediately.
//
// Providers
//   GROQ_FAST       llama-3.1-8b-instant       cheap, fast — per-match work
//   GROQ_QUALITY    llama-3.3-70b-versatile    nuanced replies, default fallback
//   DEEPSEEK        deepseek-chat              long-form narrative summaries
//   CLAUDE          claude-sonnet-4-6          highest-quality structured output
//
// Cost caps are checked per provider before each attempt. The caller passes
// a `costCap(providerKey)` resolver that returns { allowed, used, max } for
// that provider — keeps the router decoupled from any specific cap store.
//
// Tests mock providers via `routeAIWithProviders(custom, args)`; production
// callers use the bare `routeAI(args)` which uses real provider impls.

import Anthropic from '@anthropic-ai/sdk'

// ── Routing table ───────────────────────────────────────────────────────────
// Single source of truth for which provider handles which task. Keys are
// the public task names callers pass to routeAI({ task }).
const TASK_ROUTING = {
  // Per-match runtime classification — speed > quality.
  classify_match:               'GROQ_FAST',
  // Builder Tracker topic extraction. groq-fast has 100% json_validate_failed
  // on this task; route to GROQ_QUALITY with DEEPSEEK fallback (see TASK_FALLBACK_OVERRIDES).
  extract_builder_topics:       'GROQ_QUALITY',
  // Post evaluation — intent classification + safe reply generation in one call.
  // Requires nuanced generation; GROQ_QUALITY provides the necessary capability.
  evaluate_post:                'GROQ_QUALITY',
  // Reply drafts — DeepSeek primary avoids burning Groq TPD (100k/day) on
  // draft generation; groq-fast is the fallback. See TASK_FALLBACK_OVERRIDES.
  generate_reply_draft:         'DEEPSEEK',
  // Premium "show off the best output" replies for high-stakes contexts —
  // e.g., the "Best lead this week" highlight in the weekly digest email.
  // Route through Claude for tone control on the one match per week the
  // user is most likely to act on.
  generate_premium_reply:       'CLAUDE',
  // Long-form pattern summaries (weekly digest, ICP, competitor threats) —
  // Deepseek's narrative quality at a fraction of the cost of Claude.
  weekly_pattern_summary:       'DEEPSEEK',
  // Strategic 5-bullet intelligence briefing for the weekly digest (PR #30).
  // Reads matches + author profiles + competitor matches and tells a busy
  // founder what to focus on next week.
  weekly_intelligence_briefing: 'DEEPSEEK',
  generate_icp:                 'DEEPSEEK',
  competitor_threat_summary:    'DEEPSEEK',
  // Customer-facing reports + LLM-mention research — Claude for tone control
  // and for accurate "what does the model say about this brand" tracking.
  generate_client_report:       'CLAUDE',
  check_ai_visibility:          'CLAUDE',
  generate_onboarding_keywords: 'CLAUDE',
}

// Always tried in this order if the preferred provider fails.
// DEEPSEEK is last: it's the safety net when both Groq models are rate-limited.
// Groq TPD (tokens/day) hits 100k on the free tier before our internal cap
// fires, so DeepSeek overflow saves classification + drafts from silently dying.
const FALLBACK_CHAIN = ['GROQ_QUALITY', 'GROQ_FAST', 'DEEPSEEK']

// Per-task fallback overrides. When present, replaces FALLBACK_CHAIN entirely
// for that task. Use to exclude a specific provider from a task's retry path.
const TASK_FALLBACK_OVERRIDES = {
  // groq-fast has 100% json_validate_failed on extract_builder_topics — skip it.
  extract_builder_topics: ['GROQ_QUALITY', 'DEEPSEEK'],
  // Draft generation: DeepSeek primary → groq-fast fallback.
  // groq-quality is excluded to preserve its 100k TPD for classification tasks.
  generate_reply_draft:   ['DEEPSEEK', 'GROQ_FAST'],
}

// ── Provider implementations ───────────────────────────────────────────────

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'

async function callGroqOnce({ apiKey, model, system, user, maxTokens, temperature, jsonMode }) {
  const body = {
    model,
    max_tokens: maxTokens || 1024,
    temperature: temperature ?? 0.7,
    messages: system
      ? [{ role: 'system', content: system }, { role: 'user', content: user }]
      : [{ role: 'user', content: user }],
  }
  if (jsonMode) body.response_format = { type: 'json_object' }
  const res = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  })
  if (!res.ok) {
    const e = await res.text().catch(() => '')
    const err = new Error(`Groq ${res.status}: ${e.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  const data = await res.json()
  return (data.choices?.[0]?.message?.content || '').trim()
}

async function callDeepseekOnce({ apiKey, baseUrl, model, system, user, maxTokens, temperature, jsonMode }) {
  const body = {
    model,
    max_tokens: maxTokens || 1024,
    temperature: temperature ?? 0.7,
    messages: system
      ? [{ role: 'system', content: system }, { role: 'user', content: user }]
      : [{ role: 'user', content: user }],
  }
  if (jsonMode) body.response_format = { type: 'json_object' }
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const e = await res.text().catch(() => '')
    const err = new Error(`Deepseek ${res.status}: ${e.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  const data = await res.json()
  return (data.choices?.[0]?.message?.content || '').trim()
}

let _anthropicClient = null
function getAnthropicClient(apiKey) {
  if (_anthropicClient) return _anthropicClient
  _anthropicClient = new Anthropic({ apiKey })
  return _anthropicClient
}

async function callClaudeOnce({ apiKey, model, system, user, maxTokens, temperature }) {
  const client = getAnthropicClient(apiKey)
  const resp = await client.messages.create({
    model,
    max_tokens: maxTokens || 1024,
    temperature: temperature ?? 0.7,
    ...(system ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : {}),
    messages: [{ role: 'user', content: user }],
  })
  return (resp.content?.[0]?.text || '').trim()
}

// ── Default provider catalog ────────────────────────────────────────────────

export const DEFAULT_PROVIDERS = {
  GROQ_FAST: {
    name: 'groq-fast',
    model: 'llama-3.1-8b-instant',
    available: () => !!process.env.GROQ_API_KEY,
    call: ({ system, prompt, maxTokens, temperature, jsonMode }) =>
      callGroqOnce({
        apiKey: process.env.GROQ_API_KEY,
        model: 'llama-3.1-8b-instant',
        system, user: prompt, maxTokens, temperature, jsonMode,
      }),
  },
  GROQ_QUALITY: {
    name: 'groq-quality',
    model: 'llama-3.3-70b-versatile',
    available: () => !!process.env.GROQ_API_KEY,
    call: ({ system, prompt, maxTokens, temperature, jsonMode }) =>
      callGroqOnce({
        apiKey: process.env.GROQ_API_KEY,
        model: 'llama-3.3-70b-versatile',
        system, user: prompt, maxTokens, temperature, jsonMode,
      }),
  },
  DEEPSEEK: {
    name: 'deepseek',
    model: 'deepseek-chat',
    available: () => !!process.env.DEEPSEEK_API_KEY,
    call: ({ system, prompt, maxTokens, temperature, jsonMode }) =>
      callDeepseekOnce({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
        model: 'deepseek-chat',
        system, user: prompt, maxTokens, temperature, jsonMode,
      }),
  },
  CLAUDE: {
    name: 'claude-sonnet-4-6',
    model: 'claude-sonnet-4-6',
    available: () => !!process.env.ANTHROPIC_API_KEY,
    // Anthropic doesn't expose response_format; jsonMode is silently ignored.
    // Tasks that need strict JSON should ask for "Return JSON only" in the prompt.
    call: ({ system, prompt, maxTokens, temperature }) =>
      callClaudeOnce({
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: 'claude-sonnet-4-6',
        system, user: prompt, maxTokens, temperature,
      }),
  },
}

// ── Router core ─────────────────────────────────────────────────────────────

function buildTryOrder(preferred, fallbackChain = FALLBACK_CHAIN) {
  const seen = new Set([preferred])
  const order = [preferred]
  for (const fallback of fallbackChain) {
    if (!seen.has(fallback)) {
      seen.add(fallback)
      order.push(fallback)
    }
  }
  return order
}

/**
 * Route an AI task using a custom provider catalog. Exported so tests can
 * inject mock providers without monkey-patching globals.
 *
 * @param {object} providers   provider catalog, same shape as DEFAULT_PROVIDERS
 * @param {object} args
 * @param {string}  args.task         task name (must be in TASK_ROUTING)
 * @param {string}  args.prompt       user message
 * @param {string}  [args.system]     system message (optional)
 * @param {number}  [args.maxTokens]  default 1024
 * @param {number}  [args.temperature] default 0.7
 * @param {boolean} [args.jsonMode]   request JSON-mode (Groq / Deepseek only — Claude ignores)
 * @param {Function} [args.costCap]   async (providerKey) => { allowed, used, max }
 * @returns {Promise<{ ok: boolean, text?: string, model?: string, providerKey?: string,
 *                     attempts: Array<{ provider, status, error?, detail? }>,
 *                     error?: string }>}
 */
export async function routeAIWithProviders(providers, { task, prompt, system, maxTokens, temperature, jsonMode, costCap }) {
  const preferred = TASK_ROUTING[task]
  if (!preferred) {
    return { ok: false, error: `unknown task: ${task}`, attempts: [] }
  }
  const fallbackChain = TASK_FALLBACK_OVERRIDES[task] || FALLBACK_CHAIN
  const tryOrder = buildTryOrder(preferred, fallbackChain)
  const attempts = []

  for (const providerKey of tryOrder) {
    const provider = providers[providerKey]
    if (!provider) {
      attempts.push({ provider: providerKey, status: 'unknown' })
      console.warn(`[ai-router] ${task}: ${providerKey} not in catalog`)
      continue
    }
    if (typeof provider.available === 'function' && !provider.available()) {
      attempts.push({ provider: providerKey, status: 'unavailable' })
      console.warn(`[ai-router] ${task}: ${providerKey} unavailable (missing API key)`)
      continue
    }
    if (typeof costCap === 'function') {
      try {
        const r = await costCap(providerKey)
        if (r && r.allowed === false) {
          attempts.push({ provider: providerKey, status: 'cost-cap', detail: `${r.used}/${r.max}` })
          console.warn(`[ai-router] ${task}: ${providerKey} cost cap hit (${r.used}/${r.max}), trying next`)
          continue
        }
      } catch (err) {
        // Cost-cap resolver itself failed — log and proceed (don't block on
        // a broken cost-cap store; the spec says "never fail silently" but
        // the cap layer is best-effort and shouldn't take down the task).
        console.warn(`[ai-router] ${task}: cost-cap resolver threw for ${providerKey}: ${err.message}`)
      }
    }
    try {
      const text = await provider.call({ system, prompt, maxTokens, temperature, jsonMode })
      attempts.push({ provider: providerKey, status: 'ok' })
      const tag = providerKey === preferred ? 'preferred' : 'fallback'
      console.log(`[ai-router] ${task} → ${provider.name} OK (${tag})`)
      return { ok: true, text, model: provider.name, providerKey, attempts }
    } catch (err) {
      attempts.push({ provider: providerKey, status: 'error', error: err.message })
      console.warn(`[ai-router] ${task} → ${provider.name} failed: ${err.message}`)
    }
  }
  return { ok: false, error: 'all providers failed', attempts }
}

// ── Default per-provider cost cap (FIX 3) ──────────────────────────────────
//
// Maps each provider catalog key to a Redis-backed cost-cap resource. The
// router calls `costCap(providerKey)` before each attempt and skips +
// falls through if the cap is hit.
//
// Resources:
//   GROQ_FAST + GROQ_QUALITY    → 'groq'             (existing, default 5000/day)
//   DEEPSEEK                    → 'deepseek'         (NEW, default 200/day)
//   CLAUDE                      → 'anthropic-router' (NEW, default 100/day)
//
// Why separate caps for Groq's two models: they share an account-level
// rate budget, so charging one bucket is correct.
//
// Why this lives in ai-router and not cost-cap: the resolver needs the
// providerKey → resource mapping, which is router-specific. lib/cost-cap.js
// remains a generic factory.

import { makeCostCap } from './cost-cap.js'
import { Redis } from '@upstash/redis'

const PROVIDER_TO_RESOURCE = {
  GROQ_FAST:    { resource: 'groq',             dailyMax: parseInt(process.env.GROQ_DAILY_MAX        || '5000') },
  GROQ_QUALITY: { resource: 'groq',             dailyMax: parseInt(process.env.GROQ_DAILY_MAX        || '5000') },
  DEEPSEEK:     { resource: 'deepseek',         dailyMax: parseInt(process.env.DEEPSEEK_DAILY_MAX    || '2000') },
  CLAUDE:       { resource: 'anthropic-router', dailyMax: parseInt(process.env.ANTHROPIC_DAILY_MAX   || '100')  },
}

let _defaultCapResolver = null
function getDefaultCostCap() {
  if (_defaultCapResolver) return _defaultCapResolver
  const url   = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    // No Redis configured (e.g. test env) — return a no-op resolver so the
    // router still works; caller can inject a fake costCap if they want.
    _defaultCapResolver = async () => ({ allowed: true })
    return _defaultCapResolver
  }
  const redis = new Redis({ url, token })
  const caps = {}
  for (const [providerKey, cfg] of Object.entries(PROVIDER_TO_RESOURCE)) {
    caps[providerKey] = makeCostCap(redis, cfg)
  }
  _defaultCapResolver = async (providerKey) => {
    const cap = caps[providerKey]
    if (!cap) return { allowed: true }
    return cap()
  }
  return _defaultCapResolver
}

/**
 * Route an AI task using the default real-provider catalog. Production entry
 * point. Wires the default per-provider Redis cost caps (groq, deepseek,
 * anthropic-router) unless the caller supplies their own `costCap`.
 */
export function routeAI(args) {
  const withCap = args.costCap == null
    ? { ...args, costCap: getDefaultCostCap() }
    : args
  return routeAIWithProviders(DEFAULT_PROVIDERS, withCap)
}

// Test-only exports for inspection without mocking.
export const _internals = { TASK_ROUTING, FALLBACK_CHAIN, TASK_FALLBACK_OVERRIDES, buildTryOrder, PROVIDER_TO_RESOURCE }
