// lib/draft-prompt.js — Builds the prompt sent to Groq for reply drafting.
//
// Single source of truth for both /v1/matches/draft and the background worker
// in monitor.js. Encodes a strict SKIP filter, four context-aware reply
// strategies, and an explicit ban-list for the most common AI tells.
//
// Why centralize: the background worker (monitor.js) had a far stronger prompt
// than the on-demand endpoint (api-server.js). This module unifies them and
// adds another layer of anti-AI-tell rules so drafts read as genuinely human.

import { sanitizeForPrompt } from './llm-safe-prompt.js'

// Phrases that immediately mark a reply as AI-generated. The model is told
// never to start with these AND never to use them as bridges.
const BANNED_PHRASES = [
  'I hope this helps',
  'Hope that helps',
  'Hope this helps',
  'Great question',
  'Excellent question',
  'I understand your frustration',
  'I completely understand',
  'Let me know if',
  'Feel free to',
  "Don't hesitate to",
  'In conclusion',
  'To summarize',
  'I would suggest',
  'I would recommend',
  'You should definitely',
  'It is important to note',
  'It is worth noting',
  'check out',
  'I recommend',
  'great tool',
  'you should try',
  'amazing tool',
  'super easy',
  'game-changer',
  'game changer',
]

// Subreddits where any product mention typically gets removed or downvoted.
// In these subs we instruct the model to use Strategy C (helpful, no mention).
const SENSITIVE_SUBREDDITS = new Set([
  'teachers', 'freelance', 'antiwork', 'jobs', 'cscareerquestions',
  'personalfinance', 'legaladvice', 'relationships', 'relationshipadvice',
])

export function isSensitiveSubreddit(subreddit) {
  if (!subreddit) return false
  return SENSITIVE_SUBREDDITS.has(String(subreddit).toLowerCase().trim())
}

// Tone presets — surfaced in the dashboard so users can pick a voice that
// matches their brand. Each preset injects a short instruction into the prompt.
// Add more here without touching downstream code.
export const TONE_PRESETS = {
  conversational: 'casual, direct, like talking to a friend in a coffee shop',
  professional:   'polite and clear, neither stiff nor casual — the way a senior consultant writes a Slack message',
  empathetic:     'warm and patient — acknowledge their situation before answering',
  expert:         'confident and specific, name concrete tactics and numbers; no hedging',
  playful:        'light and clever, comfortable with a joke if the post invites one — never sarcastic',
}

export function resolveTone(tone) {
  const key = (tone || 'conversational').toString().toLowerCase().trim()
  return TONE_PRESETS[key] || TONE_PRESETS.conversational
}

/**
 * Strip leftover markdown / AI-tell formatting from a generated draft.
 * Catches the patterns the model slips through despite prompt rules.
 *
 * Removes: leading bullet markers, headers (#), bold/italic markers, inline
 *   backticks, blockquotes (>), and collapses runs of 3+ blank lines.
 * Replaces: em-dashes ( — ) and en-dashes ( – ) used as separators with commas
 *   (most common AI-tell complaint).
 * Preserves: hyphens inside compound words ("on-demand", "month-end").
 */
export function stripMarkdown(text) {
  if (!text || typeof text !== 'string') return text
  return text
    // Bullets / list markers at line start
    .replace(/^\s*[-*•]\s+/gm, '')
    // Numbered list markers
    .replace(/^\s*\d+\.\s+/gm, '')
    // Markdown headers
    .replace(/^#{1,6}\s+/gm, '')
    // Blockquotes
    .replace(/^>\s+/gm, '')
    // Bold (**word**) and italic (*word* / _word_)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<![a-zA-Z0-9])\*([^*\n]+)\*(?![a-zA-Z0-9])/g, '$1')
    .replace(/(?<![a-zA-Z0-9])_([^_\n]+)_(?![a-zA-Z0-9])/g, '$1')
    // Inline code backticks
    .replace(/`([^`]+)`/g, '$1')
    // Em/en dashes used as sentence separators (with surrounding spaces).
    // Keeps hyphens inside compound words intact.
    .replace(/\s+[—–]\s+/g, ', ')
    // Two-or-more spaces collapse to one
    .replace(/[ \t]{2,}/g, ' ')
    // Three+ blank lines collapse to two
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Build a Groq draft prompt.
 * @param {object} args
 * @param {string} args.title       Post title (raw or sanitized — we sanitize inside)
 * @param {string} args.body        Post body
 * @param {string} args.subreddit   e.g. "freelance" (no r/ prefix needed; we strip if given)
 * @param {string} args.productContext  1-3 sentence description of the user's product / who they help
 * @param {string} [args.productName]   Optional product name. If omitted, mentions read as "the tool I use"
 * @param {string} [args.tone]      One of TONE_PRESETS keys (default 'conversational')
 * @returns {string} fully formed prompt ready to POST as the Groq user message
 */
export function buildDraftPrompt({ title, body, subreddit, productContext, productName, tone }) {
  const safeTitle = sanitizeForPrompt(title || '')
  const safeBody = sanitizeForPrompt(body || '(none)')
  const safeSub = sanitizeForPrompt(String(subreddit || '').replace(/^r\//, ''))
  const safeContext = sanitizeForPrompt(productContext || '')
  const safeProduct = productName ? sanitizeForPrompt(productName) : 'the tool I use for this'
  const productRef = productName ? safeProduct : 'it'

  const sensitivityHint = isSensitiveSubreddit(safeSub)
    ? `\n⚠ NOTE: r/${safeSub} is a community where product mentions typically get removed. Default to Strategy C unless the post explicitly asks "what tool/app/software should I use".`
    : ''

  const banList = BANNED_PHRASES.map(p => `"${p}"`).join(', ')
  const toneInstruction = resolveTone(tone)

  return `You are a real person on Reddit who has direct experience with the topic below. You are NOT a marketer. You occasionally mention tools when they directly solve someone's exact problem, but only when it would feel natural in a real conversation.

YOUR VOICE: ${toneInstruction}

YOUR EXPERTISE AREA: ${safeContext}

REDDIT POST:
Title: ${safeTitle}
Subreddit: r/${safeSub}
Body: ${safeBody}${sensitivityHint}

━━━ STEP 1: SKIP FILTER (check ALL of these) ━━━
Respond ONLY with the word SKIP if ANY are true:
- Post is emotional, relational, or about a person — not a task or tool problem
- Person is venting, celebrating, joking, or seeking validation
- Keyword matched incidentally (e.g. "share" in social sense, not tech sense)
- Post is in a sensitive subreddit AND the post does not explicitly ask "what tool/app/software should I use"
- The problem is already solved in the thread
- The post is more than 48 hours old (likely buried)

━━━ STEP 2: CHOOSE YOUR REPLY STRATEGY ━━━
If the post passes Step 1, choose ONE strategy:

STRATEGY A — "Genuine Advice First, Tool Optional"
Use when: Person has a problem, not asking for a tool specifically.
Structure: Give 2-3 sentences of real, actionable advice. Only mention ${productRef} if it's the single most natural solution — phrase it as "I've used [thing] for this" not "check out [thing]". If mentioning feels forced, don't mention it at all.

STRATEGY B — "Direct Answer to Tool Request"
Use when: Person explicitly asks "what app/tool/software" for this.
Structure: Answer directly. Name ${productRef} as one option among others. Include one specific reason it fits their situation. Keep it under 4 sentences.

STRATEGY C — "Helpful Comment, No Product Mention"
Use when: Sensitive subreddit OR product mention would feel like an ad.
Structure: Write a genuinely helpful 2-3 sentence reply with real advice. Do NOT mention ${productRef} at all.

STRATEGY D — "Empathy Then Practical Step"
Use when: Person is frustrated (client won't pay, scope creep, broken process).
Structure: One sentence acknowledging the frustration. Then one concrete next step. Only mention ${productRef} if it directly enables that next step.

━━━ REPLY RULES (apply to all strategies) ━━━
- Write like a real Reddit user: ${toneInstruction}
- LENGTH MATCHING: short post → short reply. 1-line post → 1-2 sentence reply max. Long post → up to 4 sentences.
- NEVER USE these phrases (they scream "AI wrote this"): ${banList}
- If mentioning ${productRef}: use "I use" or "there's a thing called" or "I've been using" — never "check out" or "I recommend"
- Never mention a URL unless the person explicitly asked for links
- Vary your opening — do NOT start with "I", "Hey", "Hi", "Great", "Yeah" every time
- Be specific, not generic. Name a concrete example, tactic, or number when possible.
- Don't apologize for the situation. Don't sign off with niceties.

━━━ STRICT FORMATTING RULES ━━━
PLAIN TEXT ONLY. The output must look like a regular Reddit comment, not a structured doc.
- ZERO markdown — no asterisks, no underscores, no backticks, no pound signs.
- ZERO bullet points or numbered lists. Write in flowing sentences only.
- ZERO em-dashes (—) or en-dashes (–) as sentence separators. Use a comma or period instead. Hyphens inside words ("on-demand", "month-end") are fine.
- ZERO preamble. Do NOT start with "Honestly," "Look," "Here's the thing," "So," or similar AI-tell openers.
- ZERO sign-off. No "Hope it helps", no "Let me know", no signature.

Respond with SKIP or the reply text only. No labels, no strategy name, no explanation, no quotation marks around the reply.`
}

/**
 * Quick sanity check on a generated draft to catch obvious AI tells before storing.
 * Returns { ok, reason }. After this, the caller should also run stripMarkdown
 * to clean up any residual formatting that slipped past the model.
 */
export function validateDraft(draft) {
  if (!draft || typeof draft !== 'string') return { ok: false, reason: 'empty' }
  const trimmed = draft.trim()
  if (trimmed === 'SKIP' || trimmed.length < 10) return { ok: false, reason: 'too_short_or_skip' }
  // Check for banned phrases (case-insensitive)
  const lower = trimmed.toLowerCase()
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase.toLowerCase())) {
      return { ok: false, reason: 'ai_tell', matched: phrase }
    }
  }
  // Markdown / formatting tells. We catch these here AND scrub them after — so
  // the "regen with stricter prompt" path fires when the model is being lazy,
  // but we don't lose an otherwise-good draft to a single stray asterisk.
  if (/^\s*[-*•]\s/m.test(trimmed))   return { ok: false, reason: 'markdown', matched: 'list bullet' }
  if (/^\s*\d+\.\s/m.test(trimmed))   return { ok: false, reason: 'markdown', matched: 'numbered list' }
  if (/^#{1,6}\s/m.test(trimmed))     return { ok: false, reason: 'markdown', matched: 'header' }
  if (/\*\*[^*]+\*\*/.test(trimmed))  return { ok: false, reason: 'markdown', matched: 'bold' }
  if (/`[^`\n]+`/.test(trimmed))      return { ok: false, reason: 'markdown', matched: 'inline code' }
  // Em-dash / en-dash used as a sentence separator (with surrounding spaces).
  // The audit prompt called these out explicitly as the visible AI-tell.
  if (/\s[—–]\s/.test(trimmed))       return { ok: false, reason: 'em_dash_separator', matched: 'em-dash separator' }
  return { ok: true }
}

// Exported for tests
export const _internals = { BANNED_PHRASES, SENSITIVE_SUBREDDITS }
