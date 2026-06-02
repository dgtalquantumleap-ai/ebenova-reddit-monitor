// lib/scrapers/stackoverflow.js — Stack Overflow search via Stack Exchange API v2.3.
//
// Previously disabled due to 400/429 errors from passing raw keyword phrases
// to the &q= param. Fixed by routing queries through three strategies:
//
//   1. Tag match  — if the keyword maps to a known SO tag, use &tagged=
//      This is the most reliable path: no 400s, high-quality results.
//   2. Title search — short single/two-word keywords use &intitle=
//      Stack Exchange handles these cleanly without 400s.
//   3. q= fallback — only for keywords that are safe (no stop words,
//      no special chars, ≤4 meaningful words).
//   4. skip — keyword is too long / stop-word-heavy to query safely.
//
// Quota: anonymous = 300 req/day; STACK_APPS_KEY = 10 000/day.
// Add STACK_APPS_KEY to Railway env, then remove 'stackoverflow' from
// PLATFORM_DISABLED in lib/platforms.js to re-enable.
//
// Docs: https://api.stackexchange.com/docs/search

import { fetchWithBackoff } from './_fetch-backoff.js'
import { resolveKeyword } from '../reddit-rss.js'

const UA          = 'Mozilla/5.0 (compatible; EbenovaBot/2.0)'
const MAX_RESULTS = 15
const TIMEOUT_MS  = 8_000

let _quotaWarnedZero = false
let _quotaRemaining  = Infinity // updated live after each response

// ── Tag map: keyword fragments → Stack Overflow tag names ────────────────────
// SO tags are lowercase, hyphen-separated. A keyword only needs to *contain*
// a fragment for the tag to apply — e.g. "PDF generation API" → tag "pdf".
// Order matters: more specific entries are listed first.
const TAG_MAP = [
  // Languages & runtimes
  ['javascript',       'javascript'],
  ['typescript',       'typescript'],
  ['python',           'python'],
  ['node.js',          'node.js'],
  ['nodejs',           'node.js'],
  ['react',            'reactjs'],
  ['vue',              'vue.js'],
  ['next.js',          'next.js'],
  ['nextjs',           'next.js'],
  ['golang',           'go'],
  ['rust',             'rust'],
  ['php',              'php'],
  ['ruby',             'ruby-on-rails'],
  ['kotlin',           'kotlin'],
  ['swift',            'swift'],
  ['android',          'android'],
  ['flutter',          'flutter'],
  // Databases & infra
  ['postgresql',       'postgresql'],
  ['postgres',         'postgresql'],
  ['mongodb',          'mongodb'],
  ['mysql',            'mysql'],
  ['redis',            'redis'],
  ['docker',           'docker'],
  ['kubernetes',       'kubernetes'],
  ['aws',              'amazon-web-services'],
  ['azure',            'azure'],
  ['gcp',              'google-cloud-platform'],
  // APIs & integration
  ['rest api',         'rest'],
  ['graphql',          'graphql'],
  ['webhook',          'webhooks'],
  ['oauth',            'oauth'],
  ['pdf',              'pdf'],
  ['csv',              'csv'],
  ['excel',            'excel'],
  ['json',             'json'],
  // AI / ML
  ['openai',           'openai-api'],
  ['chatgpt',          'chatgpt'],
  ['llm',              'llm'],
  ['langchain',        'langchain'],
  ['embeddings',       'embeddings'],
  ['machine learning', 'machine-learning'],
  // Business / SaaS tooling
  ['stripe',           'stripe-payments'],
  ['twilio',           'twilio'],
  ['sendgrid',         'sendgrid'],
  ['zapier',           'zapier'],
  ['saas',             'saas'],
  ['api',              'api'],
  ['freelance',        'freelancing'],
  ['contract',         'contracts'],
]

// Stop words that make a keyword unsafe to send as &q= or &intitle=
const STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could',
  'should','may','might','shall','can','need','how','what','why',
  'when','where','who','which','i','my','your','we','our','they',
  'their','it','to','for','of','in','on','at','by','with','from',
  'as','or','and','but','not','no','so','if','then','than','that',
])

/**
 * Derive the best Stack Exchange query params for a given keyword string.
 * Returns { strategy, params } — never the raw &q= form for multi-word
 * stop-word-heavy phrases that trigger 400s.
 *
 * @param {string} kw  resolved keyword string
 * @returns {{ strategy: string, params: string }}
 */
export function buildSOParams(kw) {
  const lower = kw.toLowerCase().trim()

  // Strategy 1: tag match
  for (const [fragment, tag] of TAG_MAP) {
    if (lower.includes(fragment)) {
      // Combine tag + intitle for precision when the keyword has more signal
      // beyond just the tag (e.g. "stripe payment integration" →
      // tagged=stripe-payments + intitle=payment integration).
      const extra = lower.replace(fragment, '').trim().replace(/[^a-z0-9 ]/g, '').trim()
      const extraWords = extra.split(/\s+/).filter(w => w.length >= 3 && !STOP_WORDS.has(w))
      const intitle = extraWords.length >= 1 && extraWords.length <= 3
        ? `&intitle=${encodeURIComponent(extraWords.join(' '))}`
        : ''
      return { strategy: 'tag', params: `&tagged=${encodeURIComponent(tag)}${intitle}` }
    }
  }

  // Strategy 2: intitle — safe for 1–3 meaningful words, no special chars
  const words = lower.split(/\s+/).filter(Boolean)
  const meaningful = words.filter(w => !STOP_WORDS.has(w) && w.length >= 3)

  if (meaningful.length >= 1 && meaningful.length <= 4) {
    const safe = meaningful.join(' ').replace(/[^a-z0-9 .#+\-]/g, '').trim()
    if (safe.length >= 3) {
      return { strategy: 'intitle', params: `&intitle=${encodeURIComponent(safe)}` }
    }
  }

  // Strategy 3: q= fallback — only when very short and clean
  if (meaningful.length >= 1 && meaningful.length <= 2) {
    const safe = meaningful.join(' ').trim()
    if (safe.length >= 3) {
      return { strategy: 'q', params: `&q=${encodeURIComponent(safe)}` }
    }
  }

  // Strategy 4: skip — too long / too stop-word-heavy to query safely
  return { strategy: 'skip', params: '' }
}

export default async function searchStackOverflow(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const keyword = resolveKeyword(keywordEntry)
  if (!keyword) return []

  const { strategy, params } = buildSOParams(keyword)

  if (strategy === 'skip') {
    if (delay) await delay(500)
    return []
  }

  // Respect a soft quota floor — stop once we're critically low
  if (_quotaRemaining < 10) {
    console.warn(`[stackoverflow] quota critically low (${_quotaRemaining}) — skipping "${keyword}"`)
    if (delay) await delay(500)
    return []
  }

  const results  = []
  const ageMs    = MAX_AGE_MS || (24 * 60 * 60 * 1000)
  const since    = Math.floor((Date.now() - ageMs) / 1000)
  const keyParam = process.env.STACK_APPS_KEY
    ? `&key=${encodeURIComponent(process.env.STACK_APPS_KEY)}`
    : ''

  const url = [
    'https://api.stackexchange.com/2.3/search/advanced',
    '?order=desc&sort=creation',
    `&site=stackoverflow`,
    `&filter=withbody`,
    `&pagesize=${MAX_RESULTS}`,
    `&fromdate=${since}`,
    params,
    keyParam,
  ].join('')

  try {
    const res = await fetchWithBackoff(url, {
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!res) {
      // fetchWithBackoff exhausted retries on 429
      console.warn(`[stackoverflow] 429 retries exhausted for "${keyword}" — skipping`)
      return results
    }

    if (!res.ok) {
      console.warn(`[stackoverflow] ${res.status} for "${keyword}" (strategy=${strategy} params=${params})`)
      return results
    }

    const data = await res.json()

    // Update live quota tracking
    if (typeof data.quota_remaining === 'number') {
      _quotaRemaining = data.quota_remaining
      if (_quotaRemaining === 0 && !_quotaWarnedZero) {
        console.warn('[stackoverflow] daily quota exhausted — add STACK_APPS_KEY for 10k/day')
        _quotaWarnedZero = true
      }
    }

    for (const item of (data.items || [])) {
      if (results.length >= MAX_RESULTS) break

      const id = `stackoverflow_${item.question_id}`
      if (seenIds.has(id)) continue
      seenIds.add(id)

      const createdAt = new Date(item.creation_date * 1000)
      if (MAX_AGE_MS && createdAt.getTime() < Date.now() - MAX_AGE_MS) continue

      const body = (item.body || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600)

      results.push({
        id,
        title:     item.title || '(no title)',
        url:       item.link,
        subreddit: 'Stack Overflow',
        author:    item.owner?.display_name || 'unknown',
        score:     item.score        || 0,
        comments:  item.answer_count || 0,
        body,
        createdAt: createdAt.toISOString(),
        keyword,
        source:    'stackoverflow',
        approved:  true,
      })
    }
  } catch (err) {
    console.warn(`[stackoverflow] fetch error for "${keyword}": ${err.message}`)
  }

  if (delay) await delay(1500)
  return results
}

export const _internals = {
  MAX_RESULTS,
  TIMEOUT_MS,
  buildSOParams,
  resetQuotaWarn:      () => { _quotaWarnedZero = false },
  resetQuotaRemaining: () => { _quotaRemaining = Infinity },
}
