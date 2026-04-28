import { createHash } from 'crypto'

// Cache key for the in-memory embedding cache in monitor-v2.js. Hashes the
// full text rather than slicing the first 100 chars. Prevents collisions
// between posts that share a common prefix (boilerplate, quotes, etc.).
export function embeddingCacheKey(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16)
}
