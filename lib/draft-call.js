// lib/draft-call.js — Single entry point for reply draft generation.
//
// Honors DRAFT_PRIMARY env (groq | deepseek). Calls primary; on failure or
// AI-tell rejection, falls through to peer. Anthropic is intentionally NOT
// in this chain (drafts have always been Groq-only; we're adding Deepseek as
// a peer, not Anthropic as a fallback). Returns { draft, model } where draft
// is null if all providers failed or returned SKIP.
//
// Used by:
//   - api-server.js POST /v1/matches/draft (on-demand regen)
//   - monitor.js per-match background draft

import { buildDraftPrompt, validateDraft, stripMarkdown } from './draft-prompt.js'
import { callDeepseekText } from './llm/deepseek.js'

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'

async function callGroqText({ prompt, temperature }) {
  const key = process.env.GROQ_API_KEY
  if (!key) throw new Error('GROQ_API_KEY not set')
  const res = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 320,
      temperature: temperature ?? 0.8,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    const err = new Error(`Groq ${res.status}: ${errBody.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  const data = await res.json()
  return (data.choices?.[0]?.message?.content || '').trim()
}

const PROVIDERS = {
  groq: {
    name: 'groq',
    available: () => !!process.env.GROQ_API_KEY,
    call: ({ prompt, temperature }) => callGroqText({ prompt, temperature }),
  },
  deepseek: {
    name: 'deepseek',
    available: () => !!process.env.DEEPSEEK_API_KEY,
    // callDeepseekText takes (system, user) but our prompt is one piece — pass as user, no system
    call: ({ prompt, temperature }) => callDeepseekText({ user: prompt, temperature }),
  },
}

function buildChain() {
  const primary = (process.env.DRAFT_PRIMARY || 'groq').toLowerCase()
  const secondary = primary === 'deepseek' ? 'groq' : 'deepseek'
  return [PROVIDERS[primary], PROVIDERS[secondary]].filter(p => p && p.available())
}

// Single attempt against one provider. Handles SKIP, validateDraft, and a
// regen-with-stricter-prompt retry on AI-tell rejection. Final winning draft
// always passes through stripMarkdown to scrub any residual formatting (em
// dashes, stray asterisks) the model slipped past the prompt rules.
async function tryProvider(provider, prompt, { allowRegen = true } = {}) {
  let text
  try {
    text = await provider.call({ prompt, temperature: 0.8 })
  } catch (err) {
    return { ok: false, reason: 'call_failed', error: err.message }
  }
  if (!text || text === 'SKIP') return { ok: false, reason: 'skip_or_empty' }
  const v = validateDraft(text)
  if (v.ok) return { ok: true, draft: stripMarkdown(text) }
  // Regen path: catches both phrase-level AI tells AND formatting tells (em
  // dashes, bullets, headers). The model gets explicit feedback on what to
  // avoid this time. If regen still fails validation we'll try the peer.
  const isRegenable =
    v.reason === 'ai_tell' ||
    v.reason === 'em_dash_separator' ||
    v.reason === 'markdown'
  if (isRegenable && allowRegen) {
    const issue = v.matched || v.reason
    const stricter = prompt + `\n\nIMPORTANT: Your last attempt was rejected for using "${issue}". Rewrite as plain flowing sentences. No dashes as separators, no markdown, no bullets, no banned phrases. Use commas or periods between thoughts.`
    try {
      const text2 = await provider.call({ prompt: stricter, temperature: 0.7 })
      if (!text2 || text2 === 'SKIP') return { ok: false, reason: 'skip_after_regen' }
      const v2 = validateDraft(text2)
      if (v2.ok) return { ok: true, draft: stripMarkdown(text2) }
      return { ok: false, reason: `${v2.reason}_after_regen`, matched: v2.matched }
    } catch (err) {
      return { ok: false, reason: 'regen_failed', error: err.message }
    }
  }
  return { ok: false, reason: v.reason, matched: v.matched }
}

/**
 * Append UTM parameters to any URL in `draft` whose origin matches
 * `productUrl`'s origin. Third-party URLs (Reddit, GitHub, etc.) are left
 * untouched. URLs that already have a `utm_*` param are preserved as-is —
 * we never overwrite an explicit choice the user (or the model) put in.
 *
 * Returns the (possibly unchanged) draft string. Safe to call with
 * missing/invalid productUrl — returns the input untouched.
 *
 * @param {object} args
 * @param {string|null} args.draft
 * @param {string|null} args.productUrl  e.g. "https://acme.com" or "https://acme.com/pricing"
 * @param {string} [args.utmSource]      defaults to 'ebenova-insights'
 * @param {string} [args.utmMedium]      defaults to 'community'
 * @param {string} [args.utmCampaign]    no default — caller passes a slug or omits
 * @returns {string|null}
 */
export function injectUtm({ draft, productUrl, utmSource, utmMedium, utmCampaign }) {
  if (!draft || !productUrl) return draft
  let productOrigin
  try { productOrigin = new URL(productUrl).origin } catch (_) { return draft }

  const source   = utmSource   || 'ebenova-insights'
  const medium   = utmMedium   || 'community'
  const campaign = utmCampaign || ''

  // Match plain URLs in the draft. Stops at whitespace, common bracket / quote
  // chars, and trailing punctuation that's almost certainly not part of the URL.
  const urlPattern = /https?:\/\/[^\s)\]'"<>]+/g
  return draft.replace(urlPattern, (raw) => {
    // Strip trailing punctuation that's likely sentence-end, not URL.
    const trail = raw.match(/[.,;:!?]+$/)
    const cleanRaw = trail ? raw.slice(0, -trail[0].length) : raw
    let url
    try { url = new URL(cleanRaw) } catch (_) { return raw }
    if (url.origin !== productOrigin) return raw
    if (!url.searchParams.has('utm_source')   && source)   url.searchParams.set('utm_source', source)
    if (!url.searchParams.has('utm_medium')   && medium)   url.searchParams.set('utm_medium', medium)
    if (!url.searchParams.has('utm_campaign') && campaign) url.searchParams.set('utm_campaign', campaign)
    return url.toString() + (trail ? trail[0] : '')
  })
}

/**
 * Generate a reply draft using the configured provider chain.
 * @param {object} args
 * @param {string} args.title         post title
 * @param {string} args.body          post body
 * @param {string} args.subreddit     subreddit name
 * @param {string} args.productContext  user's product description
 * @param {string} [args.productName] optional product name
 * @param {string} [args.tone]        tone preset key (conversational | professional | empathetic | expert | playful)
 * @param {string} [args.productUrl]  if set, UTM params are appended to URLs in the draft whose origin matches
 * @param {string} [args.utmSource]   defaults to 'ebenova-insights'
 * @param {string} [args.utmMedium]   defaults to 'community'
 * @param {string} [args.utmCampaign] no default
 * @param {boolean} [args.competitorMode] if true, append the competitor-prompt addendum (PR #28)
 * @returns {Promise<{ draft: string|null, model: string|null }>}
 */
export async function draftCall({ title, body, subreddit, productContext, productName, tone, productUrl, utmSource, utmMedium, utmCampaign, competitorMode }) {
  let prompt = buildDraftPrompt({ title, body, subreddit, productContext, productName, tone })
  if (competitorMode) prompt += COMPETITOR_PROMPT_ADDITION
  const chain = buildChain()
  if (chain.length === 0) {
    return { draft: null, model: null }
  }
  for (const provider of chain) {
    const r = await tryProvider(provider, prompt)
    if (r.ok) {
      const draftWithUtm = injectUtm({ draft: r.draft, productUrl, utmSource, utmMedium, utmCampaign })
      return { draft: draftWithUtm, model: provider.name }
    }
    console.warn(`[draft-call] ${provider.name} → ${r.reason}${r.matched ? ` (${r.matched})` : ''}`)
  }
  return { draft: null, model: null }
}

// PR #28: competitor-mode prompt addendum. Appended to the prompt when
// the match came from a `type: 'competitor'` keyword. Goal: turn a match
// where the poster is unhappy with or evaluating a rival product into a
// softer founder-to-founder reply rather than a direct pitch.
const COMPETITOR_PROMPT_ADDITION = `

This person is unhappy with or evaluating a competitor product. Your reply must:
- Acknowledge their frustration without naming competitors
- Position an alternative naturally and helpfully
- Never say "our product" or use corporate language
- Sound like a founder or power user who switched, not a salesperson
- Maximum 3 sentences`

// Exported for tests
export const _internals = { PROVIDERS, buildChain, COMPETITOR_PROMPT_ADDITION }
