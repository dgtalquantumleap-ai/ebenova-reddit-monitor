// lib/semantic.js — Voyage AI embedding helpers. Pure functions with no
// global state; callers manage caching. ESM, no npm package needed (raw fetch).

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings'
const VOYAGE_MODEL    = 'voyage-3-lite'

/**
 * Fetch a single embedding vector from Voyage AI.
 * Returns null on any failure — never throws.
 */
export async function embedText(text, apiKey = process.env.VOYAGE_API_KEY) {
  if (!apiKey || !text) return null
  try {
    const res = await fetch(VOYAGE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: VOYAGE_MODEL, input: [String(text).slice(0, 2000)] }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data?.data?.[0]?.embedding || null
  } catch { return null }
}

/**
 * Cosine similarity between two equal-length float arrays.
 * Returns 0 for null/mismatched inputs.
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/**
 * True if postText is semantically similar to keywordContext above threshold.
 * Both texts are embedded; caller may pass a pre-embedded queryVec to save an API call.
 */
export async function isSemanticMatch(postText, keywordContext, threshold = 0.65, { apiKey, queryVec } = {}) {
  const key = apiKey || process.env.VOYAGE_API_KEY
  const [a, b] = await Promise.all([
    queryVec ? Promise.resolve(queryVec) : embedText(keywordContext, key),
    embedText(postText, key),
  ])
  if (!a || !b) return false
  return cosineSimilarity(a, b) >= threshold
}

export const _internals = { VOYAGE_MODEL, VOYAGE_ENDPOINT }
