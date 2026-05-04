// lib/draft-call.js — Reply draft generation, routing through ai-router.
//
// Provider selection and fallback order are inherited from ai-router's
// generate_reply_draft task (GROQ_QUALITY → GROQ_FAST → DEEPSEEK). This
// keeps draft generation in sync with the same chain used by every other
// AI task — cost caps, availability checks, and fallback ordering are all
// managed in one place.
//
// Draft-specific logic (validateDraft, regen-on-AI-tell, UTM injection)
// lives here; transport is fully delegated to the router.

import { buildDraftPrompt, validateDraft, stripMarkdown } from './draft-prompt.js'
import { DEFAULT_PROVIDERS, _internals as _routerInternals } from './ai-router.js'

// Build the provider list by reading ai-router's try-order for this task.
// If the router's fallback chain changes (e.g. a new provider is added),
// drafts automatically follow suit — no change needed here.
function buildChain() {
  const preferredKey = _routerInternals.TASK_ROUTING['generate_reply_draft']
  return _routerInternals
    .buildTryOrder(preferredKey)
    .map(k => DEFAULT_PROVIDERS[k])
    .filter(p => p && typeof p.available === 'function' && p.available())
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
 * untouched. URLs that already have a `utm_*` param are preserved as-is.
 */
export function injectUtm({ draft, productUrl, utmSource, utmMedium, utmCampaign }) {
  if (!draft || !productUrl) return draft
  let productOrigin
  try { productOrigin = new URL(productUrl).origin } catch (_) { return draft }

  const source   = utmSource   || 'ebenova-insights'
  const medium   = utmMedium   || 'community'
  const campaign = utmCampaign || ''

  const urlPattern = /https?:\/\/[^\s)\]'"<>]+/g
  return draft.replace(urlPattern, (raw) => {
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
 * Generate a reply draft using the ai-router provider chain.
 * @param {object} args
 * @param {string} args.title
 * @param {string} args.body
 * @param {string} args.subreddit
 * @param {string} args.productContext
 * @param {string} [args.productName]
 * @param {string} [args.tone]
 * @param {string} [args.productUrl]
 * @param {string} [args.utmSource]
 * @param {string} [args.utmMedium]
 * @param {string} [args.utmCampaign]
 * @param {boolean} [args.competitorMode]
 * @returns {Promise<{ draft: string|null, model: string|null }>}
 */
export async function draftCall({ title, body, subreddit, productContext, productName, tone, productUrl, utmSource, utmMedium, utmCampaign, competitorMode }) {
  let prompt = buildDraftPrompt({ title, body, subreddit, productContext, productName, tone })
  if (competitorMode) prompt += COMPETITOR_PROMPT_ADDITION
  const chain = buildChain()
  if (chain.length === 0) return { draft: null, model: null }
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

/**
 * Find the first UTM-injected product URL in a draft.
 */
export function extractInjectedUtmUrl({ draft, productUrl }) {
  if (!draft || !productUrl) return null
  let productOrigin
  try { productOrigin = new URL(productUrl).origin } catch (_) { return null }
  const urlPattern = /https?:\/\/[^\s)\]'"<>]+/g
  const matches = draft.match(urlPattern) || []
  for (const raw of matches) {
    const trail = raw.match(/[.,;:!?]+$/)
    const cleanRaw = trail ? raw.slice(0, -trail[0].length) : raw
    let url
    try { url = new URL(cleanRaw) } catch (_) { continue }
    if (url.origin !== productOrigin) continue
    if (!url.searchParams.has('utm_source')) continue
    return url.toString()
  }
  return null
}

const COMPETITOR_PROMPT_ADDITION = `

This person is unhappy with or evaluating a competitor product. Your reply must:
- Acknowledge their frustration without naming competitors
- Position an alternative naturally and helpfully
- Never say "our product" or use corporate language
- Sound like a founder or power user who switched, not a salesperson
- Maximum 3 sentences`

export const _internals = { buildChain, COMPETITOR_PROMPT_ADDITION }
