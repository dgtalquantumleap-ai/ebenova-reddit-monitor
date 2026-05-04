import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import searchRSS, { parseRSSFeed, CURATED_FEEDS } from '../lib/scrapers/rss.js'

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
  const s = { seen: new Set(), has(id) { return this.seen.has(id) }, add(id) { this.seen.add(id) } }
  const first = parseRSSFeed(xml, ['CRM'], s, null, 'https://example.com/feed')
  assert.equal(first.length, 1)
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
