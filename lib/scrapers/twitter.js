// lib/scrapers/twitter.js — Twitter/X search via agent-twitter-client.
// Uses cookie persistence in Redis to avoid repeated logins from datacenter IPs.
// agent-twitter-client is CommonJS — loaded via dynamic import for ESM compatibility.

let _Scraper = null
let _SearchMode = null
let _instance = null
let _warnedNoCredentials = false

async function _loadPkg() {
  if (!_Scraper) {
    const pkg = await import('agent-twitter-client')
    _Scraper = pkg.Scraper
    _SearchMode = pkg.SearchMode
  }
}

async function _getInstance() {
  if (_instance) return _instance

  const username = process.env.TWITTER_USERNAME
  const password = process.env.TWITTER_PASSWORD

  if (!username || !password) {
    if (!_warnedNoCredentials) {
      console.warn('[twitter] TWITTER_USERNAME or TWITTER_PASSWORD not set — skipping')
      _warnedNoCredentials = true
    }
    return null
  }

  await _loadPkg()

  let redis = null
  try {
    const { Redis } = await import('@upstash/redis')
    const url   = process.env.UPSTASH_REDIS_REST_URL  || process.env.REDIS_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN
    if (url) redis = new Redis({ url, token })
  } catch { /* Redis optional */ }

  const scraper = new _Scraper()

  if (redis) {
    try {
      const stored = await redis.get('twitter:cookies')
      if (stored) {
        const cookies = typeof stored === 'string' ? JSON.parse(stored) : stored
        await scraper.setCookies(cookies)
        console.log('[twitter] Session restored from Redis')
        _instance = { scraper, redis }
        return _instance
      }
    } catch (e) {
      console.warn('[twitter] Cookie restore failed:', e.message)
    }
  }

  // Fresh login
  try {
    await scraper.login(username, password)
    console.log('[twitter] Logged in fresh')
    if (redis) {
      try {
        const cookies = await scraper.getCookies()
        await redis.set('twitter:cookies', JSON.stringify(cookies), { ex: 604800 })
        console.log('[twitter] Cookies persisted to Redis (7 days)')
      } catch (e) {
        console.warn('[twitter] Cookie persist failed:', e.message)
      }
    }
  } catch (e) {
    console.warn('[twitter] Login failed:', e.message)
    return null
  }

  _instance = { scraper, redis }
  return _instance
}

export default async function searchTwitter(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword } = keywordEntry
  const results = []

  const inst = await _getInstance().catch(() => null)
  if (!inst) return results

  const { scraper, redis } = inst

  try {
    const tweets = await scraper.fetchSearchTweets(keyword, 20, _SearchMode.Latest)

    // Refresh cookies after successful call
    if (redis) {
      scraper.getCookies()
        .then(c => redis.set('twitter:cookies', JSON.stringify(c), { ex: 604800 }))
        .catch(() => {})
    }

    for (const tweet of (tweets?.tweets || [])) {
      if (!tweet?.id) continue

      const id = `twitter_${tweet.id}`
      if (seenIds.has(id)) continue

      if (MAX_AGE_MS && tweet.timeParsed) {
        const ageMs = Date.now() - new Date(tweet.timeParsed).getTime()
        if (ageMs > MAX_AGE_MS) continue
      }

      seenIds.add(id)
      results.push({
        id,
        title:     (tweet.text || '').slice(0, 120),
        url:       `https://x.com/${tweet.username}/status/${tweet.id}`,
        subreddit: 'Twitter',
        author:    tweet.username || 'unknown',
        score:     tweet.likes    || 0,
        comments:  tweet.replies  || 0,
        body:      (tweet.text    || '').slice(0, 600),
        createdAt: tweet.timeParsed
          ? new Date(tweet.timeParsed).toISOString()
          : new Date().toISOString(),
        keyword,
        source:   'twitter',
        approved: true,
      })

      if (results.length >= 15) break
    }
  } catch (err) {
    const msg = err.message || ''
    if (/auth|login|401|403|session/i.test(msg)) {
      console.warn('[twitter] Session error — clearing cookies for re-auth next cycle')
      if (inst.redis) await inst.redis.del('twitter:cookies').catch(() => {})
      _instance = null
    } else {
      console.warn(`[twitter] Error for "${keyword}":`, msg)
    }
  }

  if (delay) await delay(2000)
  return results
}
