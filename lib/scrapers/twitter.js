// lib/scrapers/twitter.js — Twitter/X search via agent-twitter-client.
// Uses Twitter's internal GraphQL API; no paid API, no Puppeteer/Playwright.
// Login is performed once per process (cached at module scope) using a
// dedicated TWITTER_USERNAME/TWITTER_PASSWORD account.

import { Scraper, SearchMode } from 'agent-twitter-client'

let _scraper = null
let _loginAttempted = false
let _loginOk = false
let _missingCredsLogged = false

async function getScraper() {
  const username = process.env.TWITTER_USERNAME
  const password = process.env.TWITTER_PASSWORD
  if (!username || !password) {
    if (!_missingCredsLogged) {
      console.warn('[twitter] TWITTER_USERNAME / TWITTER_PASSWORD not set — skipping Twitter scraper')
      _missingCredsLogged = true
    }
    return null
  }

  if (_loginAttempted) return _loginOk ? _scraper : null

  _loginAttempted = true
  try {
    const scraper = new Scraper()
    await scraper.login(username, password)
    _scraper = scraper
    _loginOk  = true
    return _scraper
  } catch (err) {
    console.warn(`[twitter] login failed: ${err.message}`)
    _loginOk = false
    return null
  }
}

export default async function searchTwitter(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword } = keywordEntry
  const results = []

  try {
    const scraper = await getScraper()
    if (!scraper) return results

    const tweetsIter = await scraper.fetchSearchTweets(keyword, 20, SearchMode.Latest)
    const tweets = Array.isArray(tweetsIter?.tweets) ? tweetsIter.tweets : (tweetsIter?.tweets || [])

    for (const tweet of tweets) {
      if (!tweet || !tweet.id) continue
      const id = `twitter_${tweet.id}`
      if (seenIds.has(id)) continue

      const createdAt = tweet.timeParsed instanceof Date
        ? tweet.timeParsed
        : (tweet.timeParsed ? new Date(tweet.timeParsed) : new Date())
      if (MAX_AGE_MS && Date.now() - createdAt.getTime() > MAX_AGE_MS) continue

      seenIds.add(id)
      const text = (tweet.text || '').toString()
      results.push({
        id,
        title:     text.slice(0, 120),
        url:       `https://x.com/${tweet.username}/status/${tweet.id}`,
        subreddit: 'Twitter',
        author:    tweet.username || 'unknown',
        score:     tweet.likes || 0,
        comments:  tweet.replies || 0,
        body:      text.slice(0, 600),
        createdAt: createdAt.toISOString(),
        keyword,
        source:    'twitter',
        approved:  true,
      })

      if (results.length >= 15) break
    }
  } catch (err) {
    console.warn(`[twitter] error for "${keyword}": ${err.message}`)
    if (delay) await delay(2000)
    return []
  }

  if (delay) await delay(2000)
  return results
}
