// lib/intent-grounding.js — Stage-2 semantic pre-filter (deterministic, no ML).
//
// Sits BETWEEN retrieval (passesRelevanceCheck) and classify(). Retrieval is
// already correct after PR #84; what leaks now is LINGUISTIC, not infrastructural:
//
//   A. domain-sense mismatch (polysemy) — same word, wrong domain. e.g. a
//      business-audience monitor ("validate my SaaS idea", "MVP validation")
//      matching a GitHub CI-pipeline PR ("CIFAR-10 evaluation pipeline").
//   B. actor-stance inversion (intent direction) — right domain, wrong direction.
//      e.g. a demand keyword ("looking for a co-founder") matching a SUPPLY post
//      ("Show HN: I built X", "ReadyToTalk – AI receptionist, built solo").
//
// Design principles:
//   - Deterministic rules + lexicons only. No model, no embeddings, no
//     is_relevant-in-classify (that would re-push retrieval's job onto the model).
//   - Recall-conservative: rejects ONLY on strong signal. Anything ambiguous
//     passes through to the classifier unchanged. This protects true positives.
//   - Competitor matches are NOT grounded here (they have the #84 brand gate).

// Strong, distinctive developer-tooling terms. Deliberately NOT loose words like
// "api", "agent", "code", "developer" — those appear in non-dev product copy.
const DEV_AUDIENCE_TERMS = [
  'mcp', 'model context protocol', 'llm', 'sdk', 'webhook', 'open source',
  'open-source', 'devops', 'kubernetes', 'docker', 'self-hosted', 'npm package',
  'cli tool', 'codebase', 'api endpoint', 'rest api', 'graphql',
]

// Sources that are unambiguously software-artifact spaces (PRs, issues, repos,
// Q&A about code). A match here on a NON-developer monitor is domain noise.
const CODE_ARTIFACT_SOURCES = new Set(['github', 'stackoverflow'])

// Stance lexicons. ANNOUNCE (supply) is checked first because feedback/launch
// posts often also contain "looking for ...". SEEK (demand) wins only when no
// strong announce signal is present — this protects the genuine seeker case
// "Solo founder building SaaS. looking for partner".
const ANNOUNCE_PATTERNS = [
  /^show hn:/i,
  /\bi (built|made|created|developed|launched|shipped|released)\b/i,
  /\bi'?ve been (building|working on)\b/i,
  /\bi'?m building\b/i,
  /\bjust (launched|released|shipped|built|made|finished)\b/i,
  /\bbuilt (a|an|this|my|it|solo|using|with|in)\b/i,
  /\bintroducing\b/i,
  /\bcheck out my\b/i,
  /\b(feedback on my|would love (your )?feedback|looking for [\w\s]{0,15}feedback)\b/i,
  /\bhere'?s what i (learned|built|made)\b/i,
]
const SEEK_PATTERNS = [
  /\blooking for (a |an |some |the )?/i,
  /\bneed (a |an |help|someone|to find)\b/i,
  /\b(can|could) (anyone|someone) (recommend|suggest|help)\b/i,
  /\banyone (know|use|tried|recommend|using)\b/i,
  /\bis there (a|an|any) (tool|app|service|software|platform|way)\b/i,
  /\bhow (do|can|should) i\b/i,
  /\bstruggling to (find|get)\b/i,
  /\bsuggestions? for\b/i,
  /\bwhere (can|do) i (find|buy|get|hire)\b/i,
  /\brecommend(ations?)?\b/i,
]

function lc(s) { return (s || '').toLowerCase() }

/**
 * Derive the grounding context for a monitor ONCE per cycle.
 * @returns {{ developerAudience: boolean, desiredStance: 'seek'|'announce' }}
 */
export function groundingContext(monitor = {}) {
  const kw = (monitor.keywords || [])
    .map(k => (typeof k === 'object' ? (k.keyword || '') : k))
    .join(' ')
  const hay = lc(`${kw} ${monitor.productContext || ''} ${monitor.brandName || ''}`)
  const developerAudience = DEV_AUDIENCE_TERMS.some(t => hay.includes(t))
  // Builder Tracker mode wants announcers; every other (keyword) monitor wants
  // demand-side seekers.
  const desiredStance = monitor.mode === 'builder_tracker' ? 'announce' : 'seek'
  return { developerAudience, desiredStance }
}

/** @returns {'announce'|'seek'|'neutral'} */
export function detectStance(match) {
  const text = `${match.title || ''}. ${(match.body || '').slice(0, 240)}`
  if (ANNOUNCE_PATTERNS.some(re => re.test(text))) return 'announce'
  if (SEEK_PATTERNS.some(re => re.test(text)))     return 'seek'
  return 'neutral'
}

/**
 * Decide whether a (non-competitor) candidate is well-grounded enough to reach
 * the classifier. Conservative: returns admit:true unless a strong mismatch.
 * @returns {{ admit: boolean, reason: string }}
 */
export function groundIntent(match, ctx = {}) {
  // Check A — domain sense. A code-artifact source on a non-developer monitor is
  // polysemy noise ("MVP"/"validation"/"discovery" in the software sense).
  if (!ctx.developerAudience && CODE_ARTIFACT_SOURCES.has(lc(match.source))) {
    return { admit: false, reason: 'domain_mismatch' }
  }
  // Check B — actor stance. Strong opposite-direction posts are inversion noise.
  const stance = detectStance(match)
  if (stance !== 'neutral' && ctx.desiredStance && stance !== ctx.desiredStance) {
    return { admit: false, reason: 'stance_inversion' }
  }
  return { admit: true, reason: 'ok' }
}

export const _internals = { DEV_AUDIENCE_TERMS, CODE_ARTIFACT_SOURCES, ANNOUNCE_PATTERNS, SEEK_PATTERNS }
