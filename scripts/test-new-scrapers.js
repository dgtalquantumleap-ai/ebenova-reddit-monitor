#!/usr/bin/env node
// scripts/test-new-scrapers.js — manual verification for the Twitter + LinkedIn
// scrapers. Run after deploy (or locally with creds in .env) to confirm both
// platforms return real results.
//
// Usage:
//   npm run test:scrapers
//
// Exits 0 if at least one scraper returned results, 1 if both returned 0.

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
  summarize('LinkedIn', linkedinResults)

  const total = twitterResults.length + linkedinResults.length
  if (total === 0) {
    console.warn('\nBoth scrapers returned 0 results — check credentials, IP rep, and scraper logs.')
    process.exit(1)
  }
  console.log(`\nOK — ${total} total results across both platforms.`)
  process.exit(0)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
