// lib/subreddit-suggester.js — DeepSeek-powered subreddit suggestions for monitors.

import { routeAI } from './ai-router.js'

/**
 * Suggest 7 relevant subreddits for a monitor's product/keywords.
 * Returns array of subreddit name strings (without r/ prefix).
 * Never throws — returns [] on any failure.
 */
export async function suggestSubreddits(productContext = '', keywords = []) {
  if (!productContext && !keywords.length) return []
  const kwList = keywords.map(k => typeof k === 'string' ? k : (k.keyword || '')).filter(Boolean).join(', ')
  const prompt = `You are a Reddit expert. Given this product and keywords, return the 7 most relevant subreddits where potential customers would discuss this problem. Return ONLY a JSON array of subreddit names without r/ prefix. Choose subreddits that are active, allow discussion, and where your ideal customer actually hangs out — not generic ones like r/all.
Product: ${productContext.slice(0, 500)}
Keywords: ${kwList.slice(0, 300)}`
  try {
    const r = await routeAI({ task: 'suggest_subreddits', prompt, maxTokens: 200, temperature: 0.5, jsonMode: true })
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
    return Array.isArray(arr)
      ? arr.filter(s => typeof s === 'string').map(s => s.replace(/^r\//i, '').trim()).filter(Boolean).slice(0, 10)
      : []
  } catch { return [] }
}

export const _internals = { _parseSuggested }
