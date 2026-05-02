// lib/classify.js — Fast, cheap sentiment + intent classification for matches.
//
// Runs immediately after a post is matched, before draft generation. The
// classification fields (sentiment, intent, confidence) drive priority
// sorting in alert emails and the dashboard so high-value signals
// (asking_for_tool, buying) surface above venting/recommending.
//
// Design choices:
//   - llama-3.1-8b-instant (NOT 70b) — this is classification, not generation.
//     8b is ~10x cheaper and easily fast enough.
//   - max_tokens: 60 — we only need a small JSON object back.
//   - Best-effort: classifyMatch() NEVER throws. Returns null on any failure
//     (API down, malformed JSON, unknown enum, cost cap hit). Callers must
//     handle null gracefully — classification failure must never block a
//     match from being stored or emailed.
//   - Cached: same post matched by multiple keywords pays for one API call.
//
// Used by:
//   - monitor-v2.js runMonitor() per-cycle classification batch
//   - api-server.js POST /v1/matches/draft on-demand backfill

import { createHash } from 'crypto'

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_CLASSIFY_MODEL = 'llama-3.1-8b-instant'
const MAX_TOKENS = 120
const TIMEOUT_MS = 8000

// Valid enum values — anything else from the model is treated as a parse failure.
const VALID_SENTIMENTS = new Set(['positive', 'negative', 'neutral', 'frustrated', 'questioning'])
const VALID_INTENTS = new Set(['buying', 'complaining', 'researching', 'venting', 'recommending', 'asking_for_tool'])
const VALID_CONFIDENCES = new Set(['high', 'medium', 'low'])

const SYSTEM_PROMPT = `You are a text classifier. Analyze the social media post and respond with ONLY a valid JSON object — no markdown, no explanation, no preamble. Format:
{"sentiment":"<value>","intent":"<value>","confidence":"<value>","relevanceScore":<number 0.0-1.0>,"demandScore":<integer 1-10>}`

function userPrompt({ title, body, source, keyword, productContext }) {
  return `Classify this post.

SENTIMENT — pick exactly one:
- positive: upbeat, satisfied, enthusiastic
- negative: critical, unhappy, disappointed
- neutral: informational, matter-of-fact
- frustrated: angry, venting, at-wit's-end
- questioning: asking for help, genuinely unsure

INTENT — pick exactly one:
- buying: actively evaluating or ready to purchase a solution
- asking_for_tool: explicitly asking "what tool/app/software" for a problem
- complaining: expressing dissatisfaction, not necessarily looking for a fix
- researching: gathering information before deciding
- venting: emotional release, not seeking a solution
- recommending: sharing something that worked for them

RELEVANCE_SCORE — float 0.0 to 1.0:
1.0 = directly about the keyword/context, 0.0 = completely unrelated topic
${keyword ? `Keyword being monitored: "${keyword}"` : ''}
${productContext ? `Product context: ${productContext.slice(0, 200)}` : ''}

DEMAND_SCORE — integer 1 to 10:
8-10: explicit buying/tool-seeking intent
5-7: researching or frustrated with current solution
1-4: general discussion, venting, tangentially related

Title: ${title || ''}
Body: ${body ? body.slice(0, 400) : '(none)'}
Source: ${source || 'unknown'}`
}

// ── Cache ────────────────────────────────────────────────────────────────────
// Same post matched by multiple keywords (e.g. "freelance contract" AND
// "unpaid invoice" hit on the same Reddit post) should pay for one API call.
// Soft LRU: when size exceeds 2000, drop the oldest 500. Map iterates in
// insertion order so the first keys are the oldest. Same pattern as
// embeddingCache in monitor-v2.js.
//
// Lifetime / TTL behavior:
//   - In-memory only — cleared on every worker process restart (Railway
//     redeploys, manual restarts, OOM crashes). Effective TTL = uptime.
//   - On the SaaS worker (monitor-v2.js) running 24/7 with a 10-min cron,
//     uptime is typically days-to-weeks between deploys. The 2000-entry
//     soft-LRU cap is the binding limit, not time.
//   - If a Reddit author edits a post's title or body, the sha1(title +
//     body[:100]) cache key changes, so the edited version is reclassified
//     automatically on next match. No stale-sentiment risk from edits.
//   - We deliberately do NOT use Redis here. Classification is cheap
//     (~$0.05 per 1000 matches at llama-3.1-8b-instant pricing) and
//     repeated classifies of identical content are rare in practice.

const _cache = new Map()
const CACHE_MAX = 2000
const CACHE_PRUNE = 500

function cacheKey({ title, body }) {
  // Hash full title + first 100 chars of body. Posts with same title but
  // wildly different bodies still get distinct cache entries.
  const h = createHash('sha1')
  h.update(String(title || ''))
  h.update('|')
  h.update(String(body || '').slice(0, 100))
  return h.digest('hex').slice(0, 24)
}

function cacheGet(key) {
  return _cache.has(key) ? _cache.get(key) : null
}

function cacheSet(key, value) {
  _cache.set(key, value)
  if (_cache.size > CACHE_MAX) {
    let i = 0
    for (const k of _cache.keys()) {
      if (i++ >= CACHE_PRUNE) break
      _cache.delete(k)
    }
  }
}

// Exported for tests so they can verify cache behavior + reset between cases
export function _resetCache() {
  _cache.clear()
}

// ── JSON parsing ─────────────────────────────────────────────────────────────
// Models occasionally wrap JSON in code fences or prose despite the prompt.
// Try fenced first, then bare-JSON extraction, then plain parse.

function extractJSON(text) {
  if (!text || typeof text !== 'string') return null
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

function validateClassification(obj) {
  if (!obj || typeof obj !== 'object') return null
  const sentiment = String(obj.sentiment || '').toLowerCase().trim()
  const intent    = String(obj.intent    || '').toLowerCase().trim()
  const confidence = String(obj.confidence || '').toLowerCase().trim()
  if (!VALID_SENTIMENTS.has(sentiment)) return null
  if (!VALID_INTENTS.has(intent)) return null
  // Confidence is required per spec, but be lenient: default to 'medium' if
  // the model omits it rather than throwing the whole classification away.
  const conf = VALID_CONFIDENCES.has(confidence) ? confidence : 'medium'
  // relevanceScore and demandScore — default to neutral values if missing/invalid
  let relevanceScore = 0.5
  let demandScore    = 3
  try {
    const rs = parseFloat(obj.relevanceScore)
    if (Number.isFinite(rs) && rs >= 0 && rs <= 1) relevanceScore = Math.round(rs * 100) / 100
    const ds = parseInt(obj.demandScore, 10)
    if (Number.isFinite(ds) && ds >= 1 && ds <= 10) demandScore = ds
  } catch (_) { /* keep defaults */ }
  return { sentiment, intent, confidence: conf, relevanceScore, demandScore }
}

// ── Cost cap ─────────────────────────────────────────────────────────────────
// Optional injected cap function: if callers want to gate classification
// by daily Groq spend, they pass a checker that returns { allowed, used, max }.
// When the cap is hit we return null immediately — classification is lower
// priority than drafting and should never push us over budget.

/**
 * Classify a post's sentiment + intent + relevance.
 *
 * @param {object} args
 * @param {string} args.title
 * @param {string} [args.body]
 * @param {string} [args.source]
 * @param {string} [args.keyword]         the keyword that matched this post
 * @param {string} [args.productContext]  monitor's product context for relevance scoring
 * @param {function} [args.costCapCheck]  optional async () => { allowed: bool }
 * @returns {Promise<{ sentiment: string, intent: string, confidence: string, relevanceScore: number, demandScore: number } | null>}
 */
export async function classifyMatch({ title, body, source, keyword, productContext, costCapCheck } = {}) {
  if (!title) return null

  // Cache hit?
  const ck = cacheKey({ title, body })
  const cached = cacheGet(ck)
  if (cached !== null) return cached

  // Cost cap?
  if (typeof costCapCheck === 'function') {
    try {
      const r = await costCapCheck()
      if (r && r.allowed === false) {
        // Don't cache the negative — we want to retry next cycle when budget refills.
        return null
      }
    } catch (_) { /* if cap check itself fails, allow through */ }
  }

  // Need a key
  const key = process.env.GROQ_API_KEY
  if (!key) return null

  let text
  try {
    const res = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: GROQ_CLASSIFY_MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0,            // deterministic — same input → same classification
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userPrompt({ title, body, source, keyword, productContext }) },
        ],
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`[classify] Groq ${res.status} for "${String(title).slice(0, 50)}…"`)
      return null
    }
    const data = await res.json()
    text = data.choices?.[0]?.message?.content || ''
  } catch (err) {
    console.warn(`[classify] fetch error: ${err.message}`)
    return null
  }

  const parsed = extractJSON(text)
  const validated = validateClassification(parsed)
  if (!validated) {
    console.warn(`[classify] invalid response for "${String(title).slice(0, 50)}…": ${String(text).slice(0, 100)}`)
    return null
  }

  cacheSet(ck, validated)
  return validated
}

// ── Priority utilities ───────────────────────────────────────────────────────
// Lower number = higher priority. Used to sort matches before storage + email.
// 'asking_for_tool' is the explicit "I want a solution" signal — surface first.
// 'buying' is "I'm evaluating" — second.
// 'venting' is the lowest-value signal but still worth surfacing.

export const INTENT_PRIORITY = {
  asking_for_tool: 0,
  buying:          1,
  researching:     2,
  complaining:     3,
  recommending:    4,
  venting:         5,
}

// Bucket null/missing intent at the end. Used by monitor-v2.js + api-server.js.
export const INTENT_PRIORITY_FALLBACK = 6

export function intentPriority(intent) {
  if (intent == null) return INTENT_PRIORITY_FALLBACK
  return INTENT_PRIORITY[intent] ?? INTENT_PRIORITY_FALLBACK
}

// Posts with these intents are "high value" — what marketers care most about.
const HIGH_VALUE_INTENTS = new Set(['asking_for_tool', 'buying'])

/**
 * Should this match get the 🔥 HIGH PRIORITY badge?
 *
 * Rule: high-value intent (asking_for_tool / buying) AND sentiment is not
 * 'venting'. The sentiment guard prevents false positives where a user is
 * angrily ranting in the form of a question that scored as buying intent.
 *
 * Note: 'venting' is technically an intent value, not a sentiment value —
 * but the spec says "sentiment not 'venting'", so we conservatively check
 * sentiment-against-venting just in case the model emits that string in
 * the wrong field.
 */
export function isHighPriority(match) {
  if (!match || !HIGH_VALUE_INTENTS.has(match.intent)) return false
  if (match.sentiment === 'venting') return false  // see note above
  return true
}

// Test helpers
export const _internals = {
  VALID_SENTIMENTS, VALID_INTENTS, VALID_CONFIDENCES,
  HIGH_VALUE_INTENTS,
  cacheKey,
  extractJSON, validateClassification,
}
