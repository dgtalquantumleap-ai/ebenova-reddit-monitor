// Amazon reviews scraper.
//
// Pins the contract every other scraper in lib/scrapers/ pins:
//   - never throws on a fetch error or a malformed/blocked page (returns [])
//   - source field is 'amazon' on every result
//   - score field carries the 1-5 star rating
//   - reviews older than MAX_AGE_MS are filtered out
//   - platform registry has 'amazon' wired in (Settings list badges, etc)

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import searchAmazonReviews, { _internals } from '../lib/scrapers/amazon.js'
import { VALID_PLATFORMS, PLATFORM_LABELS, PLATFORM_EMOJIS } from '../lib/platforms.js'

function withFetch(impl, fn) {
  const original = global.fetch
  global.fetch = impl
  return Promise.resolve()
    .then(fn)
    .finally(() => { global.fetch = original })
}

const ctx = () => ({
  seenIds: { has: () => false, add: () => {} },
  delay:   async () => {},
  MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,    // 30 days for reviews
})

// Build a minimal review-card HTML snippet for the parser. Inline-replicates
// the tags Amazon uses around each <div data-hook="review">.
function buildReviewCard({ id, rating, name, title, body, dateText }) {
  return `
<div data-hook="review" id="customer_review-${id}">
  <span class="a-profile-name">${name}</span>
  <a data-hook="review-title" href="#"><span>${title}</span></a>
  <span class="a-icon-alt">${rating}.0 out of 5 stars</span>
  <span data-hook="review-date">Reviewed in the United States on ${dateText}</span>
  <span data-hook="review-body"><span>${body}</span></span>
</div>
`
}

function buildSearchHtml(asins) {
  return asins.map(a => `<div data-asin="${a}">product</div>`).join('\n')
}

function buildReviewsHtml(productTitle, reviewCards) {
  return `<html><head><title>Amazon.com Customer reviews: ${productTitle}</title></head>
  <body>${reviewCards.join('\n')}<div id="cm_cr-pagination"></div></body></html>`
}

// ── 1. fetch error → [] (never throws) ────────────────────────────────────

test('1. searchAmazonReviews() returns [] on fetch error (never throws)', async () => {
  await withFetch(async () => { throw new Error('ECONNREFUSED') }, async () => {
    const r = await searchAmazonReviews({ keyword: 'test product' }, ctx())
    assert.deepEqual(r, [])
  })
})

test('1b. searchAmazonReviews() returns [] when search page returns 503', async () => {
  await withFetch(async () => ({ ok: false, status: 503, text: async () => '' }), async () => {
    const r = await searchAmazonReviews({ keyword: 'test product' }, ctx())
    assert.deepEqual(r, [])
  })
})

test('1c. searchAmazonReviews() returns [] when Amazon serves an anti-bot interstitial', async () => {
  _internals.resetBlockedWarning()
  const captchaHtml = '<html><body>Sorry, we just need to make sure you\'re not a robot. Type the characters below.</body></html>'
  await withFetch(async () => ({ ok: true, status: 200, text: async () => captchaHtml }), async () => {
    const r = await searchAmazonReviews({ keyword: 'test product' }, ctx())
    assert.deepEqual(r, [])
  })
})

// ── 2. no reviews found → [] ──────────────────────────────────────────────

test('2. searchAmazonReviews() returns [] when no products are found in search', async () => {
  await withFetch(async () => ({ ok: true, status: 200, text: async () => '<html><body>No results</body></html>' }), async () => {
    const r = await searchAmazonReviews({ keyword: 'no-such-keyword' }, ctx())
    assert.deepEqual(r, [])
  })
})

test('2b. searchAmazonReviews() returns [] when product page has no review cards', async () => {
  let callCount = 0
  await withFetch(async (url) => {
    callCount++
    if (callCount === 1) return { ok: true, status: 200, text: async () => buildSearchHtml(['B0AAAAAAAA']) }
    return { ok: true, status: 200, text: async () => '<html><body>No reviews yet</body></html>' }
  }, async () => {
    const r = await searchAmazonReviews({ keyword: 'whatever' }, ctx())
    assert.deepEqual(r, [])
  })
})

// ── 3. source field is 'amazon' on all matches ────────────────────────────

test('3. source field is "amazon" on every returned match', async () => {
  let callCount = 0
  const recentDate = (() => {
    const d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    return d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  })()
  const reviewCard = buildReviewCard({
    id: 'R1ABC', rating: 4, name: 'Alex', title: 'Great product',
    body: 'Works as advertised, would buy again.', dateText: recentDate,
  })
  await withFetch(async (url) => {
    callCount++
    if (String(url).includes('/s?')) return { ok: true, status: 200, text: async () => buildSearchHtml(['B0XYZ12345']) }
    return { ok: true, status: 200, text: async () => buildReviewsHtml('Some Product', [reviewCard]) }
  }, async () => {
    const r = await searchAmazonReviews({ keyword: 'gadget' }, ctx())
    assert.ok(r.length >= 1, 'expected at least one match')
    for (const m of r) {
      assert.equal(m.source, 'amazon')
      assert.equal(m.approved, true)
      assert.match(m.subreddit, /^amazon:/)
    }
  })
})

// ── 4. score field carries star rating (1-5) ──────────────────────────────

test('4. score field is the integer star rating (1-5)', async () => {
  const recentDate = (() => {
    const d = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)
    return d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  })()
  // Build cards with three different ratings.
  const cards = [
    buildReviewCard({ id: 'R1', rating: 5, name: 'Alex', title: 'Five-star',  body: 'Excellent.',  dateText: recentDate }),
    buildReviewCard({ id: 'R2', rating: 3, name: 'Bo',   title: 'Mid',        body: 'OK.',         dateText: recentDate }),
    buildReviewCard({ id: 'R3', rating: 1, name: 'Cat',  title: 'Disappointed', body: 'Bad.',      dateText: recentDate }),
  ]
  await withFetch(async (url) => {
    if (String(url).includes('/s?')) return { ok: true, status: 200, text: async () => buildSearchHtml(['B0AAAAAAAA']) }
    return { ok: true, status: 200, text: async () => buildReviewsHtml('Test Product', cards) }
  }, async () => {
    const r = await searchAmazonReviews({ keyword: 'gadget' }, ctx())
    const scores = r.map(m => m.score).sort((a, b) => b - a)
    assert.deepEqual(scores, [5, 3, 1])
    for (const m of r) {
      assert.ok(m.score >= 1 && m.score <= 5, `score ${m.score} should be 1-5`)
    }
  })
})

// ── 5. MAX_AGE_MS filter respected ────────────────────────────────────────

test('5. searchAmazonReviews() filters reviews older than MAX_AGE_MS', async () => {
  const recentDate = (() => {
    const d = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)
    return d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  })()
  const oldDate = (() => {
    // Way past 30-day MAX_AGE_MS.
    const d = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    return d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  })()
  const cards = [
    buildReviewCard({ id: 'R1', rating: 5, name: 'Alex', title: 'Recent', body: 'OK',  dateText: recentDate }),
    buildReviewCard({ id: 'R2', rating: 5, name: 'Bob',  title: 'Stale',  body: 'Old', dateText: oldDate }),
  ]
  await withFetch(async (url) => {
    if (String(url).includes('/s?')) return { ok: true, status: 200, text: async () => buildSearchHtml(['B0AAAAAAAA']) }
    return { ok: true, status: 200, text: async () => buildReviewsHtml('Test Product', cards) }
  }, async () => {
    const r = await searchAmazonReviews({ keyword: 'gadget' }, ctx())
    assert.equal(r.length, 1, 'only the recent review should make it through')
    assert.match(r[0].title, /Recent/)
  })
})

// ── 6. platform-registry wiring ───────────────────────────────────────────

test('6. amazon is registered in VALID_PLATFORMS with label + emoji', () => {
  assert.ok(VALID_PLATFORMS.includes('amazon'))
  assert.equal(PLATFORM_LABELS.amazon, 'Amazon Reviews')
  assert.equal(PLATFORM_EMOJIS.amazon, '📦')
  // indiehackers + g2 + rss + telegram added; total now 18.
  assert.equal(VALID_PLATFORMS.length, 18)
})

// ── parseAmazonDate helper ────────────────────────────────────────────────

test('parseAmazonDate handles the full Amazon date phrasing', () => {
  const d = _internals.parseAmazonDate('Reviewed in the United States on March 12, 2026')
  assert.ok(d, 'should parse a valid date')
  assert.equal(d.getUTCFullYear(), 2026)
  assert.equal(d.getUTCMonth(), 2)   // March = 2 (0-indexed)
})

test('parseAmazonDate returns null on garbage input', () => {
  assert.equal(_internals.parseAmazonDate(''), null)
  assert.equal(_internals.parseAmazonDate('not a date'), null)
  assert.equal(_internals.parseAmazonDate(null), null)
})

// ── Internals pinned ──────────────────────────────────────────────────────

test('internals match spec — UA, BASE, REQUEST_DELAY_MS, limits', () => {
  assert.equal(_internals.BASE, 'https://www.amazon.com')
  assert.equal(_internals.UA,   'Mozilla/5.0 (compatible; research-bot/1.0)')
  assert.equal(_internals.REQUEST_DELAY_MS, 3000)
  assert.equal(_internals.MAX_PRODUCTS, 3)
})
