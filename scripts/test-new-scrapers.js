#!/usr/bin/env node
// scripts/test-new-scrapers.js — manual verification for the new scrapers.
// Run after deploy (or locally with creds in .env) to confirm Twitter is
// functional. Also probes LinkedIn so we can re-enable it the moment a
// search backend cooperates — but LinkedIn is parked (see lib/scrapers/linkedin.js)
// and is NOT counted toward the success exit code.
//
// Usage:
//   npm run test:scrapers
//
// Exits 0 if Twitter returned results, 1 otherwise.

import { loadEnv } from '../lib/env.js'
loadEnv()

import searchTwitter  from '../lib/scrapers/twitter.js'
import searchLinkedIn from '../lib/scrapers/linkedin.js'

const opts = { seenIds: new Set(), delay: null, MAX_AGE_MS: null }
const KEYWORD = 'freelance contract'

function summarize(label, items) {
  console.log(`${label}: ${items.length} results`)
  if (items.length > 0) {
    const first = items[0]
    console.log(`  first: ${(first.title || '(no title)').slice(0, 100)}`)
    if (first.url) console.log(`  url:   ${first.url}`)
  } else {
    console.warn(`  ⚠️  ${label} returned 0 results`)
  }
}

async function main() {
  let twitterResults = []
  let linkedinResults = []

  try {
    twitterResults = await searchTwitter({ keyword: KEYWORD }, opts)
  } catch (err) {
    console.warn(`Twitter threw: ${err.message}`)
  }
  summarize('Twitter', twitterResults)

  try {
    linkedinResults = await searchLinkedIn({ keyword: KEYWORD }, opts)
  } catch (err) {
    console.warn(`LinkedIn threw: ${err.message}`)
  }
  summarize('LinkedIn (parked — informational)', linkedinResults)

  if (twitterResults.length === 0) {
    console.warn('\nTwitter returned 0 results — check TWITTER_USERNAME / TWITTER_PASSWORD and scraper logs.')
    process.exit(1)
  }
  console.log(`\nOK — Twitter returned ${twitterResults.length} results.`)
  process.exit(0)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
