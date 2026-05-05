// lib/keyword-expander.js — Auto-generate keyword variants via DeepSeek.
// Called async on monitor creation so it never blocks the API response.

import { routeAI } from './ai-router.js'

/**
 * Generate 8-10 additional keyword variants for a monitor.
 * Returns array of lowercase-trimmed strings; deduplicates against originals.
 * Never throws — returns [] on any failure.
 */
export async function expandKeywords(originalKeywords = [], productContext = '') {
  if (!originalKeywords.length && !productContext) return []
  const kwList = originalKeywords.map(k => typeof k === 'string' ? k : (k.keyword || '')).filter(Boolean).join(', ')
  const prompt = `You are a Reddit search expert. Given these keywords and product context, generate 8-10 additional search phrases that people actually use on Reddit when they have this problem. Return ONLY a JSON array of strings. No explanation. Focus on how real people complain, ask, or describe this pain — not marketing language.
Keywords: ${kwList}
Product: ${productContext.slice(0, 500)}`
  try {
    const r = await routeAI({ task: 'expand_keywords', prompt, maxTokens: 300, temperature: 0.7, jsonMode: true })
    if (!r.ok) return []
    const parsed = _parseExpanded(r.text)
    const origSet = new Set(originalKeywords.map(k => (typeof k === 'string' ? k : k.keyword || '').toLowerCase().trim()))
    return parsed.filter(kw => kw && !origSet.has(kw.toLowerCase().trim())).slice(0, 15)
  } catch { return [] }
}

export function _parseExpanded(text) {
  if (!text) return []
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  const raw = fence ? fence[1] : text
  const start = raw.indexOf('['), end = raw.lastIndexOf(']')
  if (start === -1 || end === -1) return []
  try {
    const arr = JSON.parse(raw.slice(start, end + 1))
    return Array.isArray(arr) ? arr.filter(s => typeof s === 'string').map(s => s.trim()).filter(Boolean) : []
  } catch { return [] }
}

export const _internals = { _parseExpanded }
