// lib/reddit-rss.js — Parse Reddit search RSS (Atom format) into match records.
//
// Why RSS over the JSON API:
//   - The .json endpoints aggressively rate-limit anonymous traffic and require
//     OAuth client credentials for production-grade headroom. RSS endpoints
//     are public, no auth, no User-Agent gating, no client_id required.
//   - Same data as the search.json results: title, URL, subreddit, author,
//     body (HTML-encoded), published timestamp, post id.
//   - Loses score and comment count (not in RSS feed). We default both to 0.
//
// URL formats (caller decides):
//   Global:    https://www.reddit.com/search.rss?q={kw}&sort=new&t=week
//   Subreddit: https://www.reddit.com/r/{sr}/search.rss?q={kw}&sort=new&t=week&restrict_sr=1
//
// Parsing approach mirrors lib/scrapers/medium.js — regex over the XML rather
// than a full XML parser. Atom uses <entry> blocks; medium uses RSS 2.0 <item>.

// Minimal HTML entity decoder. Reddit RSS encodes its <content> as HTML-escaped
// markup (e.g. "&lt;p&gt;text&lt;/p&gt;"). We decode the common entities then
// strip residual tags so we get clean body text.
function decodeHtmlEntities(s) {
  if (!s) return ''
  return s
    .replace(/&lt;/g,  '<')
    .replace(/&gt;/g,  '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&') // do this last to avoid double-decoding
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function stripHtmlTags(s) {
  if (!s) return ''
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function quoteIfMultiWord(keyword) {
  const trimmed = (keyword || '').trim()
  if (trimmed.includes(' ') && !trimmed.startsWith('"')) {
    return `"${trimmed}"`
  }
  return trimmed
}

/**
 * Build the RSS search URL for a keyword.
 * @param {string} keyword
 * @param {string|null} subreddit  if set, restricts search to one subreddit
 * @param {object} [opts]
 * @param {string} [opts.sort='new']
 * @param {string} [opts.t='week']  Reddit time filter: hour, day, week, month, year, all
 * @returns {string}
 */
export function buildRedditSearchUrl(keyword, subreddit, { sort = 'new', t = 'week' } = {}) {
  const q = encodeURIComponent(quoteIfMultiWord(keyword))
  if (subreddit) {
    return `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.rss?q=${q}&sort=${sort}&t=${t}&restrict_sr=1`
  }
  return `https://www.reddit.com/search.rss?q=${q}&sort=${sort}&t=${t}`
}

/**
 * Parse a Reddit Atom feed XML into an array of normalized entry objects.
 * Returns [] for empty or malformed input rather than throwing — the caller
 * should always be able to safely iterate.
 *
 * @param {string} xml  Raw Atom XML from a Reddit search.rss endpoint
 * @returns {Array<{ id: string, title: string, url: string, subreddit: string, author: string, body: string, createdAt: string }>}
 */
export function parseRedditRSS(xml) {
  if (!xml || typeof xml !== 'string') return []
  const entries = []
  const entryRe = /<entry[^>]*>([\s\S]*?)<\/entry>/gi
  let m
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1]

    // <id>t3_abc123</id> — Reddit thing ID. Sometimes prefixed with the
    // tag URI scheme; we just want the t3_xxx part.
    const idMatch = /<id>(?:tag:[^,]*,\d{4}:\/?)?(?:r\/[^/]+\/comments\/)?([a-z0-9_]+)<\/id>/i.exec(block)
                || /<id>([^<]+)<\/id>/i.exec(block)
    const rawId = idMatch?.[1]?.trim() || ''
    // Strip the t3_ prefix to align with the JSON API's `id` field
    const id = rawId.replace(/^t3_/, '')

    // <title>Title text</title>
    const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(block)
    const title = titleMatch?.[1]?.trim() || ''

    // <link href="https://www.reddit.com/r/.../comments/.../title/"/>
    const linkMatch = /<link[^>]+href="([^"]+)"/i.exec(block)
    const url = linkMatch?.[1] || ''

    // <author><name>/u/username</name>...</author> — strip /u/
    const authorMatch = /<author>[\s\S]*?<name>([^<]+)<\/name>/i.exec(block)
    const author = (authorMatch?.[1] || '').replace(/^\/u\//, '').trim()

    // <category term="SaaS" label="r/SaaS"/>
    const catMatch = /<category[^>]*\bterm="([^"]+)"/i.exec(block)
    let subreddit = catMatch?.[1] || ''
    // Fallback: extract from the URL path /r/{sub}/...
    if (!subreddit && url) {
      const urlSubMatch = /\/r\/([^/]+)\//.exec(url)
      subreddit = urlSubMatch?.[1] || ''
    }

    // <published>2026-04-28T12:34:56+00:00</published> (preferred — when the
    // post first went up). Falls back to <updated> if the feed only has that.
    const publishedMatch = /<published>([^<]+)<\/published>/i.exec(block)
                        || /<updated>([^<]+)<\/updated>/i.exec(block)
    const createdAt = publishedMatch?.[1]?.trim() || new Date().toISOString()

    // <content type="html">&lt;p&gt;body&lt;/p&gt;</content>
    const contentMatch = /<content[^>]*>([\s\S]*?)<\/content>/i.exec(block)
    const body = contentMatch
      ? stripHtmlTags(decodeHtmlEntities(contentMatch[1])).slice(0, 600)
      : ''

    if (!id || !title || !url) continue
    entries.push({ id, title, url, subreddit, author, body, createdAt })
  }
  return entries
}

/**
 * Read Reddit's Retry-After header (seconds), with sane bounds. Returns null
 * when the header isn't present or can't be parsed.
 */
export { quoteIfMultiWord }

export function parseRetryAfter(headers) {
  if (!headers) return null
  const raw = typeof headers.get === 'function'
    ? headers.get('retry-after')
    : (headers['retry-after'] ?? headers['Retry-After'])
  if (!raw) return null
  const n = parseInt(String(raw), 10)
  if (Number.isFinite(n) && n > 0 && n < 600) return n
  return null
}
