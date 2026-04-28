# Branch 3a — Functional Bug Fixes — Design

**Status:** Active
**Author:** Claude (with Olumide)
**Date:** 2026-04-28
**Scope:** 6 well-defined functional bugs surfaced by the 2026-04 audit
**Estimated time:** 3-4 days, one engineer
**Branch:** `fix/branch-3a-functional-bugs`

---

## Problem

After Branch 1 (critical fixes) and Branch 2 (wizard + foundation hardening) shipped, six functional bugs from the audit remain in production. None are bleeding revenue or exposing security holes — the previous two branches handled those — but each is producing wrong results today:

1. **Scraper ID collisions** (`lib/scrapers/{fiverr,upwork,quora}.js`) — different long URLs sharing the same first 40 alphanumeric characters get mapped to the same ID. New posts get marked as already-seen and never alerted.
2. **monitor-v2 semantic-age filter hardcoded to 60 minutes** — ignores `POST_MAX_AGE_HOURS` env. If poll interval ever drifts past 60 min (cron skip, restart), every post is missed.
3. **Embedding cache key collision** — `text.slice(0, 100)` is used as cache key. Two posts with the same first 100 characters return the same vector, producing wrong semantic-similarity matches.
4. **Plan-limit race condition** — two concurrent `POST /v1/monitors` from the same key both pass the quota check before either writes. User can exceed plan limit by 1.
5. **No daily cost caps** — Anthropic Haiku, Groq, OpenAI embeddings, and Resend can all run away in cost if a bug or attacker spikes usage. Branch 2's per-key rate limit is the only ceiling.
6. **No hCaptcha on signup** — Branch 1's rate limit + email validation handles 80% of abuse, but a determined attacker rotating IPs can still mint keys. Deferred from Branch 2.

## Goals

1. Every fix has a unit test that proves the bug is gone.
2. No regressions to working behavior. Specifically: existing scrapers keep returning matches; `seenIds` for old IDs eventually expire (3-day Redis TTL) so collision-fixed IDs don't double-alert old posts.
3. Daily cost caps on Anthropic/Groq/Resend that fail gracefully (template fallback, log warning, drop alert) rather than crashing the worker.
4. hCaptcha integrates cleanly with the existing signup endpoint and is **soft-gated** — only kicks in after rate-limit threshold or for suspicious patterns, not for every signup.

## Non-goals

- The big monitor.js / monitor-v2.js dedup refactor (Branch 3c).
- Distribution drift cleanup — MCP versions, glama.json, INPUT_SCHEMA.json (Branch 3b).
- httpOnly-cookie migration for API keys (separate UX change).
- Anthropic-for-paid / Groq-for-free reply-draft swap (separate small task).
- Help-icon popovers and other UX polish (Branch 3b).

---

## Fixes

### F10 — Scraper ID hash collisions

**Files:** `lib/scrapers/fiverr.js:52`, `lib/scrapers/upwork.js:55`, `lib/scrapers/quora.js:38`

**Problem:** All three scrapers compute IDs as `href.replace(/[^a-z0-9]/gi,'_').slice(0, 40)`. Two distinct URLs sharing the first 40 alphanumeric characters produce identical IDs. Real Fiverr/Upwork/Quora forum URLs frequently share path prefixes like `/forum/topic-123-some-long-thread-title-...`, where the first 40 chars are the prefix-and-thread-id, not enough to distinguish two threads.

**Fix:** add `lib/scrapers/_id.js` with a single hash helper:

```js
import { createHash } from 'crypto'

// Stable 12-char ID derived from a URL. Use across all scrapers.
// 12 hex chars = 48 bits = 1-in-281-trillion collision space.
export function hashUrlToId(url, prefix = '') {
  const hash = createHash('sha1').update(String(url)).digest('hex').slice(0, 12)
  return prefix ? `${prefix}_${hash}` : hash
}
```

Update each scraper to call `hashUrlToId(url, 'fiverr')` (or `upwork`, `quora`) instead of the regex+slice pattern.

**Backwards compatibility:** old IDs in Redis (3-day TTL) will expire naturally. During the overlap window, a post that was previously alerted under an old ID may re-alert once under the new ID. This is acceptable — better one duplicate alert than continuing to miss real new posts indefinitely.

**Verification:** unit test with two URLs sharing 40-char prefix returns distinct IDs.

---

### F11 — monitor-v2 semantic-age filter hardcoded

**Files:** `monitor-v2.js` (find lines `60 * 60 * 1000` for the semantic-search age cutoff, around the `searchReddit` and embedding paths)

**Problem:** v1 (`monitor.js`) respects `POST_MAX_AGE_HOURS` env (default 3 hours). v2 hardcodes 60 minutes regardless of env. Users on slow polls or with cron drift miss every post.

**Fix:** at the top of `monitor-v2.js` next to other env reads:

```js
const POST_MAX_AGE_HOURS = parseInt(process.env.POST_MAX_AGE_HOURS || '3')
const POST_MAX_AGE_MS = POST_MAX_AGE_HOURS * 60 * 60 * 1000
```

Replace every `60 * 60 * 1000` literal in age-cutoff calculations with `POST_MAX_AGE_MS`. Audit the file with grep first to find all occurrences.

**Verification:** unit test that `POST_MAX_AGE_HOURS=24` env produces a 24h cutoff (not 1h).

---

### F12 — Embedding cache key collision

**Files:** `monitor-v2.js` (around line 126, the `getEmbedding` function with `embeddingCache`)

**Problem:** cache key is `text.slice(0, 100)`. Two posts whose first 100 characters match (e.g., posts that begin with the same boilerplate or quote) collide and return the wrong vector.

**Fix:** hash the full text:

```js
import { createHash } from 'crypto'

const cacheKey = createHash('sha1').update(text).digest('hex').slice(0, 16)
```

Replace the `text.slice(0, 100)` cache key with the hash. Cache size grows by ~16 bytes per entry vs ~100 — negligible. Also add a soft cap on cache size to prevent unbounded growth (LRU-ish: if cache.size > 5000, clear the oldest 1000 entries).

**Verification:** unit test that two different long texts with the same first 100 chars produce different cache keys.

---

### F13 — Plan-limit race condition

**Files:** `api-server.js` (the `POST /v1/monitors` handler, around lines 156-176)

**Problem:** the check-then-add pattern is not atomic. Two concurrent requests from the same API key both pass `existing.length < limit` before either does `sadd`. Quota bypass by 1.

**Fix:** flip to add-then-check-then-rollback pattern. Atomic in Redis without Lua:

```js
// Inside the handler, after the plan-limit fetch:
const monitorId = `mon_${randomBytes(8).toString('hex')}`
const wasAdded = await redis.sadd(`insights:owner:${auth.owner}:monitors`, monitorId)
if (!wasAdded) {
  // Already exists — shouldn't happen with a fresh ID, treat as server error
  return res.status(500).json({ success: false, error: { code: 'INTERNAL', message: 'monitor id collision' } })
}

const count = await redis.scard(`insights:owner:${auth.owner}:monitors`)
if (count > limits.monitors) {
  // Race lost — roll back
  await redis.srem(`insights:owner:${auth.owner}:monitors`, monitorId)
  return res.status(403).json({ success: false, error: { code: 'PLAN_LIMIT', message: `Plan allows ${limits.monitors} monitors. Upgrade or delete one.` } })
}

// Proceed with the rest of monitor creation
```

This pattern is "TOCTOU-safe" (time-of-check-to-time-of-use): the only window for inconsistency is between `sadd` and `scard`, and the rollback fixes that.

**Verification:** unit test that fires N concurrent requests against a starter-plan key (limit 3); confirm exactly 3 succeed and the rest get 403.

---

### F14 — Daily cost caps for Anthropic/Groq/OpenAI/Resend

**Files:**
- `lib/cost-cap.js` (new)
- `api-server.js` (wrap Anthropic call in `/v1/onboarding/suggest`)
- `monitor.js` (wrap Groq draft generation; gate Resend send)
- `monitor-v2.js` (same as monitor.js)
- Test: `test/cost-cap.test.js`

**Problem:** if a bug spikes usage (e.g., a poll cycle re-runs every minute due to cron misfire), there's no daily ceiling. A single bad day could cost $50+ on Anthropic or burn the entire Resend monthly free tier.

**Fix:** Redis-backed daily counter per resource. Same shape as the rate limiter from Branch 1 but scoped per-day not per-window.

```js
// lib/cost-cap.js
export function makeCostCap(redis, { resource, dailyMax }) {
  return async function check() {
    const day = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
    const key = `costcap:${resource}:${day}`
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, 60 * 60 * 26)  // 26h buffer
    return { allowed: count <= dailyMax, used: count, max: dailyMax }
  }
}
```

Default daily caps (configurable via env):
- `ANTHROPIC_DAILY_MAX` = 1000 calls (~$2.60/day worst case)
- `GROQ_DAILY_MAX` = 5000 calls (free tier; Groq has its own per-minute rate limit)
- `RESEND_DAILY_MAX` = 90 (free tier is 100/day, leave 10-buffer)
- `OPENAI_EMBEDDING_DAILY_MAX` = 10000 calls (~$0.05/day)

When a cap is hit:
- Anthropic suggest: fall through to template gallery (graceful — wizard still works)
- Groq draft: skip the draft (post still gets through, just no AI reply)
- Resend send: log warning, store match anyway (it'll be in the dashboard)
- OpenAI embedding: skip the semantic-search comparison for that post (keyword match still works)

In every case the user-visible product still works; only the AI/email layer degrades.

**Verification:** unit test that on N+1 calls (N = limit), the (N+1)th returns `allowed: false` and resource-specific fallback fires.

---

### F15 — hCaptcha on signup

**Files:**
- `lib/captcha.js` (new) — server-side hCaptcha verification helper
- `api-server.js` — call `verifyCaptcha` in signup handler IF rate-limit threshold approached
- `public/dashboard.html` — add hCaptcha widget to signup form, conditional on a flag from /v1/auth/signup-config endpoint
- `.env.example` — add `HCAPTCHA_SITE_KEY` (public, OK in client) and `HCAPTCHA_SECRET_KEY` (server only)

**Problem:** Branch 1 added 3 signups/IP/hour. Determined attackers rotate IPs. hCaptcha free tier ([hcaptcha.com](https://hcaptcha.com)) provides human verification at zero cost.

**Fix design:** **soft-gate** — only require captcha when:
- The IP has done ≥1 signup in the last hour, OR
- A `?captcha=force` query param is present (for testing)

Most legitimate signups never see the captcha. Only second+ attempts (or attackers retrying) get the friction. This avoids tanking conversion on the happy path.

```js
// lib/captcha.js
export async function verifyCaptcha(token) {
  const secret = process.env.HCAPTCHA_SECRET_KEY
  if (!secret) return { ok: true, skipped: true }  // disabled in dev
  if (!token) return { ok: false, error: 'no_token' }
  const r = await fetch('https://hcaptcha.com/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`,
  })
  const data = await r.json()
  return { ok: !!data.success, error: data['error-codes']?.join(',') }
}
```

In `/v1/auth/signup`:

```js
// After rate-limit check, before generating key:
const recentSignups = await redis.get(`signupcount:ip:${ip}`) || 0
if (Number(recentSignups) >= 1 || req.body?.forceCaptcha) {
  const cap = await verifyCaptcha(req.body?.captchaToken)
  if (!cap.ok) {
    return res.status(400).json({
      success: false,
      error: { code: 'CAPTCHA_REQUIRED', message: 'Please complete the captcha.' },
      requiresCaptcha: true,
      hcaptchaSiteKey: process.env.HCAPTCHA_SITE_KEY,
    })
  }
}
await redis.incr(`signupcount:ip:${ip}`)
await redis.expire(`signupcount:ip:${ip}`, 60 * 60)
```

Frontend (`public/dashboard.html`): on first signup attempt, no captcha. If response is 400 with `requiresCaptcha: true`, render hCaptcha widget using returned `hcaptchaSiteKey`, retry signup with `captchaToken` from widget.

**Verification:**
- Unit test: `verifyCaptcha('')` returns `{ ok: false }`; `verifyCaptcha('x')` with no secret returns `{ ok: true, skipped: true }`.
- Manual: first signup from a fresh IP works without captcha. Second signup from same IP within an hour requires captcha.

**Without setup:** if `HCAPTCHA_SITE_KEY` and `HCAPTCHA_SECRET_KEY` are unset (e.g., not yet configured on Railway), the helper returns `{ ok: true, skipped: true }` — zero behavior change. Soft fallback so this can ship before Olumide signs up for hCaptcha.

---

## Architecture changes

### New files

| File | Purpose |
|---|---|
| `lib/scrapers/_id.js` | Shared `hashUrlToId(url, prefix)` for stable scraper IDs (F10) |
| `lib/cost-cap.js` | Daily counter helper, gracefully fails when cap hit (F14) |
| `lib/captcha.js` | hCaptcha server-side verify, soft-fails if unconfigured (F15) |

### Modified files

| File | Changes |
|---|---|
| `lib/scrapers/fiverr.js` | Use `hashUrlToId` (F10) |
| `lib/scrapers/upwork.js` | Use `hashUrlToId` (F10) |
| `lib/scrapers/quora.js` | Use `hashUrlToId` (F10) |
| `monitor-v2.js` | Read `POST_MAX_AGE_HOURS` env (F11), hash-based embedding cache key + soft size cap (F12), wrap Groq + Resend calls with cost caps (F14) |
| `monitor.js` | Wrap Groq + Resend calls with cost caps (F14) |
| `api-server.js` | Race-safe monitor create (F13), Anthropic suggest cap in onboarding (F14), captcha integration in signup (F15) |
| `public/dashboard.html` | Conditional hCaptcha rendering on signup form (F15) |
| `.env.example` | Add `ANTHROPIC_DAILY_MAX`, `GROQ_DAILY_MAX`, `RESEND_DAILY_MAX`, `OPENAI_EMBEDDING_DAILY_MAX`, `HCAPTCHA_SITE_KEY`, `HCAPTCHA_SECRET_KEY` |

### Tests (new)

| Test | Coverage |
|---|---|
| `test/scraper-id.test.js` | F10: collision avoidance, stable hash |
| `test/monitor-v2-age-env.test.js` | F11: env-driven cutoff |
| `test/embedding-cache-key.test.js` | F12: collision avoidance |
| `test/plan-limit-race.test.js` | F13: concurrent requests get exactly N successes |
| `test/cost-cap.test.js` | F14: cap enforcement, fallback behavior |
| `test/captcha.test.js` | F15: verify helper, soft-skip when unconfigured |

---

## Rollout

1. Each fix is its own commit. PR contains all 6.
2. Unit tests run in CI (and in `npm test` locally).
3. Manual smoke after deploy: sign up, create monitor, verify Matches feed populates with no errors.
4. Watch Railway logs for 1 hour for any unexpected `costcap` cap-hit logs (should be rare with these defaults; if frequent, raise the env limits).

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| F10 ID change re-alerts an old post | Low | 3-day Redis TTL on `seen` keys means at most 3 days of duplicate alerts during transition. |
| F11 env-driven age cutoff exposes more old posts than expected | Low | Default stays at 3 hours; existing users keep current behavior unless they set the env. |
| F13 race-fix changes semantics for users at exactly the limit | Very low | Old behavior allowed +1 over; new behavior is exact. Users at limit see correct error. |
| F14 cost cap fires unexpectedly mid-day | Low | Defaults are generous (Anthropic 1000/day = ~$2.60). If anyone hits these legit, raise the env. |
| F15 hCaptcha breaks signup if widget fails to load | Low | Soft fallback if HCAPTCHA_SITE_KEY unset. Frontend has retry path. |

## Open questions

1. Are the default daily caps right? **Recommendation:** start conservative (these defaults), raise via env if real usage exceeds.
2. hCaptcha vs Cloudflare Turnstile? Both free. **Recommendation:** hCaptcha — it's the more recognizable widget; lower friction for users. Turnstile is a fine alternative if you already use Cloudflare.
3. Should F10 also apply to `monitor.js` / `monitor-v2.js` Reddit IDs? **No** — Reddit IDs are unique by definition (`p.id` is the post hash from Reddit). Only the scrapers that derive IDs from URLs are affected.

## Acceptance criteria

- [ ] `npm test` reports all tests passing (~73 tests = 63 from Branch 2 + 10-15 new).
- [ ] All 5 entry points still syntax-clean.
- [ ] Daily cost cap logs zero entries on a normal day's traffic.
- [ ] Concurrent `POST /v1/monitors` quota race produces 0 over-limit creations.
- [ ] hCaptcha widget appears only on second+ signup attempt from the same IP within an hour.
- [ ] If `HCAPTCHA_SITE_KEY` is unset, signup behaves identically to before this branch.

## Related work — what comes after 3a

- **Branch 3b (distribution cleanup):** MCP package version drift, `glama.json` tool list, `INPUT_SCHEMA.json` cleanup, `esbuild` removal, help-icon popovers. ~2 days.
- **Branch 3c (big refactors):** `monitor.js` / `monitor-v2.js` dedup, httpOnly-cookie API key migration. Separate spec needed; medium risk.
