import { createHash } from 'crypto'

// Stable 12-char hex ID derived from a URL. 12 hex chars = 48 bits, ~1-in-281T
// collision space — safe for any realistic scraper volume.
//
// Replaces the old `href.replace(/[^a-z0-9]/gi,'_').slice(0, 40)` pattern,
// which collided when distinct URLs shared their first 40 alphanumeric chars
// (common with forum URLs sharing a path prefix like
// `/forums/topic-1234567890-some-thread-title-...`).
export function hashUrlToId(url, prefix = '') {
  const hash = createHash('sha1').update(String(url ?? '')).digest('hex').slice(0, 12)
  return prefix ? `${prefix}_${hash}` : hash
}
