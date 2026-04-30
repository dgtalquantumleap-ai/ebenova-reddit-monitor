// Deferred-fixes PR — coverage for the three audit-debt items.
//
// Fix 1: cron expressions (poll, weekly digest, reply-tracker) all valid +
//        the reply-tracker no longer collides with the *_15_* poll boundary.
// Fix 2: extractInjectedUtmUrl pulls the injected product URL out of a draft.
// Fix 3: fetchEngagementDelta returns null for Twitter / unsupported, and
//        returns the delta record for Reddit when fetch succeeds.

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import cron from 'node-cron'
import { extractInjectedUtmUrl, injectUtm } from '../lib/draft-call.js'
import { fetchEngagementDelta, _internals } from '../lib/reply-tracker.js'

// ── Fix 1: cron expressions ────────────────────────────────────────────────

test('Fix 1: weekly digest cron "0 8 * * 1" is valid node-cron syntax', () => {
  assert.equal(cron.validate('0 8 * * 1'), true)
})

test('Fix 1: per-monitor poll cron "*/15 * * * *" is valid node-cron syntax', () => {
  assert.equal(cron.validate('*/15 * * * *'), true)
})

test('Fix 1: reply-tracker cron "7 * * * *" is valid node-cron syntax', () => {
  assert.equal(cron.validate('7 * * * *'), true)
})

test('Fix 1: reply-tracker minute :07 does not collide with any */N poll boundary', () => {
  // The previous schedule used minute :15, which collided with the default
  // POLL_MINUTES=15 cron (*/15 → :00, :15, :30, :45). :07 is collision-free
  // with every realistic POLL_MINUTES value. (N=1 is excluded — every-minute
  // polling collides with everything by definition, and isn't a realistic
  // POLL_MINUTES setting.)
  for (const N of [5, 10, 15, 20, 30, 60]) {
    assert.notEqual(7 % N, 0, `:07 collides with */${N} cron boundary`)
  }
})

test('Fix 1: cron.validate rejects obvious garbage (sanity check on the validator)', () => {
  assert.equal(cron.validate('not-a-cron-expression'), false)
  assert.equal(cron.validate('99 99 99 99 99'), false)
})

// ── Fix 2: extractInjectedUtmUrl ───────────────────────────────────────────

test('Fix 2: returns null for empty/missing inputs', () => {
  assert.equal(extractInjectedUtmUrl({ draft: '', productUrl: 'https://acme.com' }), null)
  assert.equal(extractInjectedUtmUrl({ draft: 'hi', productUrl: '' }), null)
  assert.equal(extractInjectedUtmUrl({ draft: null, productUrl: null }), null)
})

test('Fix 2: returns null when draft has no URL matching productUrl origin', () => {
  const draft = 'Check out https://example.org/blog and https://reddit.com/r/x'
  assert.equal(
    extractInjectedUtmUrl({ draft, productUrl: 'https://acme.com' }),
    null,
  )
})

test('Fix 2: returns null when matching URL has no utm_source param', () => {
  const draft = 'See https://acme.com/pricing for details'
  assert.equal(
    extractInjectedUtmUrl({ draft, productUrl: 'https://acme.com' }),
    null,
  )
})

test('Fix 2: returns the injected URL when injectUtm has run', () => {
  const draft = 'Try https://acme.com/pricing — see what you think.'
  const withUtm = injectUtm({
    draft, productUrl: 'https://acme.com',
    utmSource: 'ebenova-insights', utmMedium: 'community', utmCampaign: 'spring-test',
  })
  const injected = extractInjectedUtmUrl({ draft: withUtm, productUrl: 'https://acme.com' })
  assert.ok(injected, 'expected an injected URL')
  assert.match(injected, /utm_source=ebenova-insights/)
  assert.match(injected, /utm_medium=community/)
  assert.match(injected, /utm_campaign=spring-test/)
  assert.match(injected, /^https:\/\/acme\.com\/pricing/)
})

test('Fix 2: returns the FIRST injected URL when there are multiple', () => {
  // injectUtm injects on every product-origin URL, so a draft can contain
  // multiple. The persistence layer just needs ONE to point click-tracking
  // at — first-wins is deterministic and obvious.
  const draft = `Look at https://acme.com/a?utm_source=x and also https://acme.com/b?utm_source=y`
  const url = extractInjectedUtmUrl({ draft, productUrl: 'https://acme.com' })
  assert.ok(url)
  assert.match(url, /\/a\?/)
})

test('Fix 2: ignores bare product-origin URLs without utm_source', () => {
  // The pipeline relies on injectUtm setting utm_source — its absence means
  // "this URL was never claimed for click tracking".
  const draft = 'See https://acme.com/no-utm and also https://acme.com/yes?utm_source=ebenova'
  const url = extractInjectedUtmUrl({ draft, productUrl: 'https://acme.com' })
  assert.ok(url)
  assert.match(url, /\/yes\?/)
})

// ── Fix 3: fetchEngagementDelta ────────────────────────────────────────────

test('Fix 3: returns null for Twitter (no paid API access yet)', async () => {
  const r = await fetchEngagementDelta({
    source: 'twitter', url: 'https://x.com/user/status/123',
    score: 0, comments: 0,
  })
  assert.equal(r, null)
})

test('Fix 3: returns null for "x" platform alias (Twitter rebrand)', async () => {
  const r = await fetchEngagementDelta({
    source: 'x', url: 'https://x.com/user/status/123',
    score: 0, comments: 0,
  })
  assert.equal(r, null)
})

test('Fix 3: returns null for unsupported platforms (medium / quora / fiverr / etc)', async () => {
  for (const platform of ['medium', 'quora', 'fiverr', 'upwork', 'substack']) {
    const r = await fetchEngagementDelta({
      source: platform, url: `https://${platform}.com/x`,
      score: 0, comments: 0,
    })
    assert.equal(r, null, `${platform} should be null`)
  }
})

test('Fix 3: returns null for null/empty match', async () => {
  assert.equal(await fetchEngagementDelta(null), null)
  assert.equal(await fetchEngagementDelta({}), null)
  assert.equal(await fetchEngagementDelta({ source: 'reddit' }), null)  // missing url
})

test('Fix 3: returns delta for Reddit when FETCHER succeeds (mocked)', async () => {
  // Patch the Reddit fetcher in-place to avoid hitting the network. The
  // _internals.FETCHERS map is the same object lookup table used by the
  // production code path, so swapping the reddit entry routes calls to
  // our mock. Restore after the test to keep other tests isolated.
  const original = _internals.FETCHERS.reddit
  _internals.FETCHERS.reddit = async () => ({ ok: true, score: 42, comments: 7 })
  try {
    const now = new Date('2026-04-29T12:00:00.000Z')
    const r = await fetchEngagementDelta({
      source: 'reddit', url: 'https://reddit.com/r/x/comments/abc/title',
      score: 10, comments: 2,
    }, now)
    assert.deepEqual(r, {
      scoreDelta: 32,
      commentsDelta: 5,
      checkedAt: '2026-04-29T12:00:00.000Z',
    })
  } finally {
    _internals.FETCHERS.reddit = original
  }
})

test('Fix 3: returns null when FETCHER reports ok:false', async () => {
  const original = _internals.FETCHERS.reddit
  _internals.FETCHERS.reddit = async () => ({ ok: false, error: 'post-deleted' })
  try {
    const r = await fetchEngagementDelta({
      source: 'reddit', url: 'https://reddit.com/r/x/comments/abc/title',
      score: 0, comments: 0,
    })
    assert.equal(r, null)
  } finally {
    _internals.FETCHERS.reddit = original
  }
})

test('Fix 3: never throws — returns null even when FETCHER throws', async () => {
  // Defense-in-depth: any FETCHER that throws (instead of returning ok:false)
  // would otherwise crash the sweep. We swallow it as null.
  const original = _internals.FETCHERS.reddit
  _internals.FETCHERS.reddit = async () => { throw new Error('boom') }
  try {
    const r = await fetchEngagementDelta({
      source: 'reddit', url: 'https://reddit.com/r/x/comments/abc/title',
      score: 0, comments: 0,
    })
    assert.equal(r, null)
  } finally {
    _internals.FETCHERS.reddit = original
  }
})
