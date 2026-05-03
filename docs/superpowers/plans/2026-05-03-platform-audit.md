# Platform Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken Twitter scraper (replace `agent-twitter-client` with Nitter RSS), add `resolveKeyword` to the 5 remaining scrapers that still destructure keywords directly, add an admin platform-health endpoint, show disabled status on dashboard platform chips, and document the admin secret in `.env.example`.

**Architecture:** All scrapers use `resolveKeyword()` from `lib/reddit-rss.js` for normalised keyword access. Twitter is replaced with a pure RSS approach (no credentials, no unofficial API). A new `lib/platform-health.js` module houses the health-check logic so `api-server.js` stays thin and the logic is unit-testable with mock scrapers. The `/v1/platforms` endpoint gains a `disabled` field sourced from `PLATFORM_DISABLED` in `lib/platforms.js`; the dashboard reads it without a second request.

**Tech Stack:** Node 20 ESM, Express, `node:test`, Nitter RSS (RSS 2.0), `hashUrlToId` from `lib/scrapers/_id.js`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `lib/scrapers/twitter.js` | **Rewrite** | Nitter RSS — no auth, 3 fallback instances, resolveKeyword |
| `lib/scrapers/upwork.js` | Modify | add resolveKeyword (2 lines) |
| `lib/scrapers/github.js` | Modify | add resolveKeyword (2 lines) |
| `lib/scrapers/producthunt.js` | Modify | add resolveKeyword (2 lines) |
| `lib/scrapers/amazon.js` | Modify | add resolveKeyword (2 lines) |
| `lib/scrapers/jijing.js` | Modify | add resolveKeyword (2 lines) |
| `lib/platform-health.js` | **Create** | `buildHealthReport(scraperMap, keyword, ctx)` — testable pure function |
| `api-server.js` | Modify | import PLATFORM_DISABLED + disabled field in /v1/platforms; import platform-health + route |
| `public/dashboard.html` | Modify | orange dot on chip buttons when `p.disabled` is set |
| `.env.example` | Modify | add EBENOVA_ADMIN_SECRET; update Twitter section comment |
| `test/platform-audit.test.js` | **Create** | 6 new tests (Twitter RSS, Nitter fallback, all-down, Upwork error, Amazon block, health report shape) |
| `test/scraper-twitter-linkedin.test.js` | Modify | remove 2 credential-based tests that no longer apply after rewrite |

---

## Task 1: Create branch + write all failing tests

**Files:**
- Create: `test/platform-audit.test.js`

- [ ] **Step 1: Create the branch**

```bash
git checkout main && git pull
git checkout -b feat/platform-audit
```

- [ ] **Step 2: Confirm baseline test count**

```bash
npm test 2>&1 | tail -5
```
Expected: `717 tests, 716 pass, 1 skip` (or close). Record this number.

- [ ] **Step 3: Write the failing test file**

Create `test/platform-audit.test.js`:

```js
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import searchTwitter, { _internals as twitterInternals } from '../lib/scrapers/twitter.js'
import searchUpwork from '../lib/scrapers/upwork.js'
import searchAmazonReviews, { _internals as amazonInternals } from '../lib/scrapers/amazon.js'
import { buildHealthReport } from '../lib/platform-health.js'

function withFetch(impl, fn) {
  const original = global.fetch
  global.fetch = impl
  return Promise.resolve().then(fn).finally(() => { global.fetch = original })
}

const ctx = () => ({
  seenIds: { has: () => false, add: () => {} },
  delay:   async () => {},
  MAX_AGE_MS: 24 * 60 * 60 * 1000,
})

// ── Test 6: Twitter Nitter RSS parser ─────────────────────────────────────────

test('6. Twitter (Nitter RSS) parseNitterRSS extracts tweet fields correctly', () => {
  const { parseNitterRSS } = twitterInternals
  const seenIds = { has: () => false, add: () => {} }
  const xml = `<rss><channel>
    <item>
      <title><![CDATA[@testuser: freelance contract template needed]]></title>
      <link>https://nitter.poast.org/testuser/status/9876543210#m</link>
      <pubDate>Sat, 03 May 2026 10:00:00 GMT</pubDate>
      <dc:creator>@testuser</dc:creator>
      <description><![CDATA[freelance contract template needed — any recommendations?]]></description>
    </item>
  </channel></rss>`
  const results = parseNitterRSS(xml, 'freelance contract', seenIds, 24 * 60 * 60 * 1000)
  assert.equal(results.length, 1)
  assert.equal(results[0].url, 'https://x.com/testuser/status/9876543210')
  assert.equal(results[0].author, 'testuser')
  assert.equal(results[0].source, 'twitter')
  assert.equal(results[0].subreddit, 'Twitter')
  assert.ok(!results[0].title.startsWith('@testuser:'), 'title should not start with @username:')
  assert.equal(results[0].approved, true)
})

// ── Test 7: Twitter falls back to second instance on first failure ─────────────

test('7. Twitter falls back to second Nitter instance when first returns non-2xx', async () => {
  twitterInternals.resetAllDownLogged()
  let callCount = 0
  const fakeXml = `<rss><channel>
    <item>
      <title><![CDATA[@u: freelance dev]]></title>
      <link>https://nitter.privacydev.net/u/status/111222333444#m</link>
      <pubDate>Sat, 03 May 2026 09:00:00 GMT</pubDate>
      <dc:creator>@u</dc:creator>
      <description><![CDATA[freelance dev]]></description>
    </item>
  </channel></rss>`

  await withFetch(async () => {
    callCount++
    if (callCount === 1) return { ok: false, status: 503 }
    return { ok: true, text: async () => fakeXml }
  }, async () => {
    const results = await searchTwitter({ keyword: 'freelance dev' }, ctx())
    assert.ok(results.length > 0, 'should return results from second instance')
    assert.equal(callCount, 2, 'should have tried exactly 2 instances')
  })
})

// ── Test 8: Twitter returns [] if all instances fail ──────────────────────────

test('8. Twitter returns [] gracefully when all Nitter instances fail (no throw)', async () => {
  twitterInternals.resetAllDownLogged()
  await withFetch(async () => { throw new Error('network error') }, async () => {
    const results = await searchTwitter({ keyword: 'freelance' }, ctx())
    assert.deepEqual(results, [])
  })
})

// ── Test 9: Upwork returns [] on HTTP error ───────────────────────────────────

test('9. Upwork returns [] gracefully on any HTTP error (no throw)', async () => {
  await withFetch(async () => ({ ok: false, status: 503 }), async () => {
    const results = await searchUpwork({ keyword: 'web developer' }, ctx())
    assert.deepEqual(results, [])
  })
})

// ── Test 10: Amazon returns [] on block / 403 ─────────────────────────────────

test('10. Amazon returns [] gracefully on 403 anti-bot block (no throw)', async () => {
  amazonInternals.resetBlockedWarning()
  await withFetch(async () => ({ ok: false, status: 403 }), async () => {
    const results = await searchAmazonReviews({ keyword: 'logo design' }, ctx())
    assert.deepEqual(results, [])
  })
})

// ── Test 11: buildHealthReport returns correct shape ─────────────────────────

test('11. buildHealthReport returns ok/error status and sample_count for each platform', async () => {
  const scrapers = {
    reddit:  async () => [{ id: 'r1' }, { id: 'r2' }],
    youtube: async () => [],
    broken:  async () => { throw new Error('network error') },
  }
  const testCtx = ctx()
  const report = await buildHealthReport(scrapers, 'freelance', testCtx)

  assert.equal(report.reddit.status, 'ok')
  assert.equal(report.reddit.sample_count, 2)
  assert.equal(report.youtube.status, 'ok')
  assert.equal(report.youtube.sample_count, 0)
  assert.equal(report.broken.status, 'error')
  assert.ok(typeof report.broken.error === 'string')
})
```

- [ ] **Step 4: Run the tests to confirm they all fail**

```bash
npm test 2>&1 | grep -E "platform-audit|FAIL|Error"
```

Expected: 6 failures (imports fail because `lib/platform-health.js` doesn't exist and `twitterInternals.parseNitterRSS` doesn't exist yet).

- [ ] **Step 5: Commit the failing tests**

```bash
git add test/platform-audit.test.js
git commit -m "test(platform-audit): add 6 failing regression tests"
```

---

## Task 2: Rewrite lib/scrapers/twitter.js (Nitter RSS)

**Files:**
- Modify: `lib/scrapers/twitter.js`

- [ ] **Step 1: Read the current file**

Read `lib/scrapers/twitter.js` completely before editing.

- [ ] **Step 2: Write the new implementation**

Replace the entire file content with:

```js
// lib/scrapers/twitter.js — Twitter/X search via Nitter RSS (no auth required).
//
// agent-twitter-client broke in May 2026 (error code 34 — login endpoint
// changed). Replaced with Nitter RSS: public Twitter frontend with no-auth
// RSS feeds. URL pattern: https://{instance}/search/rss?q={keyword}&f=tweets
//
// Three fallback instances are tried in order. If all fail, we log once and
// return [] gracefully — the monitor cycle continues without Twitter data.

import { hashUrlToId } from './_id.js'
import { resolveKeyword } from '../reddit-rss.js'

const TIMEOUT_MS = 10_000
const MAX_RESULTS = 15
const INSTANCES = [
  'nitter.poast.org',
  'nitter.privacydev.net',
  'nitter.1d4.us',
]

let _allDownLogged = false

function decodeHtmlEntities(s) {
  if (!s) return ''
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
}

function stripHtmlTags(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

// Parse Nitter RSS 2.0 XML into match records.
// Nitter item shape: <title>@user: text</title>, <link>nitter/user/status/ID#m</link>
export function parseNitterRSS(xml, keyword, seenIds, MAX_AGE_MS) {
  const results = []
  const itemPattern = /<item>([\s\S]*?)<\/item>/g
  const cutoffMs = Date.now() - (MAX_AGE_MS || 0)
  let m
  while ((m = itemPattern.exec(xml)) !== null && results.length < MAX_RESULTS) {
    const block = m[1]

    const titleRaw = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                     block.match(/<title>([\s\S]*?)<\/title>/))?.[1] || ''
    const linkRaw  = (block.match(/<link>([\s\S]*?)<\/link>/) ||
                     block.match(/<link\s+[^>]*href="([^"]+)"/))?.[1]?.trim() || ''
    const pubRaw   = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || ''
    const creatorRaw = (block.match(/<dc:creator><!\[CDATA\[([\s\S]*?)\]\]><\/dc:creator>/) ||
                       block.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/))?.[1] || ''
    const descRaw  = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                     block.match(/<description>([\s\S]*?)<\/description>/))?.[1] || ''

    if (!linkRaw) continue

    // Convert Nitter URL → canonical x.com URL.
    // Nitter: https://nitter.instance/username/status/12345#m
    const statusMatch = linkRaw.match(/\/([^/]+)\/status\/(\d+)/)
    if (!statusMatch) continue
    const [, username, statusId] = statusMatch
    const canonicalUrl = `https://x.com/${username}/status/${statusId}`

    const pubDate = pubRaw ? new Date(pubRaw) : null
    if (MAX_AGE_MS && pubDate && Number.isFinite(pubDate.getTime()) && pubDate.getTime() < cutoffMs) continue

    const id = hashUrlToId(canonicalUrl, 'twitter')
    if (seenIds.has(id)) continue
    seenIds.add(id)

    // Title: "@username: tweet text" — strip the "@username: " prefix
    const titleDecoded = decodeHtmlEntities(titleRaw)
    const titleText = titleDecoded.replace(/^@\w+:\s*/, '').trim()
    const body = stripHtmlTags(decodeHtmlEntities(descRaw || titleRaw)).slice(0, 600)
    const author = (creatorRaw || username).replace(/^@/, '').trim()

    results.push({
      id,
      title:     (titleText || body).slice(0, 120),
      url:       canonicalUrl,
      subreddit: 'Twitter',
      author,
      score:     0,
      comments:  0,
      body,
      createdAt: (pubDate && Number.isFinite(pubDate.getTime()))
        ? pubDate.toISOString()
        : new Date().toISOString(),
      keyword,
      source:    'twitter',
      approved:  true,
    })
  }
  return results
}

export default async function searchTwitter(keywordEntry, ctx = {}) {
  const keyword = resolveKeyword(keywordEntry)
  const seenIds  = ctx.seenIds  || { has: () => false, add: () => {} }
  const MAX_AGE_MS = ctx.MAX_AGE_MS || 24 * 60 * 60 * 1000
  const results = []
  if (!keyword) return results

  const query = encodeURIComponent(keyword)

  for (const instance of INSTANCES) {
    const url = `https://${instance}/search/rss?q=${query}&f=tweets`
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) {
        console.warn(`[twitter] ${instance} returned ${res.status} for "${keyword}" — trying next`)
        continue
      }
      const xml = await res.text()
      if (!xml.includes('<item>')) return results  // empty feed — no results, not an error

      const parsed = parseNitterRSS(xml, keyword, seenIds, MAX_AGE_MS)
      results.push(...parsed)
      if (typeof ctx.delay === 'function') await ctx.delay(1000)
      return results
    } catch (err) {
      console.warn(`[twitter] ${instance} error for "${keyword}": ${err.message} — trying next`)
    }
  }

  if (!_allDownLogged) {
    console.warn('[twitter] all Nitter instances failed — returning [] for this cycle')
    _allDownLogged = true
  }
  return results
}

export const _internals = {
  INSTANCES, TIMEOUT_MS, MAX_RESULTS,
  parseNitterRSS,
  resetAllDownLogged: () => { _allDownLogged = false },
}
```

- [ ] **Step 3: Run the Twitter-specific tests**

```bash
npm test 2>&1 | grep -E "Test 6|Test 7|Test 8|platform-audit"
```

Expected: Tests 6, 7, 8 now pass. Test 9, 10, 11 still fail (upwork/amazon/platform-health not yet done).

- [ ] **Step 4: Commit**

```bash
git add lib/scrapers/twitter.js
git commit -m "feat(twitter): replace agent-twitter-client with Nitter RSS fallback"
```

---

## Task 3: Add resolveKeyword to the 5 remaining scrapers

**Files:**
- Modify: `lib/scrapers/upwork.js`
- Modify: `lib/scrapers/github.js`
- Modify: `lib/scrapers/producthunt.js`
- Modify: `lib/scrapers/amazon.js`
- Modify: `lib/scrapers/jijing.js`

- [ ] **Step 1: upwork.js — add resolveKeyword import + call**

In `lib/scrapers/upwork.js`, add the import after the existing imports at the top:

```js
import { resolveKeyword } from '../reddit-rss.js'
```

Then replace line 11:
```js
// OLD:
const { keyword } = keywordEntry
// NEW:
const keyword = resolveKeyword(keywordEntry)
```

- [ ] **Step 2: github.js — add resolveKeyword import + call**

In `lib/scrapers/github.js`, add import at line 4 (before the function):

```js
import { resolveKeyword } from '../reddit-rss.js'
```

Replace line 5 inside `searchGitHub`:
```js
// OLD:
const { keyword, type } = keywordEntry
// NEW:
const keyword = resolveKeyword(keywordEntry)
const { type } = keywordEntry
```

- [ ] **Step 3: producthunt.js — add resolveKeyword import + call**

In `lib/scrapers/producthunt.js`, add import after the cheerio import:

```js
import { resolveKeyword } from '../reddit-rss.js'
```

Replace line 9 inside `searchProductHunt`:
```js
// OLD:
const { keyword } = keywordEntry
// NEW:
const keyword = resolveKeyword(keywordEntry)
```

- [ ] **Step 4: amazon.js — add resolveKeyword import + call**

In `lib/scrapers/amazon.js`, add import after the existing imports at the top:

```js
import { resolveKeyword } from '../reddit-rss.js'
```

Replace line 34 inside `searchAmazonReviews`:
```js
// OLD:
const { keyword } = keywordEntry || {}
// NEW:
const keyword = resolveKeyword(keywordEntry)
```

Also remove the now-redundant null check on the next line (line 38). The old code has:
```js
if (!keyword || typeof keyword !== 'string') return results
```
Keep this as-is — resolveKeyword always returns a string, so `typeof keyword !== 'string'` will never be true, but the `!keyword` check still guards against empty string. Leave it.

- [ ] **Step 5: jijing.js — add resolveKeyword import + call**

In `lib/scrapers/jijing.js`, add import after the `hashUrlToId` import:

```js
import { resolveKeyword } from '../reddit-rss.js'
```

Replace line 25 inside `searchJijiNg`:
```js
// OLD:
const { keyword } = keywordEntry || {}
// NEW:
const keyword = resolveKeyword(keywordEntry)
```

Also remove the now-redundant guard on line 29:
```js
// OLD:
if (!keyword || typeof keyword !== 'string') return results
// NEW (keep — resolveKeyword always returns string, but !keyword still guards empty):
if (!keyword) return results
```

- [ ] **Step 6: Run tests**

```bash
npm test 2>&1 | tail -8
```

Expected: same baseline count, no regressions. The jijing, upwork, amazon tests should still pass.

- [ ] **Step 7: Commit**

```bash
git add lib/scrapers/upwork.js lib/scrapers/github.js lib/scrapers/producthunt.js lib/scrapers/amazon.js lib/scrapers/jijing.js
git commit -m "fix(scrapers): use resolveKeyword in upwork, github, producthunt, amazon, jijing"
```

---

## Task 4: Create lib/platform-health.js + add admin health endpoint

**Files:**
- Create: `lib/platform-health.js`
- Modify: `api-server.js`

- [ ] **Step 1: Create lib/platform-health.js**

```js
// lib/platform-health.js — health-check runner for the admin endpoint.
// Calls each scraper in the provided map with a probe keyword and collects
// per-platform status + sample counts. Pure function — fully testable without
// Express. api-server.js wires it to GET /v1/admin/platform-health.

export async function buildHealthReport(scraperMap, keyword = 'freelance', ctx = {}) {
  const results = {}
  await Promise.allSettled(
    Object.entries(scraperMap).map(async ([id, scraper]) => {
      try {
        const items = await scraper({ keyword }, ctx)
        results[id] = {
          status:       Array.isArray(items) ? 'ok' : 'error',
          sample_count: Array.isArray(items) ? items.length : 0,
        }
      } catch (err) {
        results[id] = { status: 'error', sample_count: 0, error: err.message }
      }
    })
  )
  return results
}
```

- [ ] **Step 2: Run Test 11 — should pass now**

```bash
npm test 2>&1 | grep "Test 11\|11\."
```

Expected: Test 11 passes.

- [ ] **Step 3: Read the top of api-server.js (first 100 lines) to see all imports**

Read `api-server.js` lines 1-100 to confirm the import block before editing.

- [ ] **Step 4: Add scraper imports + PLATFORM_DISABLED + health-report import to api-server.js**

At line 87 of `api-server.js`, the platforms import currently reads:
```js
import { validatePlatforms, migrateLegacyPlatforms, VALID_PLATFORMS, PLATFORM_LABELS, PLATFORM_EMOJIS } from './lib/platforms.js'
```

Replace it with:
```js
import { validatePlatforms, migrateLegacyPlatforms, VALID_PLATFORMS, PLATFORM_LABELS, PLATFORM_EMOJIS, PLATFORM_DISABLED } from './lib/platforms.js'
```

Then add after line 99 (the last import in the block, `import { getKeywordHealth, getStaleKeywords } from './lib/keyword-health.js'`):
```js
import { buildHealthReport } from './lib/platform-health.js'
import searchHackerNews  from './lib/scrapers/hackernews.js'
import searchMedium      from './lib/scrapers/medium.js'
import searchSubstack    from './lib/scrapers/substack.js'
import searchQuora       from './lib/scrapers/quora.js'
import searchUpwork      from './lib/scrapers/upwork.js'
import searchFiverr      from './lib/scrapers/fiverr.js'
import searchGitHub      from './lib/scrapers/github.js'
import searchProductHunt from './lib/scrapers/producthunt.js'
import searchTwitter     from './lib/scrapers/twitter.js'
import searchJijiNg      from './lib/scrapers/jijing.js'
import searchYouTube     from './lib/scrapers/youtube.js'
import searchAmazonReviews from './lib/scrapers/amazon.js'
```

- [ ] **Step 5: Build the PLATFORM_SCRAPERS map + add the admin route**

Find the `/v1/platforms` route (around line 378) and add the admin route directly above it:

```js
// ── GET /v1/admin/platform-health ─────────────────────────────────────────
// Admin-only: calls each external scraper with a probe keyword and returns
// per-platform { status, sample_count, error? }. Requires EBENOVA_ADMIN_SECRET.
const PLATFORM_SCRAPERS = {
  hackernews:  searchHackerNews,
  medium:      searchMedium,
  substack:    searchSubstack,
  quora:       searchQuora,
  upwork:      searchUpwork,
  fiverr:      searchFiverr,
  github:      searchGitHub,
  producthunt: searchProductHunt,
  twitter:     searchTwitter,
  jijing:      searchJijiNg,
  youtube:     searchYouTube,
  amazon:      searchAmazonReviews,
}

app.get('/v1/admin/platform-health', async (req, res) => {
  const adminSecret = process.env.EBENOVA_ADMIN_SECRET
  const provided    = req.headers['x-admin-secret']
  if (!adminSecret || !provided || provided !== adminSecret) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }
  try {
    const ctx = {
      seenIds:    { has: () => false, add: () => {} },
      delay:      async () => {},
      MAX_AGE_MS: 24 * 60 * 60 * 1000,
    }
    const platforms = await buildHealthReport(PLATFORM_SCRAPERS, 'freelance', ctx)
    res.json({ success: true, platforms, ts: new Date().toISOString() })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})
```

- [ ] **Step 6: Run tests**

```bash
npm test 2>&1 | tail -8
```

Expected: no regressions, all 6 platform-audit tests now pass.

- [ ] **Step 7: Commit**

```bash
git add lib/platform-health.js api-server.js
git commit -m "feat(admin): platform-health endpoint + lib/platform-health.js"
```

---

## Task 5: Extend /v1/platforms + dashboard status dots

**Files:**
- Modify: `api-server.js` (the `/v1/platforms` route, ~line 378)
- Modify: `public/dashboard.html` (chip buttons, 2 locations)

- [ ] **Step 1: Read api-server.js lines 370-386**

Verify the current shape of the `/v1/platforms` route before editing.

- [ ] **Step 2: Add disabled field to /v1/platforms**

In `api-server.js`, find the `/v1/platforms` route body (the `VALID_PLATFORMS.map` call) and replace:

```js
// OLD:
  const platforms = VALID_PLATFORMS.map(id => ({
    id,
    label: PLATFORM_LABELS[id] || id,
    emoji: PLATFORM_EMOJIS[id] || '•',
  }))
// NEW:
  const platforms = VALID_PLATFORMS.map(id => ({
    id,
    label:    PLATFORM_LABELS[id] || id,
    emoji:    PLATFORM_EMOJIS[id] || '•',
    disabled: PLATFORM_DISABLED[id] || null,
  }))
```

- [ ] **Step 3: Read dashboard.html around line 2674 and 3389**

Verify the two chip-rendering locations before editing.

- [ ] **Step 4: Add status dot to chip buttons — location 1 (Find Customers wizard, ~line 2690)**

In `public/dashboard.html`, find the first chip button render (around line 2690). The current inner content is:
```jsx
<span style={{fontSize:13}}>{p.emoji}</span> {p.label}
```

Replace with:
```jsx
<span style={{fontSize:13}}>{p.emoji}</span>
{' '}{p.label}
{p.disabled && <span title={p.disabled} style={{width:7,height:7,borderRadius:'50%',background:'#F59E0B',display:'inline-block',flexShrink:0,marginLeft:4,verticalAlign:'middle'}} />}
```

- [ ] **Step 5: Add status dot to chip buttons — location 2 (Edit Monitor panel, ~line 3400)**

In `public/dashboard.html`, find the second chip button render (around line 3400). The current inner content is:
```jsx
<span style={{fontSize:13}}>{p.emoji}</span> {p.label}
```

Replace with:
```jsx
<span style={{fontSize:13}}>{p.emoji}</span>
{' '}{p.label}
{p.disabled && <span title={p.disabled} style={{width:7,height:7,borderRadius:'50%',background:'#F59E0B',display:'inline-block',flexShrink:0,marginLeft:4,verticalAlign:'middle'}} />}
```

- [ ] **Step 6: Run tests to check for regressions**

```bash
npm test 2>&1 | tail -8
```

Expected: no new failures.

- [ ] **Step 7: Commit**

```bash
git add api-server.js public/dashboard.html
git commit -m "feat(dashboard): platform status dots from /v1/platforms disabled field"
```

---

## Task 6: Update .env.example

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Read .env.example lines 100-130**

Verify the current Twitter section and Stripe section.

- [ ] **Step 2: Add EBENOVA_ADMIN_SECRET section**

After the `YOUTUBE_DAILY_MAX` line (around line 90), add a new section:

```bash
# ── Admin secret ──────────────────────────────────────────────────────────────
# Required for GET /v1/admin/platform-health. Use a long random string (e.g. openssl rand -hex 32).
# If unset, the endpoint always returns 401 — safe to leave unset until needed.
EBENOVA_ADMIN_SECRET=
```

- [ ] **Step 3: Update the Twitter section comment**

Find the `# ── Twitter/X` section (around line 111). Replace the full block:

```bash
# ── Twitter/X ─────────────────────────────────────────────────────────────────
# DEPRECATED — no longer used. The Twitter scraper now uses Nitter RSS feeds
# (no auth required). These keys are kept here for reference only; they are NOT
# read by the scraper.
# TWITTER_USERNAME=
# TWITTER_PASSWORD=
```

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "docs(env): add EBENOVA_ADMIN_SECRET; mark Twitter creds as deprecated"
```

---

## Task 7: Update test/scraper-twitter-linkedin.test.js

**Files:**
- Modify: `test/scraper-twitter-linkedin.test.js`

**Context:** The old twitter.js required `TWITTER_USERNAME` / `TWITTER_PASSWORD`. Tests 1 and 2 in this file specifically test that missing credentials → empty array. After the rewrite, credentials are not used and those tests are misleading (they'd pass by coincidence — network failure in CI — rather than by design). Remove them and keep only the shape test + platform registry tests.

- [ ] **Step 1: Read the full test file**

Read `test/scraper-twitter-linkedin.test.js` completely before editing.

- [ ] **Step 2: Remove the two credential tests + update the shape test**

Replace the twitter scraper section (tests 1-3) with:

```js
// ── Twitter scraper ────────────────────────────────────────────────────────
// Credential tests removed — the Nitter RSS implementation does not require
// TWITTER_USERNAME or TWITTER_PASSWORD (replaced agent-twitter-client).

test('twitter: result items have required shape fields when Nitter returns data', { skip: true }, async () => {
  // Manual verification only: run against a live Nitter instance.
  const r = await searchTwitter({ keyword: 'javascript' }, { seenIds: new Set(), delay: null, MAX_AGE_MS: null })
  assert.ok(Array.isArray(r))
  if (r.length === 0) return
  for (const item of r) {
    for (const f of REQUIRED_FIELDS) assert.ok(f in item, `missing field ${f}`)
    assert.equal(item.source, 'twitter')
    assert.ok(item.id.startsWith('twitter_'), `id should start with twitter_: ${item.id}`)
    assert.ok(item.url.includes('x.com'), `url should include x.com: ${item.url}`)
    assert.equal(item.approved, true)
  }
})
```

- [ ] **Step 3: Run tests**

```bash
npm test 2>&1 | tail -8
```

Expected: total count decreases by 2 (the removed tests). No failures.

- [ ] **Step 4: Commit**

```bash
git add test/scraper-twitter-linkedin.test.js
git commit -m "test(twitter): remove obsolete credential tests after Nitter RSS rewrite"
```

---

## Task 8: Run full test suite + create PR

- [ ] **Step 1: Clean test run**

```bash
npm test 2>&1 | tail -15
```

Expected output: all 6 new platform-audit tests pass, no regressions vs Task 1 baseline (minus the 2 removed credential tests). Zero failures.

- [ ] **Step 2: Verify server boots clean**

```bash
node --input-type=module --eval "import('./api-server.js').then(()=>{console.log('BOOT OK');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})" 2>&1 | head -5
```

Expected: `BOOT OK` (or the normal Railway/Express startup log, no errors).

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feat/platform-audit
```

Then create PR with the following description:

---

**PR title:** `feat(platform-audit): Nitter RSS twitter, resolveKeyword audit, admin health endpoint`

**Body:**

```
## Summary
- **Twitter rewrite:** replaced broken `agent-twitter-client` (error code 34, login endpoint changed) with Nitter RSS. Three fallback instances (`nitter.poast.org`, `nitter.privacydev.net`, `nitter.1d4.us`). No credentials needed. Graceful all-down fallback.
- **resolveKeyword audit:** added `resolveKeyword()` call to 5 scrapers that still destructured directly: upwork, github, producthunt, amazon, jijing. Prevents `[object Object]` keywords if these scrapers ever receive a keyword entry with `.term` field.
- **Admin health endpoint:** `GET /v1/admin/platform-health` — requires `X-Admin-Secret` header matching `EBENOVA_ADMIN_SECRET` env var. Calls all 12 external scrapers in parallel with keyword "freelance", returns per-platform `{ status, sample_count, error? }`.
- **Platform status dots:** `/v1/platforms` now includes `disabled` field from `PLATFORM_DISABLED`. Dashboard chip buttons show an amber dot with tooltip when a platform is disabled (currently: Quora). No second request needed.
- **`.env.example`:** added `EBENOVA_ADMIN_SECRET` section; deprecated `TWITTER_USERNAME` / `TWITTER_PASSWORD` (no longer read).

## Schema impact
None. No Redis key changes. No monitor schema changes.

## Tests
6 new tests in `test/platform-audit.test.js` (Tests 6–11):
- Test 6: `parseNitterRSS` correctly parses title, URL, author, source, approved
- Test 7: fallback to second Nitter instance on first 503
- Test 8: all instances fail → `[]`, no throw
- Test 9: Upwork HTTP error → `[]`, no throw
- Test 10: Amazon 403 → `[]`, no throw
- Test 11: `buildHealthReport` returns correct shape for ok/empty/errored scrapers

2 tests removed from `test/scraper-twitter-linkedin.test.js` (credential tests that no longer apply after Nitter rewrite).

## Spec divergences
None.
```

---

## Self-review checklist

**Spec coverage:**
- [x] Twitter rewrite with Nitter RSS + 3 fallback instances → Task 2
- [x] resolveKeyword in all 5 remaining scrapers → Task 3
- [x] `GET /v1/admin/platform-health` with `EBENOVA_ADMIN_SECRET` auth → Task 4
- [x] Platform chip status dots from `/v1/platforms` disabled field → Task 5
- [x] `.env.example` EBENOVA_ADMIN_SECRET + Twitter deprecation → Task 6
- [x] 6 new tests → Tasks 1 + 4 (Test 11 created in Task 1, passes after Task 4)
- [x] 2 obsolete tests removed → Task 7

**Placeholder scan:** No TBD, TODO, or "similar to Task N" references.

**Type consistency:**
- `resolveKeyword` always returns `string` — the `!keyword` guard on jijing/amazon is safe
- `parseNitterRSS` exported as named export + in `_internals` — Test 6 uses `twitterInternals.parseNitterRSS` directly ✓
- `buildHealthReport(scraperMap, keyword, ctx)` — Test 11 calls with matching signature ✓
- `PLATFORM_DISABLED` exported from `lib/platforms.js` — already exists from PR #54 ✓
- `disabled` field added to `/v1/platforms` response — dashboard reads `p.disabled` ✓
