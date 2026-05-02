import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { parseRedditRSS, buildRedditSearchUrl, parseRetryAfter, quoteIfMultiWord } from '../lib/reddit-rss.js'

// ── buildRedditSearchUrl ──────────────────────────────────────────────────────

test('buildRedditSearchUrl: global search uses /search.rss', () => {
  const url = buildRedditSearchUrl('freelance contract', null)
  assert.ok(url.startsWith('https://www.reddit.com/search.rss?'))
  assert.ok(url.includes('q=%22freelance%20contract%22'))
  assert.ok(url.includes('sort=new'))
  assert.ok(url.includes('t=week'))
  assert.ok(!url.includes('restrict_sr=1'))
})

test('buildRedditSearchUrl: subreddit search uses /r/{sub}/search.rss with restrict_sr=1', () => {
  const url = buildRedditSearchUrl('crm', 'SaaS')
  assert.ok(url.startsWith('https://www.reddit.com/r/SaaS/search.rss?'))
  assert.ok(url.includes('q=crm'))
  assert.ok(url.includes('restrict_sr=1'))
})

test('buildRedditSearchUrl: encodes special chars in keyword and subreddit', () => {
  const url = buildRedditSearchUrl('a/b c?d', 'r/with spaces')
  assert.ok(url.includes('q=%22a%2Fb%20c%3Fd%22'))
  assert.ok(url.includes('/r/r%2Fwith%20spaces/search.rss'))
})

test('buildRedditSearchUrl: respects custom sort and time-window', () => {
  const url = buildRedditSearchUrl('crm', 'SaaS', { sort: 'top', t: 'day' })
  assert.ok(url.includes('sort=top'))
  assert.ok(url.includes('t=day'))
})

// ── quoteIfMultiWord ──────────────────────────────────────────────────────────

test('quoteIfMultiWord: single word is not wrapped', () => {
  assert.equal(quoteIfMultiWord('freelance'), 'freelance')
})

test('quoteIfMultiWord: multi-word keyword is wrapped in double quotes', () => {
  assert.equal(quoteIfMultiWord('client added more work'), '"client added more work"')
})

test('quoteIfMultiWord: already-quoted keyword is not double-wrapped', () => {
  assert.equal(quoteIfMultiWord('"client added more work"'), '"client added more work"')
})

test('quoteIfMultiWord: empty string returns empty string', () => {
  assert.equal(quoteIfMultiWord(''), '')
})

test('quoteIfMultiWord: whitespace-only returns trimmed empty string', () => {
  assert.equal(quoteIfMultiWord('   '), '')
})

test('buildRedditSearchUrl: multi-word keyword is phrase-wrapped in URL', () => {
  const url = buildRedditSearchUrl('client added more work', {})
  assert.ok(
    url.includes(encodeURIComponent('"client added more work"')),
    'Expected URL to contain URL-encoded quoted phrase'
  )
})

test('buildRedditSearchUrl: single word keyword is not quoted in URL', () => {
  const url = buildRedditSearchUrl('freelance', {})
  assert.ok(!url.includes('%22freelance%22'), 'Single word should not be wrapped in quotes')
})

test('buildRedditSearchUrl: type=phrase forces quoting even for single-word keywords', () => {
  const url = buildRedditSearchUrl('freelance', null, { type: 'phrase' })
  assert.ok(url.includes(encodeURIComponent('"freelance"')), 'phrase type should force quotes on single word')
})

test('buildRedditSearchUrl: type=phrase quotes multi-word keywords', () => {
  const url = buildRedditSearchUrl('scope creep', null, { type: 'phrase' })
  assert.ok(url.includes(encodeURIComponent('"scope creep"')))
})

// ── parseRedditRSS ────────────────────────────────────────────────────────────

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>reddit search results</title>
  <updated>2026-04-28T12:34:56+00:00</updated>
  <entry>
    <author>
      <name>/u/founder42</name>
      <uri>https://www.reddit.com/user/founder42</uri>
    </author>
    <category term="SaaS" label="r/SaaS"/>
    <content type="html">&lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;Looking for a CRM with strong API. Currently using HubSpot but their pricing is brutal at scale.&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt;</content>
    <id>t3_abc123</id>
    <link href="https://www.reddit.com/r/SaaS/comments/abc123/best_crm_for_api_first/"/>
    <updated>2026-04-28T11:00:00+00:00</updated>
    <published>2026-04-28T10:55:00+00:00</published>
    <title>Best CRM for API-first companies?</title>
  </entry>
  <entry>
    <author>
      <name>/u/scoper</name>
    </author>
    <category term="freelance" label="r/freelance"/>
    <content type="html">&lt;p&gt;Client keeps adding scope without paying more. What do you say?&lt;/p&gt;</content>
    <id>t3_xyz789</id>
    <link href="https://www.reddit.com/r/freelance/comments/xyz789/scope_creep_help/"/>
    <published>2026-04-28T09:00:00+00:00</published>
    <title>Scope creep — what do I say?</title>
  </entry>
</feed>`

test('parseRedditRSS: returns one record per <entry>', () => {
  const out = parseRedditRSS(SAMPLE_FEED)
  assert.equal(out.length, 2)
})

test('parseRedditRSS: extracts id without t3_ prefix', () => {
  const out = parseRedditRSS(SAMPLE_FEED)
  assert.equal(out[0].id, 'abc123')
  assert.equal(out[1].id, 'xyz789')
})

test('parseRedditRSS: extracts title', () => {
  const out = parseRedditRSS(SAMPLE_FEED)
  assert.equal(out[0].title, 'Best CRM for API-first companies?')
})

test('parseRedditRSS: extracts URL from link href attribute', () => {
  const out = parseRedditRSS(SAMPLE_FEED)
  assert.ok(out[0].url.includes('/r/SaaS/comments/abc123/'))
})

test('parseRedditRSS: strips /u/ prefix from author', () => {
  const out = parseRedditRSS(SAMPLE_FEED)
  assert.equal(out[0].author, 'founder42')
  assert.equal(out[1].author, 'scoper')
})

test('parseRedditRSS: extracts subreddit from category term', () => {
  const out = parseRedditRSS(SAMPLE_FEED)
  assert.equal(out[0].subreddit, 'SaaS')
  assert.equal(out[1].subreddit, 'freelance')
})

test('parseRedditRSS: prefers <published> over <updated> for createdAt', () => {
  const out = parseRedditRSS(SAMPLE_FEED)
  assert.equal(out[0].createdAt, '2026-04-28T10:55:00+00:00')  // <published>, not <updated>
})

test('parseRedditRSS: falls back to <updated> when <published> missing', () => {
  const xml = `<feed><entry>
    <id>t3_only_updated</id>
    <title>Title</title>
    <link href="https://reddit.com/r/x/comments/only_updated/"/>
    <updated>2026-01-01T00:00:00Z</updated>
    <author><name>/u/x</name></author>
    <category term="x" label="r/x"/>
  </entry></feed>`
  const out = parseRedditRSS(xml)
  assert.equal(out.length, 1)
  assert.equal(out[0].createdAt, '2026-01-01T00:00:00Z')
})

test('parseRedditRSS: HTML-decodes and strips tags from body', () => {
  const out = parseRedditRSS(SAMPLE_FEED)
  // Original <content> contained encoded <p> tags, "&lt;p&gt;Looking for...&lt;/p&gt;"
  // After decode + strip, we should see plain text
  assert.ok(out[0].body.includes('Looking for a CRM'))
  assert.ok(out[0].body.includes('HubSpot'))
  assert.ok(!out[0].body.includes('<p>'))
  assert.ok(!out[0].body.includes('&lt;'))
})

test('parseRedditRSS: caps body at 600 chars', () => {
  const big = 'x'.repeat(2000)
  const xml = `<feed><entry>
    <id>t3_big</id>
    <title>Big body</title>
    <link href="https://reddit.com/r/x/comments/big/"/>
    <published>2026-01-01T00:00:00Z</published>
    <author><name>/u/x</name></author>
    <category term="x" label="r/x"/>
    <content type="html">${big}</content>
  </entry></feed>`
  const out = parseRedditRSS(xml)
  assert.ok(out[0].body.length <= 600)
})

test('parseRedditRSS: returns [] for empty input', () => {
  assert.deepEqual(parseRedditRSS(''), [])
  assert.deepEqual(parseRedditRSS(null), [])
  assert.deepEqual(parseRedditRSS(undefined), [])
})

test('parseRedditRSS: returns [] for malformed XML (no entries)', () => {
  assert.deepEqual(parseRedditRSS('<feed><title>nothing here</title></feed>'), [])
})

test('parseRedditRSS: skips entries missing title or link', () => {
  const xml = `<feed>
    <entry>
      <id>t3_ok</id>
      <title>Has everything</title>
      <link href="https://reddit.com/r/x/comments/ok/"/>
      <published>2026-01-01T00:00:00Z</published>
      <author><name>/u/x</name></author>
      <category term="x" label="r/x"/>
    </entry>
    <entry>
      <id>t3_no_link</id>
      <title>No link</title>
      <published>2026-01-01T00:00:00Z</published>
      <author><name>/u/x</name></author>
      <category term="x" label="r/x"/>
    </entry>
  </feed>`
  const out = parseRedditRSS(xml)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'ok')
})

// ── parseRetryAfter ───────────────────────────────────────────────────────────

test('parseRetryAfter: reads numeric value from Headers-like get()', () => {
  const headers = { get: (k) => k.toLowerCase() === 'retry-after' ? '12' : null }
  assert.equal(parseRetryAfter(headers), 12)
})

test('parseRetryAfter: reads from plain object (case-insensitive)', () => {
  assert.equal(parseRetryAfter({ 'retry-after': '5' }), 5)
  assert.equal(parseRetryAfter({ 'Retry-After': '7' }), 7)
})

test('parseRetryAfter: returns null when header missing or invalid', () => {
  assert.equal(parseRetryAfter(null), null)
  assert.equal(parseRetryAfter({}), null)
  assert.equal(parseRetryAfter({ 'retry-after': '' }), null)
  assert.equal(parseRetryAfter({ 'retry-after': 'soon' }), null)
})

test('parseRetryAfter: bounds at 0 and 600 seconds', () => {
  assert.equal(parseRetryAfter({ 'retry-after': '0' }), null)
  assert.equal(parseRetryAfter({ 'retry-after': '-5' }), null)
  assert.equal(parseRetryAfter({ 'retry-after': '700' }), null)
  assert.equal(parseRetryAfter({ 'retry-after': '599' }), 599)
})
