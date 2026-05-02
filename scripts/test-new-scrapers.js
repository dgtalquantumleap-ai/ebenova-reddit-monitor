import { loadEnv } from '../lib/env.js'
loadEnv()

import searchTwitter  from '../lib/scrapers/twitter.js'
import searchLinkedIn from '../lib/scrapers/linkedin.js'

const opts = { seenIds: new Set(), delay: null, MAX_AGE_MS: null }
const kw   = { keyword: 'freelance contract' }

const [tw, li] = await Promise.allSettled([
  searchTwitter(kw, opts),
  searchLinkedIn(kw, opts),
])

const twResults = tw.status === 'fulfilled' ? tw.value : []
const liResults = li.status === 'fulfilled' ? li.value : []

console.log(`Twitter:  ${twResults.length} results${twResults[0] ? ' | "' + twResults[0].title.slice(0, 60) + '"' : ''}`)
console.log(`LinkedIn: ${liResults.length} results${liResults[0] ? ' | "' + liResults[0].title.slice(0, 60) + '"' : ''}`)

if (twResults.length === 0) console.warn('WARNING: Twitter returned 0 results — check credentials')
if (liResults.length === 0) console.warn('WARNING: LinkedIn returned 0 results — DuckDuckGo may be blocking')

process.exit(twResults.length === 0 && liResults.length === 0 ? 1 : 0)
