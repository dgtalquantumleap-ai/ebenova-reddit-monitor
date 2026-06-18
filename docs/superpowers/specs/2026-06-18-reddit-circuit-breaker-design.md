# Reddit circuit-breaker + result cache + fan-out reduction

**Date:** 2026-06-18
**Status:** Approved — implementing
**Branch:** `feat/reddit-circuit-breaker` (stacked on `hotfix/monitor-log-noise`, PR #91)

## Problem

Production `[v2]` worker logs show Reddit `search.rss` returning **429 on
nearly every request** from Railway's datacenter IP. Each 429 pushes a global
30s cooldown ([lib/reddit-pacer.js](../../../lib/reddit-pacer.js)); with ~16
monitors × keywords × a 5-subreddit subreddit-intel fan-out, hundreds of
requests/cycle each hit a 30s cooldown and **a single poll cycle balloons to
~4 hours** (`POLL END: 14422.5s`) against a 10-minute interval. Monitors
effectively run every ~4h; many report consecutive zero-match cycles.

Root cause (verified June 2026): anonymous Reddit access is ~10 req/min per IP
and increasingly rejected. The no-OAuth approach has hit its ceiling. OAuth
(60–100 QPM) / a proxy is the real throughput fix and is tracked separately;
this spec makes the worker **fail fast and cut volume** so it stays usable in
the meantime.

## Goals

1. Stop a hot Reddit IP from stretching cycles to hours — cycle time back under
   the 10-min poll interval.
2. Keep non-Reddit platforms (HN, Medium, Substack, …) fully running when
   Reddit is throttled.
3. Reduce baseline Reddit request volume so 429s happen less often.
4. Be OAuth-ready: all thresholds env-tunable so OAuth simply loosens them.

Non-goals: OAuth/proxy implementation; changing classification/draft/email/
schema/Redis-key structure.

## Design

### 1. Circuit breaker (`lib/reddit-pacer.js`)
In-memory, process-singleton state (survives poll cycles; one Railway replica):
- `recordReddit429()` — increment a consecutive-429 counter; at
  `REDDIT_BREAKER_THRESHOLD` (default 5) open the breaker for
  `REDDIT_BREAKER_COOLDOWN_MS` (default 1_500_000 = 25 min) and reset the
  counter. Returns `true` only on the call that opens it (for one-time logging).
- `recordRedditSuccess()` — reset the counter (a clean 2xx means the IP
  recovered).
- `isRedditBreakerOpen()` / `breakerRemainingMs()` — read state.
- `_internals` extended (reset + getters/setter) for deterministic tests.

### 2. 15-minute result cache (`lib/reddit-cache.js`)
Redis-backed, factory pattern mirroring `lib/find-cache.js`:
- Key: `reddit:search:v1:<sha1(type|subreddit|keyword)>`.
- Stores the **parsed RSS entries** (pre-dedup) + `cachedAt`. TTL
  `REDDIT_SEARCH_CACHE_TTL_SEC` (default 900).
- `get(params)` → entries array or null; `set(params, entries)` → best-effort
  (swallows Redis errors, matching existing patterns).

### 3. `searchReddit` wiring (`monitor-v2.js`)
Per `(keyword, subreddit)` URL, in order:
1. **Cache get** → on hit, run the shared seen/age consumer and `continue`
   (no fetch, no pacer, no budget). Existing `seen:v2` dedup still applies, so
   nothing is double-emitted.
2. **Breaker open?** → skip the fetch (cache miss yields nothing this cycle);
   log once per call. Other platforms continue.
3. **Budget** → only real fetches decrement the per-monitor budget.
4. **Fetch** → on 429: existing `pushCooldown` + `recordReddit429()` (log when
   it opens). On 2xx: `recordRedditSuccess()`, `cache.set(entries)`, consume.

The parsed-entries→results loop is extracted into a shared `processEntries()`
so the live-fetch and cache-hit paths behave identically.

### 4. Fan-out 5 → 3
[monitor-v2.js](../../../monitor-v2.js) suggested-subreddits `slice(0, 5)` →
`slice(0, REDDIT_INTEL_FANOUT)` (default 3). Builder Tracker's curated 7-sub
list is unchanged — it's a paid feature and the breaker + budget already cap it.

## Config (env-tunable)
| Var | Default | Meaning |
|---|---|---|
| `REDDIT_BREAKER_THRESHOLD` | 5 | consecutive 429s before tripping |
| `REDDIT_BREAKER_COOLDOWN_MS` | 1500000 | breaker-open duration (25 min) |
| `REDDIT_INTEL_FANOUT` | 3 | dynamic subreddits per keyword |
| `REDDIT_SEARCH_CACHE_TTL_SEC` | 900 | search-result cache TTL (15 min) |

## Testing
- `lib/reddit-pacer.js`: extend `test/reddit-pacer.test.js` — trips at
  threshold, returns true only on opening, `recordRedditSuccess` resets,
  `isRedditBreakerOpen`/`breakerRemainingMs` behave, no re-trip while open.
- `lib/reddit-cache.js`: new `test/reddit-cache.test.js` with `createMockRedis`
  — set/get round-trip, miss → null, distinct params → distinct keys, null
  redis safe, non-array set is a no-op.
- `monitor-v2.js`: parse-checked (`node --check`); worker self-starts on import
  so it is never executed by the suite. Full suite stays green.

## Expected impact
Hot IP → 5×429 → Reddit paused 25 min → cycle bails Reddit in seconds and
finishes on other platforms → cycle time back under 10 min. Fan-out + cache cut
baseline volume so the breaker trips less. Reddit coverage is honestly reduced
until OAuth/proxy lands.

## Caveat
Breaker state is per-worker-process (single replica today). Scaling to multiple
monitor replicas makes it per-replica — acceptable, arguably better.
