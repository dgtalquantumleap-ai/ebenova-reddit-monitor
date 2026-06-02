// lib/monitor-quality.js — creation-time monitor quality enforcement.
//
// This is the onboarding GUARDRAIL, not a runtime relevance filter. It stops
// identity-free / single-generic-token monitors ("Youth", "I advocate") from
// ever entering the system, where no downstream gate can rescue them — a
// multiplier fix (polysemy/inversion drop naturally when inputs are sane).
//
// Design principles:
//   - Deterministic, conservative. Rejects only UNAMBIGUOUS garbage.
//   - Guides, never walls: every error message tells the user how to fix it.
//     At this stage a blocked signup is worse than a slightly noisy monitor, so
//     real-but-terse setups must pass.
//   - Keyword mode only — Builder Tracker uses a hardcoded keyword set.

const STOP = new Set([
  'a','an','the','and','or','but','for','of','with','to','in','on','at','by',
  'i','me','my','we','our','you','your','it','is','are','be','this','that','how',
  'what','where','who','do','does','can','will','need','want','help','get',
])

// Broad single words that match almost anything — never specific enough alone.
const GENERIC_TOKENS = new Set([
  'youth','digital','project','business','marketing','design','app','tool','tech',
  'data','growth','sales','content','social','media','startup','idea','product',
  'service','software','online','people','work','team','brand','market','company',
  'platform','system','solution','agency','community','network','customer','users',
])

const lc = s => (s || '').toLowerCase()
function contentWords(text) {
  return [...new Set(lc(text).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)))]
}

/**
 * @param {{ keywords?: any[], productContext?: string, mode?: string }} input
 * @returns {{ ok: boolean, errors: {code:string, field:string, message:string}[] }}
 */
export function validateMonitorQuality({ keywords = [], productContext = '', name = '', mode = 'keyword' } = {}) {
  const errors = []
  if (mode === 'builder_tracker') return { ok: true, errors }

  const kw = (Array.isArray(keywords) ? keywords : [])
    .map(k => (k && typeof k === 'object' ? (k.keyword || '') : k))
    .map(s => String(s || '').trim())
    .filter(Boolean)

  // Rule 1 — at least one SPECIFIC keyword: a multi-word phrase, or a single
  // token that isn't a broad generic word. Kills single-token monitors ("Youth").
  const hasSpecific = kw.some(k => {
    if (k.split(/\s+/).length >= 2) return true
    const t = lc(k)
    return t.length >= 4 && !GENERIC_TOKENS.has(t)
  })
  if (!hasSpecific) {
    errors.push({
      code: 'KEYWORDS_TOO_GENERIC', field: 'keywords',
      message: 'Add at least one specific keyword phrase — e.g. "looking for a CRM for small teams" — not a single broad word like "youth" or "marketing".',
    })
  }

  // Rule 2 — domain anchor: the monitor must establish WHAT it is about. Requires
  // enough distinct content words across keywords + productContext + name (the
  // anchor can come from any of them — some users put their description in the
  // monitor name). Kills identity-free setups like "I advocate". Note this is
  // deliberately lenient; the hard gate for generic-keyword garbage is Rule 1.
  const anchor = contentWords(`${kw.join(' ')} ${productContext} ${name}`)
  if (anchor.length < 3) {
    errors.push({
      code: 'NO_DOMAIN_ANCHOR', field: 'productContext',
      message: 'Describe what you do in a sentence or two so the monitor has a clear topic — a phrase like "I advocate" is too vague to find the right conversations.',
    })
  }

  return { ok: errors.length === 0, errors }
}

export const _internals = { GENERIC_TOKENS, contentWords }
