// lib/reddit-pacer.js — global IP-level pacer for Reddit RSS fetches.
//
// Why this exists: monitor-v2 runs MONITOR_CONCURRENCY monitors in parallel,
// and each monitor's searchReddit() loop applies its OWN per-monitor
// interDelay (2.5–4s). But Reddit rate-limits the *outbound IP*, not the
// caller — so when two monitors are doing reddit work simultaneously, the
// IP sees ~2× the per-monitor rate and bursts past Reddit's anonymous
// ceiling. Production logs from May 9 show exactly this: dozens of 429s
// on the Builder Tracker monitor's 7-subreddit fan-out whenever it ran
// concurrently with another reddit-using monitor.
//
// Fix: every reddit.com fetch awaits this pacer, which sleeps as needed to
// guarantee at least REDDIT_GLOBAL_MIN_GAP_MS (default 1500ms) between
// reddit requests *across all monitors in this process*. With concurrency=2
// each monitor still respects its own pacing; this just adds a cross-monitor
// floor so the IP never fires more than ~40 RPM regardless of how many
// monitors are running. Reddit's anonymous IP limit appears to be ~60-100
// RPM, leaving comfortable headroom.
//
// Tunable via REDDIT_GLOBAL_MIN_GAP_MS env var. Set to 0 to disable.

const DEFAULT_GAP_MS = parseInt(process.env.REDDIT_GLOBAL_MIN_GAP_MS || '1500')
// Random jitter added to every paced wait. Prevents synchronized bursts
// when multiple monitors race to issue their next request at the same
// rounded-up timestamp.
const JITTER_MS = parseInt(process.env.REDDIT_GLOBAL_JITTER_MS || '300')
// Hard ceiling for the adaptive cooldown — even if Reddit's Retry-After
// header says "wait 30 minutes," we don't want to halt the worker.
const COOLDOWN_MAX_MS = parseInt(process.env.REDDIT_GLOBAL_COOLDOWN_MAX_MS || '120000')

// Module-level state — single shared timestamps across all callers in this
// process. Tests reset via _internals.reset().
let _lastFetchAt   = 0
let _cooldownUntil = 0
// Queue of pending paceRedditRequest callers. Each entry is { resolve, gapMs }
// so the drain can honour per-caller gap overrides (e.g. dynamic subreddits
// request 3000ms instead of the default 1500ms). Guarantees serial dispatch.
let _queue = []
let _draining = false

async function _drain() {
  if (_draining) return
  _draining = true
  while (_queue.length > 0) {
    const { resolve, gapMs } = _queue.shift()
    const effectiveGap = gapMs > 0 ? gapMs : DEFAULT_GAP_MS
    const now = Date.now()
    const jitter = JITTER_MS > 0 ? Math.floor(Math.random() * JITTER_MS) : 0
    const earliestNext = Math.max(_lastFetchAt + effectiveGap + jitter, _cooldownUntil)
    if (earliestNext > now) {
      await new Promise(r => setTimeout(r, earliestNext - now))
    }
    _lastFetchAt = Date.now()
    resolve()
  }
  _draining = false
}

/**
 * Block until at least `gapMs` has elapsed since the previous call AND
 * any active 429-cooldown has expired.
 *
 * Uses a serial queue so concurrent callers are dispatched one at a time,
 * each waiting a full gap after the previous. This prevents two monitors
 * running in parallel from both reading the same _lastFetchAt and both
 * firing at the same time.
 *
 * @param {number} [gapMs] minimum gap this caller needs before its turn fires.
 *   Defaults to DEFAULT_GAP_MS. Honoured per-caller by the drain, so a riskier
 *   request (e.g. dynamic subreddits) can ask for a wider gap than the default.
 *   A value <= 0 skips pacing entirely (unless a 429 cooldown is active).
 * @returns {Promise<void>}
 */
export function paceRedditRequest(gapMs = DEFAULT_GAP_MS) {
  if (gapMs <= 0 && _cooldownUntil <= Date.now()) return Promise.resolve()
  return new Promise(resolve => {
    _queue.push({ resolve, gapMs })
    _drain()
  })
}

/**
 * Push the global cooldown forward by `ms` (or to `now + ms`, whichever
 * is later). Called by 429 handlers to halt the entire IP for a while
 * instead of continuing to hammer Reddit with the same RPM.
 *
 * Clamped to COOLDOWN_MAX_MS so a bogus Retry-After can't take us down.
 *
 * @param {number} ms — typically (Retry-After header * 1000) or a default
 */
export function pushCooldown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return
  const capped = Math.min(ms, COOLDOWN_MAX_MS)
  const target = Date.now() + capped
  if (target > _cooldownUntil) _cooldownUntil = target
}

/**
 * Cooldown remaining in ms (0 if not active). Useful for logging.
 */
export function cooldownRemainingMs() {
  const r = _cooldownUntil - Date.now()
  return r > 0 ? r : 0
}

// ── Circuit breaker ────────────────────────────────────────────────────────
// When Reddit throttles the outbound IP, every request 429s. Grinding through a
// 30s cooldown per request stretches a poll cycle to hours. Instead, after
// BREAKER_THRESHOLD consecutive 429s, OPEN the breaker for BREAKER_COOLDOWN_MS
// and let callers skip Reddit entirely until it closes — surviving across poll
// cycles (this module is a process singleton) so the next cycle doesn't
// re-hammer the still-hot IP. Other platforms are unaffected; only Reddit
// fetches consult the breaker. Env-tunable so an OAuth upgrade can loosen them.
const BREAKER_THRESHOLD   = parseInt(process.env.REDDIT_BREAKER_THRESHOLD || '5')
const BREAKER_COOLDOWN_MS = parseInt(process.env.REDDIT_BREAKER_COOLDOWN_MS || '1500000') // 25 min

let _consecutive429   = 0
let _breakerOpenUntil = 0

/**
 * Record a Reddit 429. Opens the breaker once the consecutive-429 count reaches
 * BREAKER_THRESHOLD (and it isn't already open).
 * @returns {boolean} true ONLY on the call that opens the breaker — lets the
 *   caller log the open event once instead of on every 429 in the burst.
 */
export function recordReddit429() {
  if (Date.now() < _breakerOpenUntil) return false  // already open — don't re-trip or extend
  _consecutive429++
  if (_consecutive429 >= BREAKER_THRESHOLD) {
    _breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS
    _consecutive429 = 0
    return true
  }
  return false
}

/** Record a successful Reddit fetch — resets the consecutive-429 streak. */
export function recordRedditSuccess() {
  _consecutive429 = 0
}

/** True while the breaker is open (callers should skip Reddit fetches). */
export function isRedditBreakerOpen() {
  return Date.now() < _breakerOpenUntil
}

/** Breaker-open time remaining in ms (0 when closed). For logging. */
export function breakerRemainingMs() {
  const r = _breakerOpenUntil - Date.now()
  return r > 0 ? r : 0
}

// Test-only helpers.
export const _internals = {
  reset: () => { _lastFetchAt = 0; _cooldownUntil = 0; _queue = []; _draining = false; _consecutive429 = 0; _breakerOpenUntil = 0; },
  getQueueLength: () => _queue.length,
  getLastFetchAt:    () => _lastFetchAt,
  getCooldownUntil:  () => _cooldownUntil,
  getDefaultGapMs:   () => DEFAULT_GAP_MS,
  getJitterMs:       () => JITTER_MS,
  getCooldownMaxMs:  () => COOLDOWN_MAX_MS,
  getConsecutive429:   () => _consecutive429,
  getBreakerOpenUntil: () => _breakerOpenUntil,
  setBreakerOpenUntil: (v) => { _breakerOpenUntil = v },
  getBreakerThreshold: () => BREAKER_THRESHOLD,
}
