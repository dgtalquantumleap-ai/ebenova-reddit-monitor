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
