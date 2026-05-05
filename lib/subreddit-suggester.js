// lib/subreddit-suggester.js — Generate relevant subreddit suggestions via DeepSeek.
// Called async on monitor creation; results stored in Redis for 7 days.

import { routeAI } from './ai-router.js'

/**
 * Suggest up to 10 subreddits relevant to a product context + keywords.
 * Returns array of lowercase subreddit names (no r/ prefix).
 * Never throws — returns [] on any failure.
 */
export async function suggestSubreddits(productContext = '', keywords = []) {
  if (!productContext && !keywords.length) return []
  const kwList = keywords.map(k => typeof k === 'string' ? k : (k.keyword || '')).filter(Boolean).slice(0, 10).join(', ')
  const prompt = `You are a Reddit expert. Given this product context and keywords, suggest 8-10 specific subreddits where potential customers actively discuss this problem. Return ONLY a JSON array of subreddit names without the r/ prefix. Pick active communities where people ask for tool recommendations, complain about problems, or share workflow tips — NOT general subreddits.
Product: ${productContext.slice(0, 500)}
Keywords: ${kwList}`
  try {
    const r = await routeAI({ task: 'suggest_subreddits', prompt, maxTokens: 250, temperature: 0.6, jsonMode: true })
    if (!r.ok) return []
    return _parseSuggested(r.text)
  } catch { return [] }
}

export function _parseSuggested(text) {
  if (!text) return []
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  const raw = fence ? fence[1] : text
  const start = raw.indexOf('['), end = raw.lastIndexOf(']')
  if (start === -1 || end === -1) return []
  try {
    const arr = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(arr)) return []
    return arr
      .filter(s => typeof s === 'string')
      .map(s => s.trim().toLowerCase().replace(/^r\//, ''))
      .filter(Boolean)
      .slice(0, 10)
  } catch { return [] }
}

export const _internals = { _parseSuggested }
