// lib/post-evaluator.js — Intent classification + safe reply generation for
// any inbound social post.
//
// One AI call (GROQ_QUALITY via ai-router) returns classification dimensions
// and a candidate reply. Code computes the freshness component, sums the
// score, and applies the ACCEPT/REJECT rules deterministically.
//
// Never throws — returns a REJECT result on any AI failure.

import { routeAI } from './ai-router.js'

// ── Scoring tables ────────────────────────────────────────────────────────────

const INTENT_SCORE = { HIRING: 4, BUYING: 3, SWITCHING: 2, RESEARCH: 1, NONE: 0 }
const URGENCY_SCORE = { explicit: 2, implied: 1, none: 0 }
const SPECIFICITY_SCORE = { clear: 2, partial: 1, vague: 0 }

export function computeScore({ intent_type, urgency, specificity, commercial_signal, postAgeMinutes }) {
  const A = INTENT_SCORE[intent_type]      ?? 0
  const B = URGENCY_SCORE[urgency]         ?? 0
  const C = SPECIFICITY_SCORE[specificity] ?? 0
  const D = commercial_signal ? 1 : 0
  const E = postAgeMinutes < 10 ? 1 : postAgeMinutes < 60 ? 0.5 : 0
  return A + B + C + D + E
}

function makeDecision({ score, intent_type, unsafe }) {
  if (unsafe)               return 'REJECT'
  if (intent_type === 'NONE') return 'REJECT'
  if (score < 7)            return 'REJECT'
  return 'ACCEPT'
}

function buildReason({ decision, score, intent_type, unsafe }) {
  if (unsafe)               return 'Community rules prohibit self-promotion in a reply'
  if (intent_type === 'NONE') return 'No clear buying intent or actionable problem statement'
  if (decision === 'REJECT') return `Score ${score.toFixed(1)} below 7.0 threshold (intent: ${intent_type})`
  return `${intent_type} intent with score ${score.toFixed(1)}`
}

// ── AI prompt ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a B2B sales intelligence engine. Analyze the social media post and return ONLY valid JSON — no markdown, no explanation.

Required fields:
{
  "intent_type": "HIRING|BUYING|SWITCHING|RESEARCH|NONE",
  "urgency": "explicit|implied|none",
  "specificity": "clear|partial|vague",
  "commercial_signal": true|false,
  "unsafe": true|false,
  "reply": "string or null"
}

INTENT (be conservative — default NONE):
HIRING=looking to hire a person for a task
BUYING=actively evaluating or ready to purchase a product/tool
SWITCHING=explicitly wants to leave their current solution
RESEARCH=gathering info before deciding, no immediate intent
NONE=venting only, no problem, no request, or academic discussion

URGENCY:
explicit=mentions deadline, ASAP, urgent, "right now", "today"
implied=has a clear problem to solve, no explicit time pressure
none=no urgency signals

SPECIFICITY:
clear=describes exact use case, constraints, or requirements
partial=mentions a domain but vague on needs
vague=could mean anything

COMMERCIAL SIGNAL (true if):
mentions budget/pricing/quotes, comparing products, posting a job/gig

UNSAFE (true if ANY of):
- community rules prohibit self-promotion AND a reply would require promoting a product
- community is for academic/research discussion only
- no request for a solution exists in the post

REPLY:
- null if unsafe=true OR intent_type=NONE
- Otherwise: 2-4 sentences, match user tone, reference exact problem, no hard sell, no links unless natural`

function buildPrompt({ platform, postText, communityRules }) {
  return `Platform: ${platform || 'unknown'}
Community rules: ${(communityRules || 'none specified').slice(0, 300)}

Post:
${String(postText || '').slice(0, 800)}`
}

// ── JSON extraction (mirrors classify.js pattern) ─────────────────────────────

function extractJSON(text) {
  if (!text || typeof text !== 'string') return null
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fence) { try { return JSON.parse(fence[1]) } catch {} }
  const start = text.indexOf('{')
  const end   = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch {}
  }
  try { return JSON.parse(text.trim()) } catch {}
  return null
}

const VALID_INTENTS     = new Set(['HIRING','BUYING','SWITCHING','RESEARCH','NONE'])
const VALID_URGENCIES   = new Set(['explicit','implied','none'])
const VALID_SPECIFICITY = new Set(['clear','partial','vague'])

function validateDimensions(obj) {
  if (!obj || typeof obj !== 'object') return null
  const intent_type       = String(obj.intent_type   || '').toUpperCase().trim()
  const urgency           = String(obj.urgency        || '').toLowerCase().trim()
  const specificity       = String(obj.specificity    || '').toLowerCase().trim()
  const commercial_signal = Boolean(obj.commercial_signal)
  const unsafe            = Boolean(obj.unsafe)
  const reply             = (typeof obj.reply === 'string' && obj.reply.trim()) ? obj.reply.trim() : null
  if (!VALID_INTENTS.has(intent_type))     return null
  if (!VALID_URGENCIES.has(urgency))       return null
  if (!VALID_SPECIFICITY.has(specificity)) return null
  return { intent_type, urgency, specificity, commercial_signal, unsafe, reply }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Evaluate a social post for buying intent and generate a safe reply.
 *
 * @param {object} args
 * @param {string} args.platform          e.g. 'reddit', 'twitter', 'linkedin'
 * @param {string} args.postText          full post body (title + body if available)
 * @param {number} [args.postAgeMinutes]  minutes since the post was published
 * @param {string} [args.communityRules]  subreddit/community rules for self-promo check
 * @returns {Promise<{
 *   decision: 'ACCEPT'|'REJECT',
 *   intent_type: string,
 *   score: number,
 *   unsafe: boolean,
 *   reason: string,
 *   reply: string|null
 * }>}
 */
export async function evaluatePost({ platform, postText, postAgeMinutes = 9999, communityRules = '' } = {}) {
  const REJECT_RESULT = (intent_type = 'NONE', score = 0, unsafe = false, reason = 'AI evaluation failed') => ({
    decision: 'REJECT', intent_type, score, unsafe, reason, reply: null,
  })

  if (!postText || !postText.trim()) {
    return REJECT_RESULT('NONE', 0, false, 'No post text provided')
  }

  let dims
  try {
    const r = await routeAI({
      task:        'evaluate_post',
      system:      SYSTEM_PROMPT,
      prompt:      buildPrompt({ platform, postText, communityRules }),
      maxTokens:   350,
      temperature: 0.2,
      jsonMode:    true,
    })
    if (!r.ok) {
      console.warn(`[post-evaluator] router failed: ${r.error || 'unknown'}`)
      return REJECT_RESULT()
    }
    dims = validateDimensions(extractJSON(r.text))
    if (!dims) {
      console.warn(`[post-evaluator] invalid AI response: ${String(r.text).slice(0, 120)}`)
      return REJECT_RESULT()
    }
  } catch (err) {
    console.warn(`[post-evaluator] unexpected error: ${err.message}`)
    return REJECT_RESULT()
  }

  const score    = computeScore({ ...dims, postAgeMinutes })
  const decision = makeDecision({ score, intent_type: dims.intent_type, unsafe: dims.unsafe })
  const reason   = buildReason({ decision, score, intent_type: dims.intent_type, unsafe: dims.unsafe })
  const reply    = decision === 'ACCEPT' ? dims.reply : null

  return { decision, intent_type: dims.intent_type, score, unsafe: dims.unsafe, reason, reply }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

export const _internals = {
  computeScore,
  makeDecision,
  buildReason,
  extractJSON,
  validateDimensions,
  VALID_INTENTS,
  VALID_URGENCIES,
  VALID_SPECIFICITY,
}
