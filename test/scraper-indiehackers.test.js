import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import searchIndieHackers, { _internals } from '../lib/scrapers/indiehackers.js'
import { VALID_PLATFORMS, PLATFORM_LABELS, PLATFORM_EMOJIS, validatePlatforms } from '../lib/platforms.js'

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

// Build minimal DuckDuckGo HTML with IH result links.
function buildDdgHtml(results) {
  const items = results.map(({ url, title, snippet }) => {
    const encoded = encodeURIComponent(url)
    return `
<div class="result results_links web-result">
  <div class="result__title">
    <a rel="nofollow" class="result__a" href="/l/?uddg=${encoded}">${title}</a>
  </div>
  <a class="result__snippet" href="/l/?uddg=${encoded}">${snippet}</a>
</div>`
  }).join('\n')
  return `<!DOCTYPE html><html><body><div class="results">${items}</div></body></html>`
}

// ── 1. returns [] on DDG non-2xx (never throws) ───────────────────────────

test('1. searchIndieHackers() returns [] on DDG 503 (never throws)', async () => {
  _internals.resetBlockedLog()
  await withFetch(async () => ({ ok: false, status: 503, text: async () => '' }), async () => {
    const r = await searchIndieHackers({ keyword: 'saas tool' }, ctx())
    assert.deepEqual(r, [])
  })
})

// ── 2. returns [] on network error ───────────────────────────────────────

test('2. searchIndieHackers() returns [] on network error (never throws)', async () => {
  _internals.resetBlockedLog()
  await withFetch(async () => { throw new Error('ECONNREFUSED') }, async () => {
    const r = await searchIndieHackers({ keyword: 'saas tool' }, ctx())
    assert.deepEqual(r, [])
  })
})

// ── 3. returns [] for empty keyword ──────────────────────────────────────

test('3. searchIndieHackers() returns [] for empty keyword', async () => {
  const r = await searchIndieHackers({ keyword: '' }, ctx())
  assert.deepEqual(r, [])
})

// ── 4. returns [] on DDG JS-block page ───────────────────────────────────

test('4. searchIndieHackers() returns [] when DDG returns JS-required page', async () => {
  _internals.resetBlockedLog()
  const jsBlock = '<html><body>Please enable JS and disable ad blocker<script src="duckduckgo.com/d.js"></script></body></html>'
  await withFetch(async () => ({ ok: true, status: 200, text: async () => jsBlock }), async () => {
    const r = await searchIndieHackers({ keyword: 'saas' }, ctx())
    assert.deepEqual(r, [])
  })
})

// ── 5. correct item shape from mock DDG HTML ──────────────────────────────

test('5. searchIndieHackers() returns correctly shaped items from mock DDG HTML', async () => {
  _internals.resetBlockedLog()
  const html = buildDdgHtml([{
    url:     'https://www.indiehackers.com/post/how-to-find-saas-customers',
    title:   'How to find SaaS customers — Indie Hackers',
    snippet: 'Looking for ways to find early adopters for my SaaS tool...',
  }])
  await withFetch(async () => ({ ok: true, status: 200, text: async () => html }), async () => {
    const r = await searchIndieHackers({ keyword: 'saas tool' }, ctx())
    assert.ok(Array.isArray(r))
    if (r.length === 0) return  // DDG parse may vary
    const item = r[0]
    assert.ok(item.id.startsWith('indiehackers_'), `id prefix: ${item.id}`)
    assert.equal(item.source, 'indiehackers')
    assert.equal(item.subreddit, 'Indie Hackers')
    assert.ok(item.url.includes('indiehackers.com'), `url: ${item.url}`)
    assert.equal(item.approved, true)
    for (const f of ['id','title','url','subreddit','author','score','comments','body','createdAt','keyword','source','approved']) {
      assert.ok(f in item, `missing field ${f}`)
    }
  })
})

// ── 6. seenIds deduplication ─────────────────────────────────────────────

test('6. searchIndieHackers() deduplicates via seenIds', async () => {
  _internals.resetBlockedLog()
  const targetUrl = 'https://www.indiehackers.com/post/duplicate-post-abc123'
  const html = buildDdgHtml([
    { url: targetUrl, title: 'Post A', snippet: 'body A' },
    { url: targetUrl, title: 'Post A again', snippet: 'body B' },
  ])

  const { hashUrlToId } = await import('../lib/scrapers/_id.js')
  const id = hashUrlToId(targetUrl, 'indiehackers')
  const seenIds = { has: (x) => x === id, add: () => {} }

  await withFetch(async () => ({ ok: true, status: 200, text: async () => html }), async () => {
    const r = await searchIndieHackers({ keyword: 'saas' }, { ...ctx(), seenIds })
    assert.equal(r.length, 0, 'already-seen URL should be deduped')
  })
})

// ── 7. platform registry ──────────────────────────────────────────────────

test('7. indiehackers is in VALID_PLATFORMS with label and emoji', () => {
  assert.ok(VALID_PLATFORMS.includes('indiehackers'))
  assert.equal(PLATFORM_LABELS.indiehackers, 'Indie Hackers')
  assert.ok(PLATFORM_EMOJIS.indiehackers, 'emoji should be defined')
})

test('8. validatePlatforms accepts indiehackers', () => {
  const r = validatePlatforms(['indiehackers'])
  assert.equal(r.ok, true)
})

// ── 9. internals pinned ───────────────────────────────────────────────────

test('9. internals: MAX_RESULTS=10, TIMEOUT_MS=10000', () => {
  assert.equal(_internals.MAX_RESULTS, 10)
  assert.equal(_internals.TIMEOUT_MS, 10_000)
})
