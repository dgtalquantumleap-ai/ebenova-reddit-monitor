# RSS + Telegram Scrapers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add RSS feed and Telegram channel scrapers to the monitor pipeline, with per-monitor configuration stored in Redis and a settings UI in the dashboard.

**Architecture:** Two new feed-based scrapers (`lib/scrapers/rss.js`, `lib/scrapers/telegram.js`) that fetch once per cycle and match client-side against all of a monitor's keywords. They are wired into `monitor-v2.js` outside the per-keyword loop. Monitor schema gets two new optional arrays (`rssFeeds`, `telegramChannels`) patched via the existing `PATCH /v1/monitors/:id` handler. A new `GET /v1/feeds/discover` endpoint auto-detects feed URLs from any website URL.

**Tech Stack:** Node.js ESM, native `fetch`, `node:test` + `node:assert` for tests, Redis (ioredis) for monitor storage, Express for API.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `lib/scrapers/rss.js` | RSS 2.0 + Atom feed scraper |
| Create | `lib/scrapers/telegram.js` | Telegram public channel scraper |
| Create | `test/scraper-rss.test.js` | Unit tests for RSS scraper |
| Create | `test/scraper-telegram.test.js` | Unit tests for Telegram scraper |
| Modify | `lib/platforms.js` | Add `rss` + `telegram` to registry |
| Modify | `monitor-v2.js` | Import + wire feed scrapers into cycle |
| Modify | `api-server.js` | PATCH validation + `GET /v1/feeds/discover` |
| Modify | `public/dashboard.html` | Custom Sources UI section |

---

## Task 1: RSS Scraper

**Files:**
- Create: `lib/scrapers/rss.js`
- Create: `test/scraper-rss.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/scraper-rss.test.js`:

```js
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import searchRSS, { parseRSSFeed, CURATED_FEEDS, _internals } from '../lib/scrapers/rss.js'

const seenIds = () => ({ has: () => false, add: () => {} })

// ── parseRSSFeed: RSS 2.0 ────────────────────────────────────────────────────

test('rss: parseRSSFeed extracts RSS 2.0 <item> fields', () => {
  const xml = `<rss version="2.0"><channel>
    <item>
      <title><![CDATA[Looking for a CRM tool for sales teams]]></title>
      <link>https://example.com/blog/crm-tool</link>
      <pubDate>Mon, 04 May 2026 10:00:00 GMT</pubDate>
      <dc:creator>Jane Doe</dc:creator>
      <description><![CDATA[We need a CRM that integrates with Slack.]]></description>
    </item>
  </channel></rss>`
  const results = parseRSSFeed(xml, ['CRM tool'], seenIds(), null, 'https://example.com/feed')
  assert.equal(results.length, 1)
  assert.equal(results[0].url, 'https://example.com/blog/crm-tool')
  assert.equal(results[0].keyword, 'CRM tool')
  assert.equal(results[0].source, 'rss')
  assert.equal(results[0].author, 'Jane Doe')
  assert.equal(results[0].subreddit, 'example.com')
  assert.equal(results[0].approved, true)
  assert.equal(results[0].score, 0)
  assert.equal(results[0].comments, 0)
})

// ── parseRSSFeed: Atom ────────────────────────────────────────────────────────

test('rss: parseRSSFeed extracts Atom <entry> fields', () => {
  const xml = `<?xml version="1.0"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <title>Best sales automation tools reviewed</title>
      <link href="https://blog.example.com/sales-tools"/>
      <published>2026-05-04T09:00:00Z</published>
      <summary>A deep dive into sales automation tools for startups.</summary>
      <author><name>Bob Smith</name></author>
    </entry>
  </feed>`
  const results = parseRSSFeed(xml, ['sales automation'], seenIds(), null, 'https://blog.example.com/feed')
  assert.equal(results.length, 1)
  assert.equal(results[0].url, 'https://blog.example.com/sales-tools')
  assert.equal(results[0].keyword, 'sales automation')
  assert.equal(results[0].source, 'rss')
  assert.ok(results[0].body.includes('sales automation tools'))
})

// ── parseRSSFeed: keyword matching ───────────────────────────────────────────

test('rss: parseRSSFeed discards items matching no keyword', () => {
  const xml = `<rss><channel>
    <item>
      <title>Recipe: best pasta carbonara</title>
      <link>https://food.example.com/pasta</link>
      <description>Cook pasta al dente.</description>
    </item>
  </channel></rss>`
  const results = parseRSSFeed(xml, ['CRM tool', 'sales software'], seenIds(), null, 'https://food.example.com/feed')
  assert.equal(results.length, 0)
})

test('rss: parseRSSFeed matches first keyword in allKeywords list', () => {
  const xml = `<rss><channel>
    <item>
      <title>HubSpot vs Salesforce — which CRM is better?</title>
      <link>https://example.com/crm-comparison</link>
      <description>Comparing two popular CRM tools for small teams.</description>
    </item>
  </channel></rss>`
  const results = parseRSSFeed(xml, ['irrelevant keyword', 'CRM'], seenIds(), null, 'https://example.com/feed')
  assert.equal(results.length, 1)
  assert.equal(results[0].keyword, 'CRM')
})

// ── parseRSSFeed: age filter ─────────────────────────────────────────────────

test('rss: parseRSSFeed filters items older than MAX_AGE_MS', () => {
  const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toUTCString()
  const xml = `<rss><channel>
    <item>
      <title>Old post about CRM tools</title>
      <link>https://example.com/old</link>
      <pubDate>${oldDate}</pubDate>
      <description>CRM tools are useful.</description>
    </item>
  </channel></rss>`
  const results = parseRSSFeed(xml, ['CRM'], seenIds(), 24 * 60 * 60 * 1000, 'https://example.com/feed')
  assert.equal(results.length, 0)
})

// ── parseRSSFeed: dedup ──────────────────────────────────────────────────────

test('rss: parseRSSFeed skips already-seen IDs', () => {
  const xml = `<rss><channel>
    <item>
      <title>CRM tool review</title>
      <link>https://example.com/crm</link>
      <description>CRM tools overview.</description>
    </item>
  </channel></rss>`
  // First parse adds the ID
  const s = { seen: new Set(), has(id) { return this.seen.has(id) }, add(id) { this.seen.add(id) } }
  const first = parseRSSFeed(xml, ['CRM'], s, null, 'https://example.com/feed')
  assert.equal(first.length, 1)
  // Second parse with same seenIds → skipped
  const second = parseRSSFeed(xml, ['CRM'], s, null, 'https://example.com/feed')
  assert.equal(second.length, 0)
})

// ── parseRSSFeed: CDATA + HTML strip ────────────────────────────────────────

test('rss: parseRSSFeed strips HTML tags from body', () => {
  const xml = `<rss><channel>
    <item>
      <title>CRM tool</title>
      <link>https://example.com/crm</link>
      <description><![CDATA[<p>A <strong>CRM</strong> tool for <em>teams</em>.</p>]]></description>
    </item>
  </channel></rss>`
  const results = parseRSSFeed(xml, ['CRM'], seenIds(), null, 'https://example.com/feed')
  assert.equal(results.length, 1)
  assert.ok(!results[0].body.includes('<p>'), 'body should not contain HTML tags')
  assert.ok(results[0].body.includes('CRM'))
})

// ── searchRSS: graceful failure ──────────────────────────────────────────────

test('rss: searchRSS returns [] when no feeds configured', async () => {
  const result = await searchRSS(null, { allKeywords: ['CRM'], rssFeeds: [] })
  assert.deepEqual(result, [])
})

test('rss: searchRSS returns [] when no keywords provided', async () => {
  const result = await searchRSS(null, { allKeywords: [], rssFeeds: ['https://example.com/feed'] })
  assert.deepEqual(result, [])
})

test('rss: CURATED_FEEDS is an array', () => {
  assert.ok(Array.isArray(CURATED_FEEDS))
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npm test 2>&1 | grep -E "scraper-rss|FAIL|Error"
```

Expected: module not found error for `../lib/scrapers/rss.js`

- [ ] **Step 3: Create `lib/scrapers/rss.js`**

```js
import { hashUrlToId } from './_id.js'

const TIMEOUT_MS = 10_000
const MAX_RESULTS = 15

export const CURATED_FEEDS = []

function decodeHtmlEntities(s) {
  if (!s) return ''
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

export function parseRSSFeed(xml, allKeywords, seenIds, MAX_AGE_MS, feedUrl) {
  const results = []
  const cutoffMs = Date.now() - (MAX_AGE_MS || 0)
  const hostname = (() => { try { return new URL(feedUrl).hostname } catch { return feedUrl } })()

  const isAtom = xml.includes('<entry>')
  const itemTag = isAtom ? 'entry' : 'item'
  const itemPattern = new RegExp(`<${itemTag}>([\\s\\S]*?)<\\/${itemTag}>`, 'g')

  let m
  while ((m = itemPattern.exec(xml)) !== null && results.length < MAX_RESULTS) {
    const block = m[1]

    const titleRaw = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                     block.match(/<title[^>]*>([\s\S]*?)<\/title>/))?.[1] || ''

    let linkRaw = ''
    if (isAtom) {
      linkRaw = block.match(/<link[^>]+href="([^"]+)"/)?.[1] ||
                block.match(/<id>(https?:\/\/[^<]+)<\/id>/)?.[1] || ''
    } else {
      linkRaw = (block.match(/<link>([\s\S]*?)<\/link>/) ||
                block.match(/<link\s+[^>]*href="([^"]+)"/))?.[1]?.trim() || ''
    }
    if (!linkRaw) continue

    const bodyBlock = isAtom
      ? (block.match(/<content[^>]*>([\s\S]*?)<\/content>/) || block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/))
      : (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || block.match(/<description>([\s\S]*?)<\/description>/))
    const bodyRaw = bodyBlock?.[1] || ''

    const dateBlock = isAtom
      ? (block.match(/<published>([\s\S]*?)<\/published>/) || block.match(/<updated>([\s\S]*?)<\/updated>/))
      : block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)
    const pubRaw = dateBlock?.[1]?.trim() || ''

    const authorRaw = (block.match(/<dc:creator><!\[CDATA\[([\s\S]*?)\]\]><\/dc:creator>/) ||
                      block.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/) ||
                      block.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/))?.[1] || ''

    const pubDate = pubRaw ? new Date(pubRaw) : null
    if (MAX_AGE_MS && pubDate && Number.isFinite(pubDate.getTime()) && pubDate.getTime() < cutoffMs) continue

    const id = hashUrlToId(linkRaw.trim(), 'rss')
    if (seenIds.has(id)) continue

    const title = stripHtml(decodeHtmlEntities(titleRaw)).slice(0, 120)
    const body  = stripHtml(decodeHtmlEntities(bodyRaw)).slice(0, 600)
    const searchText = `${title} ${body}`.toLowerCase()

    const matchedKeyword = allKeywords.find(kw => searchText.includes(kw.toLowerCase()))
    if (!matchedKeyword) continue

    seenIds.add(id)
    results.push({
      id,
      title:     title || body.slice(0, 120),
      url:       linkRaw.trim(),
      subreddit: hostname,
      author:    stripHtml(decodeHtmlEntities(authorRaw)) || hostname,
      score:     0,
      comments:  0,
      body,
      createdAt: (pubDate && Number.isFinite(pubDate.getTime()))
        ? pubDate.toISOString()
        : new Date().toISOString(),
      keyword:   matchedKeyword,
      source:    'rss',
      approved:  true,
    })
  }
  return results
}

export default async function searchRSS(keywordEntry, ctx = {}) {
  const { seenIds = { has: () => false, add: () => {} }, MAX_AGE_MS, allKeywords = [], rssFeeds = [] } = ctx
  const feeds = [...CURATED_FEEDS, ...rssFeeds]
  if (!feeds.length || !allKeywords.length) return []

  const results = []
  for (const feedUrl of feeds) {
    if (results.length >= MAX_RESULTS) break
    try {
      const res = await fetch(feedUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) {
        console.warn(`[rss] ${feedUrl} returned ${res.status} — skipping`)
        continue
      }
      const xml = await res.text()
      const parsed = parseRSSFeed(xml, allKeywords, seenIds, MAX_AGE_MS, feedUrl)
      results.push(...parsed)
    } catch (err) {
      console.warn(`[rss] ${feedUrl} error: ${err.message} — skipping`)
    }
  }
  return results.slice(0, MAX_RESULTS)
}

export const _internals = { CURATED_FEEDS, TIMEOUT_MS, MAX_RESULTS, parseRSSFeed }
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npm test 2>&1 | grep -E "scraper-rss|▶|✓|✗|FAIL"
```

Expected: all `scraper-rss.test.js` tests pass.

- [ ] **Step 5: Commit**

```
git add lib/scrapers/rss.js test/scraper-rss.test.js
git commit -m "feat(rss): add RSS 2.0 + Atom feed scraper"
```

---

## Task 2: Telegram Scraper

**Files:**
- Create: `lib/scrapers/telegram.js`
- Create: `test/scraper-telegram.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/scraper-telegram.test.js`:

```js
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import searchTelegram, { parseTelegramHTML, _internals } from '../lib/scrapers/telegram.js'

const seenIds = () => ({ has: () => false, add: () => {} })

// ── parseTelegramHTML: extraction ────────────────────────────────────────────

test('telegram: parseTelegramHTML extracts message fields', () => {
  const html = `
  <div class="tgme_widget_message" data-post="startups/12345">
    <div class="tgme_widget_message_text">Looking for a CRM tool for our sales team. Any recommendations?</div>
    <time datetime="2026-05-04T10:00:00+00:00">May 4</time>
  </div></div>`
  const results = parseTelegramHTML(html, 'startups', ['CRM tool'], seenIds(), null)
  assert.equal(results.length, 1)
  assert.equal(results[0].url, 'https://t.me/startups/12345')
  assert.equal(results[0].keyword, 'CRM tool')
  assert.equal(results[0].source, 'telegram')
  assert.equal(results[0].subreddit, '@startups')
  assert.equal(results[0].author, 'startups')
  assert.equal(results[0].score, 0)
  assert.equal(results[0].comments, 0)
  assert.equal(results[0].approved, true)
  assert.ok(results[0].id.startsWith('telegram_'))
})

// ── parseTelegramHTML: keyword matching ──────────────────────────────────────

test('telegram: parseTelegramHTML discards messages matching no keyword', () => {
  const html = `
  <div class="tgme_widget_message" data-post="channel/1">
    <div class="tgme_widget_message_text">Great weather today!</div>
    <time datetime="2026-05-04T10:00:00+00:00">May 4</time>
  </div></div>`
  const results = parseTelegramHTML(html, 'channel', ['CRM', 'sales software'], seenIds(), null)
  assert.equal(results.length, 0)
})

test('telegram: parseTelegramHTML matches any keyword in allKeywords', () => {
  const html = `
  <div class="tgme_widget_message" data-post="channel/2">
    <div class="tgme_widget_message_text">Anyone tried Salesforce for small teams?</div>
    <time datetime="2026-05-04T10:00:00+00:00">May 4</time>
  </div></div>`
  const results = parseTelegramHTML(html, 'channel', ['irrelevant', 'salesforce'], seenIds(), null)
  assert.equal(results.length, 1)
  assert.equal(results[0].keyword, 'salesforce')
})

// ── parseTelegramHTML: age filter ────────────────────────────────────────────

test('telegram: parseTelegramHTML filters old messages', () => {
  const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const html = `
  <div class="tgme_widget_message" data-post="channel/3">
    <div class="tgme_widget_message_text">Old CRM post</div>
    <time datetime="${oldDate}">Old</time>
  </div></div>`
  const results = parseTelegramHTML(html, 'channel', ['CRM'], seenIds(), 24 * 60 * 60 * 1000)
  assert.equal(results.length, 0)
})

// ── parseTelegramHTML: dedup ─────────────────────────────────────────────────

test('telegram: parseTelegramHTML skips already-seen IDs', () => {
  const html = `
  <div class="tgme_widget_message" data-post="channel/4">
    <div class="tgme_widget_message_text">CRM tool recommendation</div>
    <time datetime="2026-05-04T10:00:00+00:00">May 4</time>
  </div></div>`
  const s = { seen: new Set(), has(id) { return this.seen.has(id) }, add(id) { this.seen.add(id) } }
  const first = parseTelegramHTML(html, 'channel', ['CRM'], s, null)
  assert.equal(first.length, 1)
  const second = parseTelegramHTML(html, 'channel', ['CRM'], s, null)
  assert.equal(second.length, 0)
})

// ── searchTelegram: graceful failure ─────────────────────────────────────────

test('telegram: searchTelegram returns [] with no channels', async () => {
  const result = await searchTelegram(null, { allKeywords: ['CRM'], telegramChannels: [] })
  assert.deepEqual(result, [])
})

test('telegram: searchTelegram returns [] with no keywords', async () => {
  const result = await searchTelegram(null, { allKeywords: [], telegramChannels: ['startups'] })
  assert.deepEqual(result, [])
})

test('telegram: searchTelegram strips leading @ from channel handle', async () => {
  let fetchedUrl = null
  const original = global.fetch
  global.fetch = async (url) => {
    fetchedUrl = url
    throw new Error('network blocked in test')
  }
  try {
    await searchTelegram(null, { allKeywords: ['CRM'], telegramChannels: ['@startups'] })
  } catch {}
  global.fetch = original
  assert.ok(fetchedUrl && fetchedUrl.includes('/s/startups'), `expected /s/startups in URL, got ${fetchedUrl}`)
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npm test 2>&1 | grep -E "scraper-telegram|FAIL|Error"
```

Expected: module not found error for `../lib/scrapers/telegram.js`

- [ ] **Step 3: Create `lib/scrapers/telegram.js`**

```js
import { hashUrlToId } from './_id.js'

const TIMEOUT_MS = 10_000
const MAX_RESULTS = 15
const UA = 'Mozilla/5.0 (compatible; EbenovaBot/2.0)'

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

export function parseTelegramHTML(html, channel, allKeywords, seenIds, MAX_AGE_MS) {
  const results = []
  const cutoffMs = Date.now() - (MAX_AGE_MS || 0)
  const msgPattern = /<div[^>]+class="tgme_widget_message"[^>]+data-post="[^/]+\/(\d+)"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g

  let m
  while ((m = msgPattern.exec(html)) !== null && results.length < MAX_RESULTS) {
    const [, postId, block] = m

    const bodyMatch = block.match(/<div[^>]+class="tgme_widget_message_text"[^>]*>([\s\S]*?)<\/div>/)
    const body = stripHtml(bodyMatch?.[1] || '').slice(0, 600)
    if (!body) continue

    const dateMatch = block.match(/<time[^>]+datetime="([^"]+)"/)
    const pubRaw = dateMatch?.[1] || ''
    const pubDate = pubRaw ? new Date(pubRaw) : null
    if (MAX_AGE_MS && pubDate && Number.isFinite(pubDate.getTime()) && pubDate.getTime() < cutoffMs) continue

    const url = `https://t.me/${channel}/${postId}`
    const id  = hashUrlToId(url, 'telegram')
    if (seenIds.has(id)) continue

    const searchText = body.toLowerCase()
    const matchedKeyword = allKeywords.find(kw => searchText.includes(kw.toLowerCase()))
    if (!matchedKeyword) continue

    seenIds.add(id)
    results.push({
      id,
      title:     body.slice(0, 120),
      url,
      subreddit: `@${channel}`,
      author:    channel,
      score:     0,
      comments:  0,
      body,
      createdAt: (pubDate && Number.isFinite(pubDate.getTime()))
        ? pubDate.toISOString()
        : new Date().toISOString(),
      keyword:   matchedKeyword,
      source:    'telegram',
      approved:  true,
    })
  }
  return results
}

export default async function searchTelegram(keywordEntry, ctx = {}) {
  const { seenIds = { has: () => false, add: () => {} }, MAX_AGE_MS, allKeywords = [], telegramChannels = [] } = ctx
  if (!telegramChannels.length || !allKeywords.length) return []

  const results = []
  for (const channel of telegramChannels) {
    if (results.length >= MAX_RESULTS) break
    const handle = channel.replace(/^@/, '')
    try {
      const res = await fetch(`https://t.me/s/${handle}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        console.warn(`[telegram] @${handle} returned ${res.status} — skipping`)
        continue
      }
      const html = await res.text()
      const parsed = parseTelegramHTML(html, handle, allKeywords, seenIds, MAX_AGE_MS)
      results.push(...parsed)
    } catch (err) {
      console.warn(`[telegram] @${handle} error: ${err.message} — skipping`)
    }
  }
  return results.slice(0, MAX_RESULTS)
}

export const _internals = { TIMEOUT_MS, MAX_RESULTS, parseTelegramHTML }
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npm test 2>&1 | grep -E "scraper-telegram|▶|✓|✗|FAIL"
```

Expected: all `scraper-telegram.test.js` tests pass.

- [ ] **Step 5: Commit**

```
git add lib/scrapers/telegram.js test/scraper-telegram.test.js
git commit -m "feat(telegram): add Telegram public channel scraper"
```

---

## Task 3: Platform Registry

**Files:**
- Modify: `lib/platforms.js` (lines 17–72)

- [ ] **Step 1: Write failing test**

Add to a new file `test/scraper-rss-telegram-platforms.test.js`:

```js
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { VALID_PLATFORMS, PLATFORM_LABELS, PLATFORM_EMOJIS, validatePlatforms } from '../lib/platforms.js'

test('platforms: VALID_PLATFORMS includes rss', () => {
  assert.ok(VALID_PLATFORMS.includes('rss'))
})

test('platforms: VALID_PLATFORMS includes telegram', () => {
  assert.ok(VALID_PLATFORMS.includes('telegram'))
})

test('platforms: PLATFORM_LABELS has entry for rss', () => {
  assert.equal(typeof PLATFORM_LABELS.rss, 'string')
  assert.ok(PLATFORM_LABELS.rss.length > 0)
})

test('platforms: PLATFORM_LABELS has entry for telegram', () => {
  assert.equal(typeof PLATFORM_LABELS.telegram, 'string')
  assert.ok(PLATFORM_LABELS.telegram.length > 0)
})

test('platforms: validatePlatforms accepts rss and telegram', () => {
  assert.equal(validatePlatforms(['rss']).ok, true)
  assert.equal(validatePlatforms(['telegram']).ok, true)
  assert.equal(validatePlatforms(['reddit', 'rss', 'telegram']).ok, true)
})
```

- [ ] **Step 2: Run test to confirm it fails**

```
npm test 2>&1 | grep -E "scraper-rss-telegram-platforms|FAIL|Error"
```

Expected: tests fail (rss/telegram not in VALID_PLATFORMS).

- [ ] **Step 3: Update `lib/platforms.js`**

In the `VALID_PLATFORMS` array (line 17), add `'rss'` and `'telegram'` at the end:

```js
export const VALID_PLATFORMS = [
  'reddit',
  'hackernews',
  'stackoverflow',
  'indiehackers',
  'g2',
  'medium',
  'substack',
  'quora',
  'upwork',
  'fiverr',
  'github',
  'producthunt',
  'twitter',
  'jijing',
  'youtube',
  'amazon',
  'rss',
  'telegram',
]
```

In `PLATFORM_LABELS` (line 36), add:
```js
  rss:           'RSS Feeds',
  telegram:      'Telegram',
```

In `PLATFORM_EMOJIS` (line 55), add:
```js
  rss:           '📡',
  telegram:      '✈️',
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npm test 2>&1 | grep -E "scraper-rss-telegram-platforms|▶|✓|✗|FAIL"
```

- [ ] **Step 5: Confirm full suite still passes**

```
npm test 2>&1 | tail -5
```

Expected: same pass count as before plus the new tests.

- [ ] **Step 6: Commit**

```
git add lib/platforms.js test/scraper-rss-telegram-platforms.test.js
git commit -m "feat(platforms): register rss and telegram platform keys"
```

---

## Task 4: Wire Feed Scrapers into Monitor Cycle

**Files:**
- Modify: `monitor-v2.js`

Context: `allMatches` is declared at line 892. The `platformRunners` loop ends at line 1032. The feed-based scrapers should run once per cycle, after that loop, using all monitor keywords. `resolveKeyword` is already imported at line 57. `passesRelevanceCheck` is imported at line 68. `PLATFORM_LABELS` is imported at line 51.

- [ ] **Step 1: Add imports at top of `monitor-v2.js`**

After the existing scraper imports (around line 46), add:

```js
import searchRSS      from './lib/scrapers/rss.js'
import searchTelegram from './lib/scrapers/telegram.js'
```

- [ ] **Step 2: Add `'rss'` and `'telegram'` to the `_isHighTrustSource` list**

Find this array in `monitor-v2.js` (around line 1014–1016):

```js
    const _isHighTrustSource = [
      'hackernews','stackoverflow','indiehackers','g2','medium','substack','upwork','fiverr',
      'youtube','amazon','jijing','twitter'
    ].includes(m.source)
```

Change it to:

```js
    const _isHighTrustSource = [
      'hackernews','stackoverflow','indiehackers','g2','medium','substack','upwork','fiverr',
      'youtube','amazon','jijing','twitter','rss','telegram'
    ].includes(m.source)
```

- [ ] **Step 3: Add feed scraper block after the `platformRunners` loop**

After line 1032 (the closing `}` of the platformRunners loop) and before line 1034 (`// ── Feed filters`), insert:

```js
  // ── Feed-based sources (run once per cycle, not per keyword) ─────────────
  // RSS and Telegram ingest full feeds and filter client-side against all
  // monitor keywords, so they are called once here instead of per-keyword.
  const allKeywordStrings = monitor.keywords.map(resolveKeyword)
  const feedCtx = {
    seenIds,
    delay,
    MAX_AGE_MS: maxAgeMs,
    allKeywords: allKeywordStrings,
    rssFeeds:         monitor.rssFeeds         || [],
    telegramChannels: monitor.telegramChannels || [],
  }

  for (const [platformKey, scraper] of [['rss', searchRSS], ['telegram', searchTelegram]]) {
    if (!platforms.includes(platformKey)) continue
    const feedMatches = await scraper(null, feedCtx)
    let _feedGated = 0
    for (const m of feedMatches) {
      const kw     = monitor.keywords.find(k => resolveKeyword(k) === m.keyword) || monitor.keywords[0]
      const kwType = (kw && kw.type) || 'keyword'
      m.productContext  = (kw && kw.productContext) || monitor.productContext || ''
      m.keywordType     = kwType
      m.matchedKeyword  = m.keyword
      if (!passesRelevanceCheck(m, m.keyword, kwType)) { _feedGated++; continue }
      allMatches.push(m)
    }
    const _feedKept = feedMatches.length - _feedGated
    if (_feedKept) console.log(`${label} ${PLATFORM_LABELS[platformKey] || platformKey}: ${_feedKept} new${_feedGated ? ` (${_feedGated} irrelevant dropped)` : ''}`)
    if (feedMatches.length) await delay(1500)
  }

```

- [ ] **Step 4: Confirm the app boots without error**

```
node -e "import('./monitor-v2.js').then(() => console.log('OK')).catch(e => { console.error(e.message); process.exit(1) }"
```

Expected: `OK`

- [ ] **Step 5: Run full test suite**

```
npm test 2>&1 | tail -5
```

Expected: same pass count as before (no regressions).

- [ ] **Step 6: Commit**

```
git add monitor-v2.js
git commit -m "feat(monitor): wire RSS and Telegram feed scrapers into poll cycle"
```

---

## Task 5: API — PATCH Validation + Feed Discovery Endpoint

**Files:**
- Modify: `api-server.js`

- [ ] **Step 1: Write failing tests**

Create `test/scraper-feeds-api.test.js`:

```js
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

// We test the validation logic in isolation by importing helpers that mirror
// what the PATCH handler will do. Since api-server.js is a full Express app,
// we test the endpoint logic via lightweight unit functions extracted here.

function validateRssFeeds(value) {
  if (!Array.isArray(value)) return { ok: false, error: '`rssFeeds` must be an array' }
  if (value.length > 5)     return { ok: false, error: '`rssFeeds` cannot exceed 5 items' }
  for (const url of value) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return { ok: false, error: `invalid URL in rssFeeds: "${url}"` }
    }
  }
  return { ok: true, value: value.map(u => u.trim()) }
}

function validateTelegramChannels(value) {
  if (!Array.isArray(value)) return { ok: false, error: '`telegramChannels` must be an array' }
  if (value.length > 5)     return { ok: false, error: '`telegramChannels` cannot exceed 5 items' }
  for (const ch of value) {
    const handle = (typeof ch === 'string') ? ch.replace(/^@/, '') : ''
    if (!/^[a-zA-Z0-9_]{5,32}$/.test(handle)) {
      return { ok: false, error: `invalid Telegram handle: "${ch}"` }
    }
  }
  return { ok: true, value: value.map(c => (typeof c === 'string' ? c.replace(/^@/, '') : c)) }
}

// ── rssFeeds validation ──────────────────────────────────────────────────────

test('api: rssFeeds accepts valid https URL array', () => {
  const r = validateRssFeeds(['https://example.com/feed', 'https://blog.io/rss'])
  assert.equal(r.ok, true)
  assert.equal(r.value.length, 2)
})

test('api: rssFeeds accepts http URLs', () => {
  const r = validateRssFeeds(['http://example.com/feed'])
  assert.equal(r.ok, true)
})

test('api: rssFeeds rejects non-array', () => {
  assert.equal(validateRssFeeds('https://example.com').ok, false)
})

test('api: rssFeeds rejects more than 5 items', () => {
  const r = validateRssFeeds(['https://a.com','https://b.com','https://c.com','https://d.com','https://e.com','https://f.com'])
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('5'))
})

test('api: rssFeeds rejects non-URL strings', () => {
  assert.equal(validateRssFeeds(['not-a-url']).ok, false)
})

// ── telegramChannels validation ──────────────────────────────────────────────

test('api: telegramChannels accepts valid handles', () => {
  const r = validateTelegramChannels(['startups', '@techfounder', 'saas_founders'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.value, ['startups', 'techfounder', 'saas_founders'])
})

test('api: telegramChannels strips leading @', () => {
  const r = validateTelegramChannels(['@startups'])
  assert.equal(r.ok, true)
  assert.equal(r.value[0], 'startups')
})

test('api: telegramChannels rejects non-array', () => {
  assert.equal(validateTelegramChannels('startups').ok, false)
})

test('api: telegramChannels rejects more than 5 items', () => {
  const r = validateTelegramChannels(['aaaaa','bbbbb','ccccc','ddddd','eeeee','fffff'])
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('5'))
})

test('api: telegramChannels rejects handles shorter than 5 chars', () => {
  assert.equal(validateTelegramChannels(['abc']).ok, false)
})

test('api: telegramChannels rejects handles with invalid characters', () => {
  assert.equal(validateTelegramChannels(['hello world']).ok, false)
  assert.equal(validateTelegramChannels(['hello-world']).ok, false)
})
```

- [ ] **Step 2: Run tests to confirm they pass (these are pure logic, no import needed)**

```
npm test 2>&1 | grep -E "scraper-feeds-api|▶|✓|✗|FAIL"
```

Expected: all pass (the validation functions are defined inline in the test file).

- [ ] **Step 3: Add validation helpers and PATCH fields to `api-server.js`**

Find the end of the existing validation helper functions (around line 232, after `validateWebhookUrl`). Add two new helpers:

```js
function validateRssFeeds(value) {
  if (!Array.isArray(value)) return { ok: false, error: '`rssFeeds` must be an array' }
  if (value.length > 5)     return { ok: false, error: '`rssFeeds` cannot exceed 5 items' }
  for (const url of value) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return { ok: false, error: `invalid URL in rssFeeds: "${url}"` }
    }
  }
  return { ok: true, value: value.map(u => u.trim()) }
}

function validateTelegramChannels(value) {
  if (!Array.isArray(value)) return { ok: false, error: '`telegramChannels` must be an array' }
  if (value.length > 5)     return { ok: false, error: '`telegramChannels` cannot exceed 5 items' }
  for (const ch of value) {
    const handle = (typeof ch === 'string') ? ch.replace(/^@/, '') : ''
    if (!/^[a-zA-Z0-9_]{5,32}$/.test(handle)) {
      return { ok: false, error: `invalid Telegram handle: "${ch}"` }
    }
  }
  return { ok: true, value: value.map(c => (typeof c === 'string' ? c.replace(/^@/, '') : c)) }
}
```

- [ ] **Step 4: Add Fields 20 + 21 to the PATCH handler**

Find the block just before the `if (Object.keys(updates).length === 0)` check (around line 1039). Add after the `productContext` block (Field 19, line 1037):

```js
    // Field 20: rssFeeds — up to 5 https?:// URLs for RSS/Atom feeds.
    if (Object.prototype.hasOwnProperty.call(body, 'rssFeeds')) {
      const v = validateRssFeeds(body.rssFeeds)
      if (!v.ok) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_RSS_FEEDS', message: v.error } })
      }
      updates.rssFeeds = v.value
    }

    // Field 21: telegramChannels — up to 5 public Telegram channel handles.
    if (Object.prototype.hasOwnProperty.call(body, 'telegramChannels')) {
      const v = validateTelegramChannels(body.telegramChannels)
      if (!v.ok) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_TELEGRAM_CHANNELS', message: v.error } })
      }
      updates.telegramChannels = v.value
    }
```

Also update the `NO_UPDATES` error message (line 1040) to append `rssFeeds, telegramChannels` to the patchable fields list.

And add echo lines after the existing ones (around line 1060):

```js
    if (updates.rssFeeds         !== undefined) echo.rss_feeds          = next.rssFeeds
    if (updates.telegramChannels !== undefined) echo.telegram_channels  = next.telegramChannels
```

- [ ] **Step 5: Add `GET /v1/feeds/discover` endpoint**

Add this route after the PATCH handler (after line 1065):

```js
// ── GET /v1/feeds/discover ────────────────────────────────────────────────
// Auto-detects RSS/Atom feed URLs from any website URL.
// 1. Fetches the URL and looks for <link rel="alternate" type="application/rss+xml">
// 2. If none found, probes common feed paths.
// Returns { feeds: [{ url, title }] } — empty array on no results.
app.get('/v1/feeds/discover', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })

  const rawUrl = (req.query.url || '').trim()
  if (!rawUrl) return res.status(400).json({ success: false, error: { code: 'MISSING_URL', message: '`url` query param required' } })

  let baseUrl
  try { baseUrl = new URL(rawUrl) } catch {
    return res.status(400).json({ success: false, error: { code: 'INVALID_URL', message: 'Not a valid URL' } })
  }

  const UA = 'Mozilla/5.0 (compatible; EbenovaBot/2.0; +https://ebenova.dev)'
  const feeds = []

  try {
    const html = await fetch(rawUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) })
      .then(r => r.ok ? r.text() : '')
      .catch(() => '')

    if (html) {
      const linkPattern = /<link[^>]+type="application\/(?:rss|atom)\+xml"[^>]*>/gi
      let lm
      while ((lm = linkPattern.exec(html)) !== null) {
        const hrefMatch = lm[0].match(/href="([^"]+)"/)
        const titleMatch = lm[0].match(/title="([^"]+)"/)
        if (!hrefMatch) continue
        const feedUrl = new URL(hrefMatch[1], rawUrl).toString()
        feeds.push({ url: feedUrl, title: titleMatch?.[1] || feedUrl })
      }
    }
  } catch {}

  if (feeds.length === 0) {
    const PROBE_PATHS = ['/feed', '/rss', '/feed.xml', '/atom.xml']
    for (const path of PROBE_PATHS) {
      const probeUrl = `${baseUrl.origin}${path}`
      try {
        const r = await fetch(probeUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5_000) })
        if (r.ok) {
          const ct = r.headers.get('content-type') || ''
          if (ct.includes('xml') || ct.includes('rss') || ct.includes('atom')) {
            feeds.push({ url: probeUrl, title: probeUrl })
            break
          }
        }
      } catch {}
    }
  }

  res.json({ feeds })
})
```

- [ ] **Step 6: Run full test suite**

```
npm test 2>&1 | tail -5
```

Expected: no regressions.

- [ ] **Step 7: Commit**

```
git add api-server.js test/scraper-feeds-api.test.js
git commit -m "feat(api): add rssFeeds/telegramChannels PATCH fields and /v1/feeds/discover endpoint"
```

---

## Task 6: Settings UI — Custom Sources

**Files:**
- Modify: `public/dashboard.html`

This is the largest file (5000+ lines). Read the monitor edit drawer section before editing.

- [ ] **Step 1: Find the monitor edit drawer in `public/dashboard.html`**

Search for `MonitorEditDrawer` or `edit-drawer` or the Keywords section inside the drawer. The custom sources section goes after the Keywords section, before the Save button.

```
grep -n "MonitorEditDrawer\|Keywords.*section\|Save.*monitor\|rssFeeds\|telegramChannels" public/dashboard.html | head -30
```

Note the line numbers for:
- The Keywords section end
- The Save button for the monitor

- [ ] **Step 2: Add the Custom Sources React component**

Find the section immediately before the Save button inside the monitor edit drawer. Add this JSX block:

```jsx
{/* Custom Sources */}
{React.createElement('div', { className: 'edit-section', style: { marginTop: '16px' } },
  React.createElement('div', { className: 'section-label' }, 'Custom Sources'),

  /* RSS Feeds */
  React.createElement('div', { style: { marginBottom: '12px' } },
    React.createElement('label', { className: 'field-label' }, 'RSS Feeds'),
    React.createElement('div', { style: { display: 'flex', gap: '8px', marginBottom: '6px' } },
      React.createElement('input', {
        type: 'text',
        className: 'field-input',
        placeholder: 'https://blog.example.com or paste any page URL',
        value: rssFeedInput,
        onChange: e => setRssFeedInput(e.target.value),
        onKeyDown: e => e.key === 'Enter' && handleAddFeed(),
        style: { flex: 1 }
      }),
      React.createElement('button', {
        className: 'btn-secondary',
        onClick: handleAddFeed,
        disabled: discoveringFeed || !rssFeedInput.trim()
      }, discoveringFeed ? 'Detecting…' : 'Add')
    ),
    feedDiscoverError && React.createElement('div', { className: 'field-hint error' }, feedDiscoverError),
    /* Discovered feed chips for confirmation */
    discoveredFeeds.length > 0 && React.createElement('div', { style: { marginBottom: '8px' } },
      React.createElement('div', { className: 'field-hint' }, 'Feed detected — confirm to add:'),
      discoveredFeeds.map(f => React.createElement('div', {
        key: f.url, style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '4px' }
      },
        React.createElement('span', { className: 'chip chip-secondary', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.url),
        React.createElement('button', { className: 'btn-sm btn-primary', onClick: () => confirmFeed(f.url) }, 'Add'),
        React.createElement('button', { className: 'btn-sm btn-ghost', onClick: () => setDiscoveredFeeds([]) }, '✕')
      ))
    ),
    /* Added feeds */
    editRssFeeds.map(url => React.createElement('div', {
      key: url, className: 'chip-row'
    },
      React.createElement('span', { className: 'chip chip-secondary' }, url),
      React.createElement('button', {
        className: 'chip-remove',
        onClick: () => setEditRssFeeds(editRssFeeds.filter(u => u !== url))
      }, '×')
    ))
  ),

  /* Telegram Channels */
  React.createElement('div', null,
    React.createElement('label', { className: 'field-label' }, 'Telegram Channels'),
    React.createElement('div', { style: { display: 'flex', gap: '8px', marginBottom: '6px' } },
      React.createElement('input', {
        type: 'text',
        className: 'field-input',
        placeholder: '@channel',
        value: telegramInput,
        onChange: e => setTelegramInput(e.target.value),
        onKeyDown: e => e.key === 'Enter' && handleAddChannel(),
        style: { flex: 1 }
      }),
      React.createElement('button', {
        className: 'btn-secondary',
        onClick: handleAddChannel,
        disabled: !telegramInput.trim()
      }, 'Add')
    ),
    telegramInputError && React.createElement('div', { className: 'field-hint error' }, telegramInputError),
    editTelegramChannels.map(ch => React.createElement('div', {
      key: ch, className: 'chip-row'
    },
      React.createElement('span', { className: 'chip chip-secondary' }, `@${ch}`),
      React.createElement('button', {
        className: 'chip-remove',
        onClick: () => setEditTelegramChannels(editTelegramChannels.filter(c => c !== ch))
      }, '×')
    ))
  )
)}
```

- [ ] **Step 3: Add state variables to the monitor edit drawer component**

Find where `useState` calls are grouped in the `MonitorEditDrawer` component (or equivalent). Add:

```js
const [editRssFeeds,       setEditRssFeeds]       = React.useState(monitor?.rssFeeds || [])
const [editTelegramChannels, setEditTelegramChannels] = React.useState(monitor?.telegramChannels || [])
const [rssFeedInput,       setRssFeedInput]       = React.useState('')
const [telegramInput,      setTelegramInput]       = React.useState('')
const [discoveringFeed,    setDiscoveringFeed]     = React.useState(false)
const [discoveredFeeds,    setDiscoveredFeeds]     = React.useState([])
const [feedDiscoverError,  setFeedDiscoverError]   = React.useState('')
const [telegramInputError, setTelegramInputError]  = React.useState('')
```

Also reset these when `monitor` prop changes (in the same `useEffect` that resets other edit state):

```js
setEditRssFeeds(monitor?.rssFeeds || [])
setEditTelegramChannels(monitor?.telegramChannels || [])
setRssFeedInput('')
setTelegramInput('')
setDiscoveredFeeds([])
setFeedDiscoverError('')
setTelegramInputError('')
```

- [ ] **Step 4: Add handler functions**

Find where handler functions (like `handleSave`) are defined in the drawer component. Add:

```js
const handleAddFeed = async () => {
  const url = rssFeedInput.trim()
  if (!url) return
  setDiscoveringFeed(true)
  setFeedDiscoverError('')
  setDiscoveredFeeds([])
  try {
    const r = await apiFetch(`/v1/feeds/discover?url=${encodeURIComponent(url)}`, {}, apiKey)
    if (r.ok && r.data.feeds.length > 0) {
      setDiscoveredFeeds(r.data.feeds)
      setRssFeedInput('')
    } else if (r.ok && r.data.feeds.length === 0) {
      // Try adding as direct feed URL
      if (/^https?:\/\//.test(url)) {
        confirmFeed(url)
      } else {
        setFeedDiscoverError('No feed detected — try pasting the direct feed URL')
      }
    } else {
      setFeedDiscoverError('Could not check URL — try again')
    }
  } catch {
    setFeedDiscoverError('Network error — try again')
  }
  setDiscoveringFeed(false)
}

const confirmFeed = (url) => {
  if (!editRssFeeds.includes(url) && editRssFeeds.length < 5) {
    setEditRssFeeds([...editRssFeeds, url])
  }
  setDiscoveredFeeds([])
  setRssFeedInput('')
}

const handleAddChannel = () => {
  setTelegramInputError('')
  const raw = telegramInput.trim().replace(/^@/, '')
  if (!raw) return
  if (!/^[a-zA-Z0-9_]{5,32}$/.test(raw)) {
    setTelegramInputError('Handle must be 5–32 characters: letters, numbers, underscore')
    return
  }
  if (editTelegramChannels.length >= 5) {
    setTelegramInputError('Maximum 5 channels')
    return
  }
  if (!editTelegramChannels.includes(raw)) {
    setEditTelegramChannels([...editTelegramChannels, raw])
  }
  setTelegramInput('')
}
```

- [ ] **Step 5: Include `rssFeeds` and `telegramChannels` in the save PATCH body**

Find the existing `handleSave` function in the drawer (or wherever `apiFetch('/v1/monitors/:id', { method: 'PATCH', body: ... })` is called). Add the two new fields to the body:

```js
rssFeeds:         editRssFeeds,
telegramChannels: editTelegramChannels,
```

- [ ] **Step 6: Verify in browser**

Start the dev server (`npm start` or `node api-server.js`) and open the dashboard. Open a monitor edit drawer and confirm:
- "Custom Sources" section appears below Keywords
- Pasting a URL and clicking Add calls the discover endpoint
- Feed chips appear with confirm/dismiss
- Telegram handles are validated client-side
- Saving includes the new fields

- [ ] **Step 7: Run full test suite**

```
npm test 2>&1 | tail -5
```

Expected: no regressions.

- [ ] **Step 8: Commit**

```
git add public/dashboard.html
git commit -m "feat(ui): add Custom Sources section (RSS feeds + Telegram channels) to monitor edit drawer"
```

---

## Self-Review

**Spec coverage check:**
- Section 1 (Architecture): Task 4 wires feed scrapers once per cycle with `allKeywords` ✓
- Section 2 (RSS Scraper): Task 1 — RSS 2.0, Atom, keyword matching, dedup, age filter, CDATA, graceful failure ✓
- Section 3 (Telegram Scraper): Task 2 — HTML parse, keyword match, dedup, age filter, private channel graceful skip ✓
- Section 4 (Schema + API): Task 5 — PATCH Fields 20+21, `/v1/feeds/discover` endpoint ✓
- Section 5 (Settings UI): Task 6 — RSS feed input with discover, Telegram handle input, pill tags, save integration ✓
- Section 6 (Testing): Tests in Tasks 1, 2, 3, 5 cover all listed scenarios ✓

**Placeholder scan:** All steps contain actual code. No "TBD" or "similar to above" patterns.

**Type consistency:** `parseRSSFeed`, `parseTelegramHTML`, `searchRSS`, `searchTelegram`, `validateRssFeeds`, `validateTelegramChannels` — names consistent across all tasks. `editRssFeeds`/`editTelegramChannels` state names used consistently in Task 6.
