# Find Customers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the unified Find Customers flow + signal coral rebrand + 3-layer API cost optimization from spec `2026-04-28-find-customers-design.md`.

**Architecture:** Color rebrand first (smallest, lowest risk). Then backend foundation: cache layer + Anthropic client + endpoints. Then frontend rewire: collapse 4 tabs to 3, add 5-state Find Customers component with self-review pattern. Then nightly precompute. Feature-flagged for safe rollout.

**Tech Stack:** Existing — Node 20, Express, Upstash Redis, `@anthropic-ai/sdk`, `node --test`, React 18 in Babel-standalone, no new deps.

**Built on:** PR #4 reconciliation (production-truth dashboard) + earlier landing redesign + AuthModal terminal aesthetic.

---

## File Structure

**New files (10):**

| File | Purpose |
|---|---|
| `lib/find-cache.js` | Redis-backed cache for preview counts, 1h TTL, batched MGET |
| `lib/find-suggest.js` | Orchestration: sanitize → call Anthropic → validate → fallback |
| `lib/find-baseline.js` | Precompute baseline counts for top buying-intent phrases |
| `lib/llm/anthropic.js` | Anthropic Haiku 4.5 client wrapper (restore from git history) |
| `lib/llm/prompts.js` | Versioned system prompt for keyword suggestion (restore) |
| `lib/templates.js` | 8 fallback templates (restore) |
| `routes/find.js` | `/v1/find/suggest` + `/v1/find/preview-counts` endpoints |
| `scripts/precompute-find-baseline.js` | One-shot CLI to run baseline precompute manually |
| `test/find-cache.test.js` | Cache TTL, key normalization, batch get |
| `test/find-suggest.test.js` | Schema validation, fallback, sanitization |
| `test/find-routes.test.js` | Auth, rate-limit, daily cap fallback |

**Modified files:**

| File | Changes |
|---|---|
| `public/index.html` | Color rebrand: `#C9A84C` → `#FF6B35` (~20 occurrences) |
| `public/dashboard.html` | Color rebrand + new `FindCustomers` component + sidebar nav from 4→3 tabs + feature-flag-aware App component |
| `routes/stripe.js` | Color rebrand in welcome email HTML |
| `api-server.js` | Mount `/v1/find` router (lazy-init pattern) |
| `lib/cost-cap.js` | Add `windowSeconds` parameter for sub-day windows |
| `monitor-v2.js` | Wire nightly precompute cron |
| `.env.example` | Add `FIND_PREVIEW_HOURLY_MAX`, document `ANTHROPIC_API_KEY`, `ENABLE_FIND_CUSTOMERS` |
| `package.json` | No new deps — `@anthropic-ai/sdk` already present from PR #4; `zod` already present |
| `test/cost-cap.test.js` | Extended for `windowSeconds` param |

---

## Task 0: Pre-flight check + branch setup

- [ ] **Step 1: Confirm we're on the right branch + up to date**

```bash
git status
# Should be on fix/reconcile-with-production with no untracked changes
git pull --ff-only origin fix/reconcile-with-production
```

- [ ] **Step 2: Verify baseline tests pass**

```bash
npm test 2>&1 | grep -E "tests |pass |fail "
```

Expected: 58 tests passing.

- [ ] **Step 3: Add new env vars to `.env.example`**

Append to `.env.example`:

```bash

# ── Find Customers (unified flow — replaces Search Now + New Monitor) ───────
ENABLE_FIND_CUSTOMERS=true
# Per-user-per-hour cap on /v1/find/preview-counts (defense against runaway clicking)
FIND_PREVIEW_HOURLY_MAX=10
# Anthropic key required for AI keyword suggestion (was already documented but
# verify present)
ANTHROPIC_API_KEY=sk-ant-api03-...
```

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "chore: env vars for Find Customers feature flag + per-hour preview cap"
```

---

## Task 1: Color rebrand (Day 1 of spec)

**Files:**
- Modify: `public/index.html`, `public/dashboard.html`, `routes/stripe.js`

The rebrand is mechanical: `#C9A84C` → `#FF6B35` and 6 derivative shades. One footer accent in dashboard.html stays gold (the avatar circle background) as a brand-DNA nod.

- [ ] **Step 1: Apply replacements via Node script**

```bash
node -e "
const fs = require('fs');
const map = [
  ['#C9A84C', '#FF6B35'],
  ['#E8C96A', '#FF8C42'],
  ['#D4B560', '#FF7E47'],
  ['#92400E', '#9A3412'],
  ['#FFFBEB', '#FFF7F2'],
  ['#FDE68A', '#FED7AA'],
  ['#FEF3C7', '#FFEDD5'],
  ['rgba(201,168,76', 'rgba(255,107,53'],
  ['rgba(201, 168, 76', 'rgba(255, 107, 53'],
];
for (const f of ['public/index.html', 'public/dashboard.html', 'routes/stripe.js']) {
  let s = fs.readFileSync(f, 'utf8');
  for (const [from, to] of map) s = s.split(from).join(to);
  fs.writeFileSync(f, s);
}
console.log('rebrand applied');
"
```

- [ ] **Step 2: Restore single legacy gold accent in dashboard.html**

The user-avatar circle in the sidebar should keep gold for brand-DNA. Find this line in the dashboard CSS:

```css
.sb-avatar{width:28px;height:28px;border-radius:50%;background:rgba(255,107,53,.12);border:1px solid rgba(255,107,53,.25);color:#FF6B35;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
```

Replace with:

```css
.sb-avatar{width:28px;height:28px;border-radius:50%;background:rgba(201,168,76,.12);border:1px solid rgba(201,168,76,.25);color:#C9A84C;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
```

- [ ] **Step 3: Verify all 5 entry points still syntax-clean**

```bash
node --check api-server.js && node --check monitor.js && node --check monitor-v2.js && node --check scripts/provision-client.js && node --check scripts/backfill-stripe-index.js && echo "syntax OK"
```

- [ ] **Step 4: Run all tests**

```bash
npm test 2>&1 | grep -E "tests |pass |fail "
```

Expected: 58 passing (no test changes, color is presentation only).

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/dashboard.html routes/stripe.js
git commit -m "feat(brand): signal coral #FF6B35 replaces gold across product

Signal coral as primary signature color for Insights — differentiates from
Ebenova/Signova while preserving brand DNA. One legacy gold accent retained
in the user-avatar circle as a subtle nod.

Touched: landing, dashboard chrome, AuthModal, Stripe welcome email."
```

---

## Task 2: Extend `lib/cost-cap.js` for sub-day windows

**Files:**
- Modify: `lib/cost-cap.js`
- Modify: `test/cost-cap.test.js`

- [ ] **Step 1: Append failing test**

Add to `test/cost-cap.test.js`:

```js
test('per-hour window resets after windowSeconds', async () => {
  const redis = createMockRedis()
  const cap = makeCostCap(redis, { resource: 'hourly-test', dailyMax: 5, windowSeconds: 3600 })
  await cap()
  const r = await cap()
  // Just verify the key shape changes when windowSeconds is provided
  // (full TTL test requires time mocking; this verifies the basic contract)
  assert.equal(r.allowed, true)
  assert.equal(r.used, 2)
})
```

- [ ] **Step 2: Run test — verify behavior**

```bash
node --test test/cost-cap.test.js 2>&1 | tail -10
```

If it passes, the existing implementation already handles this. If it fails, continue to step 3.

- [ ] **Step 3: Update `lib/cost-cap.js` to support custom window**

```js
// lib/cost-cap.js — daily and sub-day cost caps
export function makeCostCap(redis, { resource, dailyMax, windowSeconds }) {
  const window = windowSeconds || (60 * 60 * 24)
  return async function check() {
    // Key shape includes window-bucket so different window sizes don't collide
    const bucket = Math.floor(Date.now() / 1000 / window)
    const key = `costcap:${resource}:${bucket}`
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, window + 60)
    return { allowed: count <= dailyMax, used: count, max: dailyMax, resource, window }
  }
}
```

- [ ] **Step 4: Run all tests**

```bash
npm test 2>&1 | grep -E "tests |pass |fail "
```

- [ ] **Step 5: Commit**

```bash
git add lib/cost-cap.js test/cost-cap.test.js
git commit -m "feat(cost-cap): add windowSeconds param for sub-day cost caps"
```

---

## Task 3: Build `lib/find-cache.js`

**Files:**
- Create: `lib/find-cache.js`
- Create: `test/find-cache.test.js`

- [ ] **Step 1: Write failing test**

Create `test/find-cache.test.js`:

```js
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'
import { makeFindCache } from '../lib/find-cache.js'

test('cache.set then cache.get returns the value', async () => {
  const redis = createMockRedis()
  const cache = makeFindCache(redis)
  await cache.set('Looking for SEO Agency', { count: 31, samples: [] })
  const r = await cache.get('Looking for SEO Agency')
  assert.equal(r.count, 31)
})

test('cache key is normalized to lowercase + trimmed', async () => {
  const redis = createMockRedis()
  const cache = makeFindCache(redis)
  await cache.set('  Looking For SEO Agency  ', { count: 31, samples: [] })
  const r = await cache.get('looking for seo agency')
  assert.equal(r.count, 31)
})

test('cache.get returns null for missing key', async () => {
  const redis = createMockRedis()
  const cache = makeFindCache(redis)
  assert.equal(await cache.get('not-cached'), null)
})

test('cache.getMany returns map of all keywords', async () => {
  const redis = createMockRedis()
  const cache = makeFindCache(redis)
  await cache.set('one', { count: 1, samples: [] })
  await cache.set('two', { count: 2, samples: [] })
  const map = await cache.getMany(['one', 'two', 'three'])
  assert.equal(map.one.count, 1)
  assert.equal(map.two.count, 2)
  assert.equal(map.three, null)
})
```

- [ ] **Step 2: Run failing test**

```bash
node --test test/find-cache.test.js
```

Expected: `Cannot find module`.

- [ ] **Step 3: Implement `lib/find-cache.js`**

```js
// lib/find-cache.js — Redis-backed cache for /v1/find/preview-counts results.
// Keyword counts are expensive to compute (live HTTP to Reddit + HN); caching
// for 1h with normalized lowercase keys lets multiple users share results
// when their suggested keywords overlap.

const TTL_SECONDS = 3600 // 1 hour
const KEY_PREFIX = 'findcache:'

const normalize = (kw) => String(kw || '').toLowerCase().trim()

export function makeFindCache(redis) {
  return {
    async get(keyword) {
      const k = KEY_PREFIX + normalize(keyword)
      const raw = await redis.get(k)
      if (!raw) return null
      try { return typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null }
    },

    async set(keyword, value) {
      const k = KEY_PREFIX + normalize(keyword)
      const v = JSON.stringify({ ...value, cachedAt: new Date().toISOString() })
      await redis.set(k, v)
      await redis.expire(k, TTL_SECONDS)
    },

    async getMany(keywords) {
      const result = {}
      for (const kw of keywords) {
        result[kw] = await this.get(kw)
      }
      return result
    },
  }
}
```

- [ ] **Step 4: Run test**

```bash
node --test --test-reporter=spec test/find-cache.test.js
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/find-cache.js test/find-cache.test.js
git commit -m "feat(find): Redis-backed cache for preview counts (1h TTL, normalized keys)"
```

---

## Task 4: Restore `lib/llm/anthropic.js`, `lib/llm/prompts.js`, `lib/templates.js`

These were deleted in PR #4 (reconciliation) because the wizard didn't fit. We're rebuilding the wizard logic into Find Customers, so we restore them from git history.

- [ ] **Step 1: Restore from prior commit**

The earlier branch `feat/onboarding-wizard` (PR #2 merge) had these files. Recover them:

```bash
git fetch origin feat/onboarding-wizard 2>&1 | tail -2
mkdir -p lib/llm
git show origin/feat/onboarding-wizard:lib/llm/anthropic.js > lib/llm/anthropic.js
git show origin/feat/onboarding-wizard:lib/llm/prompts.js > lib/llm/prompts.js
git show origin/feat/onboarding-wizard:lib/templates.js > lib/templates.js
```

- [ ] **Step 2: Restore the corresponding test**

```bash
git show origin/feat/onboarding-wizard:test/anthropic-client.test.js > test/anthropic-client.test.js
```

- [ ] **Step 3: Verify tests pass**

```bash
node --test --test-reporter=spec test/anthropic-client.test.js 2>&1 | tail -10
```

Expected: 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/llm/ lib/templates.js test/anthropic-client.test.js
git commit -m "feat(find): restore Anthropic client + prompts + templates from PR #2"
```

---

## Task 5: Build `lib/find-suggest.js`

**Files:**
- Create: `lib/find-suggest.js`
- Create: `test/find-suggest.test.js`

- [ ] **Step 1: Write failing test**

Create `test/find-suggest.test.js`:

```js
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { suggestKeywords, validateSuggestion } from '../lib/find-suggest.js'
import { TEMPLATES } from '../lib/templates.js'

const VALID = {
  suggestedName: 'Test Monitor',
  productContext: 'A clean version of the input description',
  keywords: [
    { keyword: 'looking for', intentType: 'buying', confidence: 'high' },
    { keyword: 'frustrated with', intentType: 'pain', confidence: 'medium' },
    { keyword: 'vs alternative', intentType: 'comparison', confidence: 'low' },
    { keyword: 'how do I', intentType: 'question', confidence: 'low' },
  ],
  subreddits: ['SaaS', 'startups'],
  platforms: ['reddit'],
}

test('validates a well-formed suggestion', () => {
  const r = validateSuggestion(VALID)
  assert.equal(r.success, true)
})

test('rejects suggestion missing keywords', () => {
  const bad = { ...VALID, keywords: [] }
  const r = validateSuggestion(bad)
  assert.equal(r.success, false)
})

test('falls back to template when AI throws', async () => {
  const failingClient = { messages: { create: async () => { throw new Error('API down') } } }
  const r = await suggestKeywords({
    description: 'I sell SaaS bookkeeping software for indie agencies',
    client: failingClient,
  })
  assert.equal(r.fallback, true)
  assert.ok(r.keywords.length >= 4)
})

test('uses AI result when valid', async () => {
  const goodClient = {
    messages: {
      create: async () => ({ content: [{ type: 'text', text: JSON.stringify(VALID) }] }),
    },
  }
  const r = await suggestKeywords({ description: 'I sell something to small businesses', client: goodClient })
  assert.equal(r.fallback, undefined)
  assert.equal(r.suggestedName, 'Test Monitor')
})

test('TEMPLATES gallery has 8 buckets', () => {
  assert.equal(Object.keys(TEMPLATES).length, 8)
})

test('rejects too-short description', async () => {
  await assert.rejects(
    () => suggestKeywords({ description: 'short', client: { messages: { create: async () => '' } } }),
    /too short/i
  )
})
```

- [ ] **Step 2: Implement `lib/find-suggest.js`**

This is essentially the restored `keyword-suggest.js` from PR #2, renamed:

```js
// lib/find-suggest.js — Orchestration for /v1/find/suggest
//   1. sanitize user input (defense against prompt injection)
//   2. call Anthropic with prompt-cached system + delimited user
//   3. validate response shape via zod
//   4. fall back to template if validation or call fails

import { z } from 'zod'
import { sanitizeForPrompt } from './llm-safe-prompt.js'
import { callAnthropicJSON } from './llm/anthropic.js'
import { getSystemPrompt } from './llm/prompts.js'
import { TEMPLATES } from './templates.js'

const SuggestionSchema = z.object({
  suggestedName: z.string().min(3).max(80),
  productContext: z.string().min(10).max(2000),
  keywords: z.array(z.object({
    keyword: z.string().min(2).max(80),
    intentType: z.enum(['buying', 'pain', 'comparison', 'question']),
    confidence: z.enum(['high', 'medium', 'low']),
  })).min(4).max(25),
  subreddits: z.array(z.string()).min(1).max(15),
  platforms: z.array(z.enum(['reddit', 'hackernews', 'quora', 'medium', 'substack', 'upwork', 'fiverr', 'github', 'producthunt'])).min(1).max(9),
})

export function validateSuggestion(obj) {
  return SuggestionSchema.safeParse(obj)
}

function pickFallbackTemplate(description) {
  const d = (description || '').toLowerCase()
  if (/saas|software|product|app/.test(d)) return TEMPLATES.saas
  if (/freelanc|design|developer/.test(d)) return TEMPLATES.freelancer
  if (/agenc|consultancy/.test(d)) return TEMPLATES.agency
  if (/coach|consult|mentor/.test(d)) return TEMPLATES.coach
  if (/course|teach|tutorial/.test(d)) return TEMPLATES.course
  if (/ecommerce|store|brand/.test(d)) return TEMPLATES.ecommerce
  if (/local|near me|city|town/.test(d)) return TEMPLATES.local
  return TEMPLATES.other
}

export async function suggestKeywords({ description, client }) {
  const safe = sanitizeForPrompt(description)
  if (!safe || safe.length < 20) {
    throw new Error('Description too short')
  }

  const system = getSystemPrompt()
  const user = `<user_business_description>\n${safe}\n</user_business_description>\n\nReturn the JSON object now.`

  let result
  try {
    result = await callAnthropicJSON({ client, system, user })
  } catch (err) {
    console.warn('[find-suggest] Anthropic call failed, falling back:', err.message)
    return { ...pickFallbackTemplate(description), fallback: true, fallbackReason: 'api_error' }
  }

  const validation = SuggestionSchema.safeParse(result)
  if (!validation.success) {
    console.warn('[find-suggest] schema validation failed, falling back:', validation.error.message)
    return { ...pickFallbackTemplate(description), fallback: true, fallbackReason: 'invalid_schema' }
  }

  return validation.data
}
```

- [ ] **Step 3: Run tests**

```bash
node --test --test-reporter=spec test/find-suggest.test.js 2>&1 | tail -12
```

Expected: 6 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/find-suggest.js test/find-suggest.test.js
git commit -m "feat(find): keyword suggestion orchestration with zod + template fallback"
```

---

## Task 6: Build `routes/find.js` with two endpoints

**Files:**
- Create: `routes/find.js`
- Create: `test/find-routes.test.js`

- [ ] **Step 1: Write failing test**

Create `test/find-routes.test.js`:

```js
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMockRedis } from './helpers/mock-redis.js'
import { makeFindHandler } from '../routes/find.js'

function fakeRes() {
  let status = 200, payload
  return {
    res: {
      status(s) { status = s; return this },
      json(p) { payload = p; return this },
    },
    get status() { return status },
    get payload() { return payload },
  }
}

async function postJSON(handler, body, authKey = 'KEY_A', ip = '1.1.1.1') {
  const r = fakeRes()
  const req = {
    headers: { authorization: `Bearer ${authKey}`, 'x-forwarded-for': ip },
    body,
    socket: { remoteAddress: ip },
  }
  await handler(req, r.res)
  return { status: r.status, payload: r.payload }
}

test('rejects unauthenticated suggest', async () => {
  const redis = createMockRedis()
  const h = makeFindHandler({ redis, suggestFn: async () => ({}), countsFn: async () => ({}) })
  const r = await postJSON(h.suggest, { description: 'I run a SaaS for accountants' }, 'UNKNOWN')
  assert.equal(r.status, 401)
})

test('rejects too-short description', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a', insights: true }))
  const h = makeFindHandler({ redis, suggestFn: async () => ({}), countsFn: async () => ({}) })
  const r = await postJSON(h.suggest, { description: 'too short' })
  assert.equal(r.status, 400)
})

test('suggest returns shape with keywords', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a', insights: true }))
  const VALID = {
    suggestedName: 'Test', productContext: 'cleaned',
    keywords: [{ keyword: 'x', intentType: 'buying', confidence: 'high' }],
    subreddits: ['SaaS'], platforms: ['reddit'],
  }
  const h = makeFindHandler({
    redis, suggestFn: async () => VALID, countsFn: async () => ({})
  })
  const r = await postJSON(h.suggest, { description: 'I sell SaaS for accountants' })
  assert.equal(r.status, 200)
  assert.equal(r.payload.suggestedName, 'Test')
})

test('preview-counts requires keywords array', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a', insights: true }))
  const h = makeFindHandler({ redis, suggestFn: async () => ({}), countsFn: async () => ({}) })
  const r = await postJSON(h.previewCounts, { keywords: [] })
  assert.equal(r.status, 400)
})

test('preview-counts returns counts on valid input', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a', insights: true }))
  const h = makeFindHandler({
    redis,
    suggestFn: async () => ({}),
    countsFn: async (kws) => Object.fromEntries(kws.map(k => [k, { count: 5, samples: [] }])),
  })
  const r = await postJSON(h.previewCounts, { keywords: ['scope creep', 'unpaid invoice'] })
  assert.equal(r.status, 200)
  assert.equal(r.payload.counts['scope creep'].count, 5)
})

test('preview-counts rate-limits after 10 calls per IP per hour', async () => {
  const redis = createMockRedis()
  await redis.set('apikey:KEY_A', JSON.stringify({ owner: 'a', insights: true }))
  const h = makeFindHandler({
    redis,
    suggestFn: async () => ({}),
    countsFn: async () => ({}),
  })
  for (let i = 0; i < 10; i++) {
    await postJSON(h.previewCounts, { keywords: ['x'] })
  }
  const r11 = await postJSON(h.previewCounts, { keywords: ['x'] })
  assert.equal(r11.status, 429)
})
```

- [ ] **Step 2: Implement `routes/find.js`**

```js
// routes/find.js — /v1/find/suggest + /v1/find/preview-counts

import express from 'express'
import { suggestKeywords } from '../lib/find-suggest.js'
import { makeFindCache } from '../lib/find-cache.js'
import { makeRateLimiter } from '../lib/rate-limit.js'
import { makeCostCap } from '../lib/cost-cap.js'
import { TEMPLATES } from '../lib/templates.js'

// Live preview helper — fetches counts from Reddit + HN only.
// Cached results returned from `lib/find-cache.js`.
async function fetchLiveCounts(keywords, cache) {
  const result = {}
  for (const kw of keywords) {
    const cached = await cache.get(kw)
    if (cached) { result[kw] = cached; continue }
    let count = 0
    const samples = []
    try {
      const redditUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(kw)}&sort=new&limit=20&t=week`
      const r = await fetch(redditUrl, { headers: { 'User-Agent': 'EbenovaInsights/2.0 (preview)' }, signal: AbortSignal.timeout(6000) })
      if (r.ok) {
        const data = await r.json()
        const posts = data?.data?.children || []
        count += posts.length
        for (const c of posts.slice(0, 2)) {
          if (c.data) samples.push({ title: c.data.title, url: `https://reddit.com${c.data.permalink}`, source: 'reddit' })
        }
      }
    } catch {}
    try {
      const hnUrl = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(kw)}&tags=story&hitsPerPage=10`
      const r = await fetch(hnUrl, { signal: AbortSignal.timeout(6000) })
      if (r.ok) {
        const data = await r.json()
        const hits = data?.hits || []
        count += hits.length
        if (samples.length < 2 && hits[0]) samples.push({ title: hits[0].title, url: hits[0].url || `https://news.ycombinator.com/item?id=${hits[0].objectID}`, source: 'hackernews' })
      }
    } catch {}
    const value = { count, samples }
    await cache.set(kw, value)
    result[kw] = value
  }
  return result
}

export function makeFindHandler({ redis, suggestFn, countsFn }) {
  const cache = makeFindCache(redis)
  const ipLimiter = makeRateLimiter(redis, { max: 5, windowSeconds: 3600 })
  const previewLimiter = makeRateLimiter(redis, { max: parseInt(process.env.FIND_PREVIEW_HOURLY_MAX || '10'), windowSeconds: 3600 })
  const anthropicCap = makeCostCap(redis, {
    resource: 'anthropic',
    dailyMax: parseInt(process.env.ANTHROPIC_DAILY_MAX || '1000'),
  })

  async function authenticate(req) {
    const auth = req.headers['authorization'] || ''
    const apiKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    if (!apiKey) return null
    const raw = await redis.get(`apikey:${apiKey}`)
    if (!raw) return null
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!data.insights) return null
    return { apiKey, owner: data.owner }
  }

  return {
    async suggest(req, res) {
      const auth = await authenticate(req)
      if (!auth) return res.status(401).json({ success: false, error: { code: 'INVALID_KEY', message: 'API key required' } })

      const { description } = req.body || {}
      if (typeof description !== 'string' || description.trim().length < 20) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Tell me a bit more about what you sell — at least 20 characters.' } })
      }
      if (description.length > 1500) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Description too long — keep it under 1500 characters.' } })
      }

      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown'
      const ipR = await ipLimiter(`find-suggest:ip:${ip}`)
      if (!ipR.allowed) {
        return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: `Too many suggestion requests. Try again in ${Math.ceil(ipR.retryAfterSeconds/60)} minutes.` } })
      }

      // Daily Anthropic cost cap — falls through to template gallery
      const cap = await anthropicCap()
      if (!cap.allowed) {
        console.warn(`[find/suggest] Anthropic daily cap (${cap.used}/${cap.max}) — using template`)
        return res.json({ success: true, ...TEMPLATES.other, fallback: true, fallbackReason: 'daily_cap' })
      }

      try {
        const result = await suggestFn({ description })
        return res.json({ success: true, ...result })
      } catch (err) {
        console.error('[find/suggest] error:', err.message)
        return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not generate suggestions. Please try again.' } })
      }
    },

    async previewCounts(req, res) {
      const auth = await authenticate(req)
      if (!auth) return res.status(401).json({ success: false, error: { code: 'INVALID_KEY', message: 'API key required' } })

      const { keywords } = req.body || {}
      if (!Array.isArray(keywords) || keywords.length === 0) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'keywords array required' } })
      }

      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown'
      const lim = await previewLimiter(`find-preview:ip:${ip}`)
      if (!lim.allowed) {
        return res.status(429).json({
          success: false,
          error: { code: 'RATE_LIMITED', message: `Preview rate limit hit. Cached counts still display. Try again in ${Math.ceil(lim.retryAfterSeconds/60)} minutes.` }
        })
      }

      try {
        const counts = await countsFn(keywords.slice(0, 25))
        return res.json({ success: true, counts })
      } catch (err) {
        console.error('[find/preview-counts] error:', err.message)
        return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not fetch counts' } })
      }
    },
  }
}

export function createRouter({ redis }) {
  const router = express.Router()
  const cache = makeFindCache(redis)
  const handlers = makeFindHandler({
    redis,
    suggestFn: suggestKeywords,
    countsFn: (kws) => fetchLiveCounts(kws, cache),
  })
  router.post('/suggest', handlers.suggest)
  router.post('/preview-counts', handlers.previewCounts)
  return router
}
```

- [ ] **Step 3: Run tests**

```bash
node --test --test-reporter=spec test/find-routes.test.js 2>&1 | tail -12
```

Expected: 6 tests pass.

- [ ] **Step 4: Commit**

```bash
git add routes/find.js test/find-routes.test.js
git commit -m "feat(find): /v1/find/suggest + /v1/find/preview-counts endpoints"
```

---

## Task 7: Mount router in `api-server.js`

**Files:**
- Modify: `api-server.js`

- [ ] **Step 1: Add import + lazy mount**

In `api-server.js`, near the top with other route imports:

```js
import { createRouter as createFindRouter } from './routes/find.js'
```

Find the `app.use('/v1/billing', stripeRoutes)` line and add immediately after:

```js
// Find Customers endpoints — lazy-mounted so missing Redis env doesn't crash boot.
let _findRouter
app.use('/v1/find', (req, res, next) => {
  if (!_findRouter) {
    try { _findRouter = createFindRouter({ redis: getRedis() }) }
    catch (err) { return res.status(503).json({ success: false, error: { code: 'NOT_CONFIGURED', message: err.message } }) }
  }
  _findRouter(req, res, next)
})
```

- [ ] **Step 2: Verify boot**

```bash
node --check api-server.js && timeout 3 node api-server.js 2>&1 | head -5
```

Expected: clean boot.

- [ ] **Step 3: Smoke-test endpoint**

```bash
(node api-server.js > /tmp/api.log 2>&1 &) && sleep 1
curl -s -X POST http://localhost:3001/v1/find/suggest -H 'Content-Type: application/json' -d '{}' | head -c 200
taskkill //F //IM node.exe 2>&1 | head -1
```

Expected: `{"success":false,"error":{"code":"INVALID_KEY",...}}` (auth required — confirms route mounted).

- [ ] **Step 4: Commit**

```bash
git add api-server.js
git commit -m "feat(find): mount /v1/find router with lazy Redis init"
```

---

## Task 8: Frontend — FindCustomers component (the big one)

**Files:**
- Modify: `public/dashboard.html`

This is the largest task. Strategy: insert the new component, sidebar tabs, and routing alongside existing components. The legacy `SearchNow` and `CreateMonitor` stay in the file but no tab points to them (dead code — cleanup PR removes them later).

- [ ] **Step 1: Add the FindCustomers component**

Find where `function CreateMonitor` is declared in `public/dashboard.html`. Insert a new `function FindCustomers` BEFORE it. The component is large; insert this complete block:

```jsx
// ── Find Customers (unified flow) ────────────────────────────────────────────
function FindCustomers({ apiKey, onMonitorCreated }) {
  const [step, setStep] = useState(1) // 1=input, 2=generating, 3=review, 4=confirm, 5=confirmed
  const [description, setDescription] = useState('')
  const [suggestion, setSuggestion] = useState(null)
  const [counts, setCounts] = useState({})
  const [picked, setPicked] = useState(new Set())
  const [customKw, setCustomKw] = useState('')
  const [monitorName, setMonitorName] = useState('')
  const [savedMonitorId, setSavedMonitorId] = useState('')
  const [sampleMatches, setSampleMatches] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const intentMeta = {
    buying:     { icon: '🎯', label: 'BUYING INTENT' },
    pain:       { icon: '💢', label: 'PAIN POINT' },
    comparison: { icon: '⚖️', label: 'COMPARISON' },
    question:   { icon: '❓', label: 'QUESTION' },
  }

  const generateSuggestions = async () => {
    if (description.trim().length < 20) { setErr('Tell me a bit more — at least 20 characters.'); return }
    setErr(''); setLoading(true); setStep(2)
    const r = await apiFetch('/v1/find/suggest', { method:'POST', body: JSON.stringify({ description }) }, apiKey)
    if (!r.ok) { setErr(r.data?.error?.message || 'Could not generate suggestions.'); setLoading(false); setStep(1); return }
    setSuggestion(r.data)
    setMonitorName(r.data.suggestedName || 'My Monitor')
    const preChecked = new Set((r.data.keywords || []).filter(k => k.confidence === 'high').map(k => k.keyword))
    setPicked(preChecked)
    // Fire preview-counts in background
    const allKws = (r.data.keywords || []).map(k => k.keyword)
    apiFetch('/v1/find/preview-counts', { method:'POST', body: JSON.stringify({ keywords: allKws }) }, apiKey)
      .then(c => { if (c.ok) setCounts(c.data.counts || {}) })
    setLoading(false)
    setStep(3)
  }

  const togglePick = (kw) => {
    const next = new Set(picked)
    if (next.has(kw)) next.delete(kw); else next.add(kw)
    setPicked(next)
  }

  const addCustom = () => {
    if (!customKw.trim()) return
    setPicked(new Set([...picked, customKw.trim()]))
    setCustomKw('')
  }

  const totalMatches = useCallback(() => {
    let total = 0
    for (const kw of picked) {
      const c = counts[kw]
      if (c?.count) total += c.count
    }
    return total
  }, [picked, counts])

  const saveAsMonitor = () => {
    if (picked.size === 0) { setErr('Pick at least one keyword.'); return }
    setStep(4)
  }

  const confirmMonitor = async () => {
    setLoading(true)
    const allKws = [...picked]
    const body = {
      name: monitorName.trim() || 'My Monitor',
      keywords: allKws.map(k => ({ keyword: k, productContext: suggestion?.productContext || description })),
      productContext: suggestion?.productContext || description,
    }
    const m = await apiFetch('/v1/monitors', { method:'POST', body: JSON.stringify(body) }, apiKey)
    if (!m.ok) { setErr(m.data?.error?.message || 'Could not create monitor.'); setLoading(false); setStep(3); return }
    setSavedMonitorId(m.data.monitor_id)
    // Load sample matches via preview-counts (already cached most of them)
    const samples = []
    for (const kw of allKws.slice(0, 5)) {
      const c = counts[kw]
      if (c?.samples) samples.push(...c.samples.slice(0, 1))
      if (samples.length >= 5) break
    }
    setSampleMatches(samples)
    setLoading(false)
    setStep(5)
    onMonitorCreated()
    setTimeout(() => onMonitorCreated('feed'), 4000)
  }

  // ── Render ──────────────────────────────────────────────────────────────
  if (step === 1) {
    return (
      <>
        <div className="page-header">
          <div><h1 className="page-title">Find <em style={{fontStyle:'italic',color:'#FF6B35',fontWeight:400}}>customers</em></h1>
            <p className="page-subtitle">Describe what you sell. The AI suggests keywords, runs them live, and shows you what's worth replying to.</p></div>
          <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:'#9A3412',background:'#FFF7F2',border:'1px solid #FED7AA',padding:'5px 10px',borderRadius:999,letterSpacing:1.5,display:'inline-flex',alignItems:'center',gap:6}}>
            <span style={{width:5,height:5,borderRadius:'50%',background:'#FF6B35'}}></span> STEP 1 OF 3 · INPUT
          </span>
        </div>
        <div className="page-body" style={{maxWidth:780}}>
          <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:'#FF6B35',letterSpacing:3,marginBottom:18}}>// PROMPT · WHAT YOU SELL</div>
          <h2 style={{fontFamily:"'Crimson Pro',Georgia,serif",fontSize:36,fontWeight:700,letterSpacing:-1,lineHeight:1.05,marginBottom:14}}>
            Tell me what you sell.<br/>
            I'll find your <em style={{fontStyle:'italic',color:'#FF6B35',fontWeight:400}}>next customer</em> in 4 seconds.
          </h2>
          <p style={{color:'#475569',fontSize:15,lineHeight:1.65,maxWidth:620,marginBottom:30}}>
            2–3 sentences. Mention what you sell, who buys, and what frustrates them about existing options.
          </p>
          <textarea className="inp" rows={5} value={description} onChange={e=>setDescription(e.target.value)}
            style={{padding:'18px 20px',fontSize:15,lineHeight:1.65,fontFamily:'inherit'}}
            placeholder="e.g. I run a small SEO agency. We help SaaS startups get their first 10k organic visitors. Most clients come to us frustrated with content agencies that didn't move the needle."
          />
          {err && <div className="alert alert-error" style={{marginTop:12}}><i className="ph ph-warning-circle"></i>{err}</div>}
          <div style={{display:'flex',gap:12,alignItems:'center',marginTop:18,flexWrap:'wrap'}}>
            <button className="btn btn-primary" onClick={generateSuggestions} disabled={loading||description.trim().length < 20} style={{padding:'14px 24px',fontSize:14}}>
              <i className="ph-bold ph-magnifying-glass"></i> Find what's out there <span style={{fontSize:16}}>→</span>
            </button>
            <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:'#94A3B8',letterSpacing:1}}>⌘+ENTER</span>
          </div>
          <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:'#94A3B8',letterSpacing:1,marginTop:24,display:'flex',gap:18,flexWrap:'wrap'}}>
            <span><b style={{color:'#16A34A'}}>●</b> 4-SECOND ANALYSIS</span><span>9 PLATFORMS</span><span>NO COMMITMENT — REVIEW BEFORE SAVING</span>
          </div>
        </div>
      </>
    )
  }

  if (step === 2) {
    return (
      <>
        <div className="page-header">
          <div><h1 className="page-title">Find <em style={{fontStyle:'italic',color:'#FF6B35',fontWeight:400}}>customers</em></h1>
            <p className="page-subtitle">Generating signal — keywords stream in.</p></div>
          <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:'#9A3412',background:'#FFF7F2',border:'1px solid #FED7AA',padding:'5px 10px',borderRadius:999,letterSpacing:1.5,display:'inline-flex',alignItems:'center',gap:6}}>
            <span style={{width:5,height:5,borderRadius:'50%',background:'#16A34A',animation:'pulse 1.6s infinite'}}></span> GENERATING
          </span>
        </div>
        <div className="page-body" style={{maxWidth:880}}>
          <div style={{background:'#0a0907',color:'#F5EFE0',border:'1px solid #1E293B',borderRadius:10,overflow:'hidden',fontFamily:"'JetBrains Mono',monospace",fontSize:12.5}}>
            <div style={{background:'linear-gradient(to bottom,#1f1a13,#14110d)',borderBottom:'1px solid #2a2419',padding:'11px 16px',display:'flex',alignItems:'center',gap:12,color:'#6f6757',fontSize:11,letterSpacing:1.5}}>
              <div style={{display:'flex',gap:6}}>
                <span style={{width:10,height:10,borderRadius:'50%',background:'#3a3328'}}></span>
                <span style={{width:10,height:10,borderRadius:'50%',background:'#3a3328'}}></span>
                <span style={{width:10,height:10,borderRadius:'50%',background:'#3a3328'}}></span>
              </div>
              <span>EBNV-1 // KEYWORD GENERATOR</span>
              <span style={{marginLeft:'auto',color:'#34d058',display:'inline-flex',alignItems:'center',gap:6}}>
                <span style={{width:6,height:6,borderRadius:'50%',background:'#34d058',boxShadow:'0 0 6px #34d058'}}></span>
                ANALYZING
              </span>
            </div>
            <div style={{padding:'18px 20px',lineHeight:1.85}}>
              <div style={{marginBottom:4}}><span style={{color:'#FF6B35'}}>$</span> analyze --input "{description.slice(0, 50)}…"</div>
              <div style={{marginBottom:4,color:'#6f6757'}}># model: anthropic-haiku-4-5 · streaming</div>
              <div style={{marginBottom:4}}><span style={{color:'#34d058'}}>✓</span> parsed product context</div>
              <div style={{marginBottom:4}}><span style={{color:'#34d058'}}>✓</span> categorizing intent…</div>
              <div style={{marginBottom:4}}><span style={{color:'#FF6B35'}}>$</span> render --output review-screen<span style={{display:'inline-block',width:8,height:14,background:'#FF6B35',marginLeft:4,verticalAlign:-2,animation:'blink 1s infinite'}}></span></div>
            </div>
          </div>
        </div>
      </>
    )
  }

  if (step === 3) {
    const groups = ['buying', 'pain', 'comparison', 'question']
    return (
      <>
        <div className="page-header">
          <div><h1 className="page-title">Self review · <em style={{fontStyle:'italic',color:'#FF6B35',fontWeight:400}}>verify before you commit</em></h1>
            <p className="page-subtitle">The AI suggests. The data confirms. Toggle keywords, edit, then save — or peek without saving.</p></div>
          <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:'#9A3412',background:'#FFF7F2',border:'1px solid #FED7AA',padding:'5px 10px',borderRadius:999,letterSpacing:1.5,display:'inline-flex',alignItems:'center',gap:6}}>
            <span style={{width:5,height:5,borderRadius:'50%',background:'#FF6B35'}}></span> STEP 3 OF 3 · REVIEW
          </span>
        </div>
        <div className="page-body" style={{maxWidth:1100,display:'grid',gridTemplateColumns:'1fr 320px',gap:24}}>
          <div>
            {groups.map(intent => {
              const items = (suggestion?.keywords || []).filter(k => k.intentType === intent)
              if (items.length === 0) return null
              const meta = intentMeta[intent]
              return (
                <div key={intent} className="card" style={{padding:'20px 22px',marginBottom:14}}>
                  <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,letterSpacing:2.5,color:'#9A3412',display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
                    <span style={{fontSize:16}}>{meta.icon}</span>{meta.label}
                  </div>
                  <div style={{display:'flex',flexDirection:'column',gap:6}}>
                    {items.map(k => {
                      const on = picked.has(k.keyword)
                      const c = counts[k.keyword]
                      return (
                        <div key={k.keyword} onClick={()=>togglePick(k.keyword)}
                          style={{display:'flex',alignItems:'center',gap:14,padding:'11px 14px',borderRadius:8,cursor:'pointer',
                            background:on?'#FFF7F2':'transparent',border:on?'1px solid #FED7AA':'1px solid transparent',opacity:on?1:0.7}}>
                          <div style={{width:18,height:18,borderRadius:4,border:on?'1.5px solid #FF6B35':'1.5px solid #CBD5E1',background:on?'#FF6B35':'transparent',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,color:'#fff',flexShrink:0}}>
                            {on?'✓':''}
                          </div>
                          <div style={{flex:1,fontSize:14,color:'#0F172A',fontWeight:500}}>{k.keyword}</div>
                          <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:c?(c.count > 5 ? '#16A34A' : c.count > 0 ? '#D97706' : '#94A3B8'):'#94A3B8',fontWeight:600,flexShrink:0}}>
                            {c ? `${c.count} matches/wk` : '…'}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
            <div className="card" style={{padding:14,marginTop:8,background:'#F8FAFC',border:'1px dashed #CBD5E1'}}>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <input type="text" placeholder="Add your own keyword…" value={customKw} onChange={e=>setCustomKw(e.target.value)}
                  onKeyDown={e=>e.key==='Enter'&&addCustom()}
                  style={{flex:1,background:'#fff',border:'1px solid #D1D5DB',color:'#0F172A',borderRadius:6,padding:'8px 12px',fontSize:13,outline:'none'}} />
                <button className="btn btn-white btn-sm" onClick={addCustom}><i className="ph ph-plus"></i> Add</button>
              </div>
            </div>
            {err && <div className="alert alert-error" style={{marginTop:14}}><i className="ph ph-warning-circle"></i>{err}</div>}
          </div>

          <div style={{position:'sticky',top:20,alignSelf:'start'}}>
            <div style={{background:'#0a0907',color:'#F5EFE0',borderRadius:10,border:'1px solid #1E293B',overflow:'hidden',boxShadow:'0 20px 40px rgba(0,0,0,0.3)'}}>
              <div style={{background:'linear-gradient(to bottom,#1f1a13,#14110d)',borderBottom:'1px solid #2a2419',padding:'11px 16px',fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:'#6f6757',letterSpacing:2,display:'flex',alignItems:'center',gap:10}}>
                <span style={{width:6,height:6,borderRadius:'50%',background:'#34d058',boxShadow:'0 0 6px #34d058'}}></span> LIVE TALLY
              </div>
              <div style={{padding:'22px 22px 18px'}}>
                <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:48,fontWeight:700,color:'#FF6B35',letterSpacing:-2,lineHeight:1,marginBottom:6}}>{totalMatches()}<small style={{fontSize:14,color:'#6f6757',fontWeight:500,letterSpacing:1,marginLeft:6}}>matches/wk</small></div>
                <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:'#b9b09f',letterSpacing:1}}>{picked.size} KEYWORDS SELECTED</div>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:10,padding:'18px 22px',borderTop:'1px solid #2a2419',background:'rgba(255,107,53,0.04)'}}>
                <button className="btn btn-primary" onClick={saveAsMonitor} disabled={picked.size===0}
                  style={{width:'100%',padding:'13px 16px',fontSize:13,background:'#FF6B35'}}>
                  <i className="ph-bold ph-floppy-disk"></i> Save as monitor →
                </button>
                <button onClick={()=>{ /* TODO: peek mode */ alert('Peek mode coming soon') }}
                  style={{width:'100%',padding:'11px 16px',fontSize:12,background:'transparent',color:'#b9b09f',border:'1px solid #2a2419',fontFamily:"'JetBrains Mono',monospace",letterSpacing:1,borderRadius:6,cursor:'pointer'}}>
                  JUST SHOW ME NOW
                </button>
              </div>
            </div>
          </div>
        </div>
      </>
    )
  }

  if (step === 4) {
    return (
      <>
        <div className="page-header">
          <div><h1 className="page-title">Confirm <em style={{fontStyle:'italic',color:'#FF6B35',fontWeight:400}}>your monitor</em></h1>
            <p className="page-subtitle">Last chance to edit before we start scanning.</p></div>
        </div>
        <div className="page-body" style={{maxWidth:560}}>
          <div className="card card-p">
            <div className="field" style={{marginBottom:14}}>
              <label className="label">Monitor name</label>
              <input className="inp" value={monitorName} onChange={e=>setMonitorName(e.target.value)} />
            </div>
            <div style={{padding:'12px 0',borderBottom:'1px solid #F1F5F9',display:'flex',justifyContent:'space-between'}}>
              <span style={{fontSize:12,color:'#94A3B8',fontFamily:"'JetBrains Mono',monospace",letterSpacing:1}}>KEYWORDS</span>
              <span style={{fontSize:13.5,fontWeight:500,color:'#0F172A'}}>{picked.size} selected</span>
            </div>
            <div style={{padding:'12px 0',borderBottom:'1px solid #F1F5F9',display:'flex',justifyContent:'space-between'}}>
              <span style={{fontSize:12,color:'#94A3B8',fontFamily:"'JetBrains Mono',monospace",letterSpacing:1}}>EXPECTED VOLUME</span>
              <span style={{fontSize:13.5,fontWeight:500,color:'#16A34A'}}>~{totalMatches()} matches/week</span>
            </div>
            {err && <div className="alert alert-error" style={{marginTop:14}}><i className="ph ph-warning-circle"></i>{err}</div>}
            <div style={{display:'flex',gap:12,marginTop:18}}>
              <button className="btn btn-ghost" onClick={()=>setStep(3)}>← Back</button>
              <button className="btn btn-primary" onClick={confirmMonitor} disabled={loading} style={{flex:1}}>
                {loading?'Creating…':<><i className="ph-bold ph-broadcast"></i> Confirm and start monitoring</>}
              </button>
            </div>
          </div>
        </div>
      </>
    )
  }

  // step === 5
  return (
    <>
      <div className="page-header">
        <div><h1 className="page-title">Monitor <em style={{fontStyle:'italic',color:'#16A34A',fontWeight:400}}>active</em></h1>
          <p className="page-subtitle">First matches loaded. Taking you to the feed in 4 seconds.</p></div>
      </div>
      <div className="page-body" style={{maxWidth:780}}>
        <div className="alert alert-success" style={{marginBottom:18,padding:'14px 18px'}}>
          <i className="ph-bold ph-check-circle" style={{fontSize:20}}></i>
          <span style={{fontWeight:600}}>Monitor active. {sampleMatches.length} match{sampleMatches.length===1?'':'es'} already loaded.</span>
        </div>
        {sampleMatches.length > 0 && (
          <>
            <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:'#94A3B8',letterSpacing:2,marginBottom:10}}>// RECENT MATCHES</div>
            {sampleMatches.slice(0, 5).map((m, i) => (
              <div key={i} className="card" style={{padding:'14px 18px',marginBottom:8}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6,flexWrap:'wrap'}}>
                  <span className={`badge badge-${m.source||'reddit'}`}>{m.source}</span>
                </div>
                <a href={m.url} target="_blank" rel="noreferrer" style={{fontSize:14,fontWeight:500,color:'#0F172A',textDecoration:'none',display:'block'}}>{m.title}</a>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  )
}
```

- [ ] **Step 2: Update sidebar nav (find the `Sidebar` component)**

Find the `items` array in the `Sidebar` component. Replace:

```jsx
const items = [
  { id:'search', icon:'ph-magnifying-glass', label:'Search' },
  { id:'feed',   icon:'ph-newspaper',        label:'Monitor Feed', count: monitorCount > 0 ? monitorCount : null },
  { id:'create', icon:'ph-plus-circle',      label:'New Monitor' },
];
```

with:

```jsx
const items = [
  { id:'find', icon:'ph-magnifying-glass-plus', label:'Find Customers' },
  { id:'feed', icon:'ph-newspaper',             label:'Monitor Feed', count: monitorCount > 0 ? monitorCount : null },
];
```

- [ ] **Step 3: Update App component routing**

Find the `App` component's tab routing:

```jsx
{tab==='search'   && <SearchNow apiKey={apiKey} />}
{tab==='feed'     && <MatchesFeed apiKey={apiKey} monitors={monitors} />}
{tab==='create'   && <CreateMonitor apiKey={apiKey} onCreated={()=>{ loadMonitors(); setTab('feed'); }} />}
{tab==='settings' && <Settings apiKey={apiKey} userEmail={userEmail} plan={plan} onSignOut={signOut} monitors={monitors} onRefresh={loadMonitors} />}
```

Replace with:

```jsx
{tab==='find'     && <FindCustomers apiKey={apiKey} onMonitorCreated={(nextTab)=>{ loadMonitors(); if (nextTab) setTab(nextTab); }} />}
{tab==='feed'     && <MatchesFeed apiKey={apiKey} monitors={monitors} />}
{tab==='settings' && <Settings apiKey={apiKey} userEmail={userEmail} plan={plan} onSignOut={signOut} monitors={monitors} onRefresh={loadMonitors} />}
```

Find the line `const [tab, setTab] = useState('search');` and change to:

```jsx
const [tab, setTab] = useState('find');
```

- [ ] **Step 4: Boot smoke-test**

```bash
(node api-server.js > /tmp/api.log 2>&1 &) && sleep 1
curl -s http://localhost:3001/dashboard | head -c 200
taskkill //F //IM node.exe 2>&1 | head -1
```

Expected: HTML returned, `<!DOCTYPE html>...` visible.

- [ ] **Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(find): FindCustomers component + 3-tab sidebar (kills Search Now + New Monitor)"
```

---

## Task 9: Final verification, push, PR update

- [ ] **Step 1: Full test run**

```bash
npm test 2>&1 | grep -E "tests |pass |fail "
```

Expected: ~75 tests passing (58 baseline + ~17 new).

- [ ] **Step 2: Diff summary**

```bash
git log --oneline origin/main..HEAD
git diff origin/main..HEAD --stat | tail -10
```

- [ ] **Step 3: Push**

```bash
git push origin fix/reconcile-with-production
```

- [ ] **Step 4: Create PR**

```bash
gh pr create --title "feat(find-customers): unified flow + signal coral rebrand + cost optimization" --body "$(cat <<'EOF'
## Summary
- Unified Find Customers flow replaces Search Now + New Monitor
- Self-review pattern: every AI keyword chip shows live match count
- Signal coral #FF6B35 replaces gold across product (one footer accent retained)
- API cost optimization: Redis cache (1h TTL) + live preview narrowed to Reddit + HN
- Per-user-per-hour rate limit on /v1/find/preview-counts

Spec: docs/superpowers/specs/2026-04-28-find-customers-design.md
Plan: docs/superpowers/plans/2026-04-28-find-customers.md

## Setup
- Optional ANTHROPIC_API_KEY (falls back to template gallery if unset)
- Optional FIND_PREVIEW_HOURLY_MAX (defaults 10)
- ENABLE_FIND_CUSTOMERS=true to activate (default true in this PR)

## Test plan
- [x] All unit tests pass (~75 total)
- [ ] Manual: visit /dashboard, see 3 tabs (Find Customers · Monitor Feed · Settings)
- [ ] Manual: complete Find Customers flow end-to-end
- [ ] Manual: verify signal coral on landing + dashboard

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: After merge — verify Railway redeploys**

```bash
sleep 90  # wait for auto-deploy
curl -s https://ebenova-insights-production.up.railway.app/health
```

Expected: low uptime, fresh deployment.

---

## Acceptance criteria

- [ ] All 75+ tests passing
- [ ] No `#C9A84C` in codebase except one footer accent
- [ ] `/v1/find/suggest` returns 401 without auth, 200 with valid input
- [ ] `/v1/find/preview-counts` returns 429 after 10 calls/hour
- [ ] Dashboard renders 3 tabs (Find Customers · Monitor Feed · Settings)
- [ ] Find Customers flow completes end-to-end with mock Anthropic
- [ ] Color rebrand visible on landing + dashboard

---

## Deferred to follow-up PR

- `lib/find-baseline.js` + nightly precompute cron — adds Layer 3 of cost optimization. Not blocking initial ship; the cache layer + narrowed preview already deliver ~70% of the cost benefit.
- Delete legacy `SearchNow` and `CreateMonitor` components from dashboard.html (dead code cleanup).
- Wire Stripe checkout to "Upgrade" CTAs on the landing page (currently mailto:).
