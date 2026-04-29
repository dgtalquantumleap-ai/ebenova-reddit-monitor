import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { injectUtm } from '../lib/draft-call.js'

const PROD_URL = 'https://acme.com'

test('injectUtm: returns input unchanged when productUrl is missing', () => {
  const draft = 'Check it out at https://acme.com'
  assert.equal(injectUtm({ draft, productUrl: null }), draft)
  assert.equal(injectUtm({ draft, productUrl: '' }),   draft)
  assert.equal(injectUtm({ draft, productUrl: undefined }), draft)
})

test('injectUtm: returns input unchanged when draft is empty', () => {
  assert.equal(injectUtm({ draft: '', productUrl: PROD_URL }), '')
  assert.equal(injectUtm({ draft: null, productUrl: PROD_URL }), null)
})

test('injectUtm: returns input unchanged when productUrl is unparseable', () => {
  const draft = 'See https://acme.com'
  assert.equal(injectUtm({ draft, productUrl: 'not a url' }), draft)
})

test('injectUtm: appends default UTM params to a matching URL', () => {
  const result = injectUtm({
    draft: 'Take a look at https://acme.com today.',
    productUrl: PROD_URL,
    utmCampaign: 'launch-week',
  })
  assert.match(result, /https:\/\/acme\.com\/\?utm_source=ebenova-insights&utm_medium=community&utm_campaign=launch-week/)
  assert.match(result, /today\.$/)  // trailing punctuation preserved
})

test('injectUtm: respects custom utmSource / utmMedium', () => {
  const result = injectUtm({
    draft: 'See https://acme.com',
    productUrl: PROD_URL,
    utmSource: 'reddit',
    utmMedium: 'reply',
    utmCampaign: 'q2',
  })
  const url = new URL(result.match(/https:\/\/[^\s]+/)[0])
  assert.equal(url.searchParams.get('utm_source'),   'reddit')
  assert.equal(url.searchParams.get('utm_medium'),   'reply')
  assert.equal(url.searchParams.get('utm_campaign'), 'q2')
})

test('injectUtm: leaves third-party URLs untouched', () => {
  const draft = 'Check https://acme.com vs https://reddit.com/r/SaaS for context.'
  const result = injectUtm({ draft, productUrl: PROD_URL, utmCampaign: 'c1' })
  // acme.com gets UTMs, reddit.com does not
  const acmeMatch = result.match(/https:\/\/acme\.com[^\s]*/)
  const redditMatch = result.match(/https:\/\/reddit\.com[^\s]*/)
  assert.match(acmeMatch[0], /utm_source=/)
  assert.equal(/utm_/.test(redditMatch[0]), false)
})

test('injectUtm: preserves existing UTM params (does not overwrite)', () => {
  const draft = 'See https://acme.com/?utm_source=manual&utm_medium=other'
  const result = injectUtm({
    draft, productUrl: PROD_URL,
    utmSource: 'should-not-apply', utmMedium: 'also-not', utmCampaign: 'fresh',
  })
  const url = new URL(result.match(/https:\/\/[^\s]+/)[0])
  assert.equal(url.searchParams.get('utm_source'),   'manual')      // preserved
  assert.equal(url.searchParams.get('utm_medium'),   'other')        // preserved
  assert.equal(url.searchParams.get('utm_campaign'), 'fresh')        // added (not present before)
})

test('injectUtm: appends to URLs that already have non-UTM query params', () => {
  const draft = 'Try https://acme.com/pricing?ref=xyz'
  const result = injectUtm({
    draft, productUrl: PROD_URL,
    utmCampaign: 'launch',
  })
  const url = new URL(result.match(/https:\/\/[^\s]+/)[0])
  assert.equal(url.searchParams.get('ref'), 'xyz')                  // preserved
  assert.equal(url.searchParams.get('utm_source'), 'ebenova-insights')
  assert.equal(url.searchParams.get('utm_campaign'), 'launch')
})

test('injectUtm: matches subdomain URLs against productUrl origin (only same-origin)', () => {
  // www.acme.com is a different origin from acme.com — should NOT be tagged.
  const draft = 'See https://www.acme.com/blog'
  const result = injectUtm({ draft, productUrl: PROD_URL, utmCampaign: 'c1' })
  assert.equal(/utm_source=/.test(result), false)
})

test('injectUtm: handles multiple matching URLs in one draft', () => {
  const draft = 'Start at https://acme.com and pricing at https://acme.com/pricing.'
  const result = injectUtm({
    draft, productUrl: PROD_URL,
    utmCampaign: 'multi',
  })
  const matches = result.match(/https:\/\/acme\.com[^\s.,;]*[^\s.,;]/g) || []
  assert.equal(matches.length >= 2, true)
  for (const m of matches) {
    assert.match(m, /utm_source=ebenova-insights/)
  }
})

test('injectUtm: keeps trailing punctuation outside the URL', () => {
  const result = injectUtm({
    draft: 'Try https://acme.com.',
    productUrl: PROD_URL, utmCampaign: 'c',
  })
  // The period should still be at the end, not inside the URL
  assert.match(result, /utm_campaign=c\.$/)
})

test('injectUtm: does not produce double question marks on bare apex URL', () => {
  const result = injectUtm({
    draft: 'See https://acme.com',
    productUrl: PROD_URL, utmCampaign: 'c',
  })
  // Should not contain '??'
  assert.equal(result.includes('??'), false)
})
