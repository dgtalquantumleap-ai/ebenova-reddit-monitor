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

/**
 * Block until at least `gapMs` has elapsed since the previous call AND
 * any active 429-cooldown has expired.
 *
 * Concurrency-safe enough for our needs: even if two callers race to read
 * `_lastFetchAt`, both will wait, then both update — second update bumps
 * the timestamp, third caller sees a longer wait, system self-corrects.
 *
 * @param {number} [gapMs] override the default min-gap (otherwise reads env)
 * @returns {Promise<void>}
 */
export async function paceRedditRequest(gapMs = DEFAULT_GAP_MS) {
  if (gapMs <= 0 && _cooldownUntil <= Date.now()) return
  const now = Date.now()
  // Add small jitter so parallel monitors don't sync up onto the same beat.
  const jitter = JITTER_MS > 0 ? Math.floor(Math.random() * JITTER_MS) : 0
  const earliestNext = Math.max(_lastFetchAt + gapMs + jitter, _cooldownUntil)
  if (earliestNext > now) {
    await new Promise(r => setTimeout(r, earliestNext - now))
  }
  _lastFetchAt = Date.now()
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

// Test-only helpers.
export const _internals = {
  reset: () => { _lastFetchAt = 0; _cooldownUntil = 0 },
  getLastFetchAt:    () => _lastFetchAt,
  getCooldownUntil:  () => _cooldownUntil,
  getDefaultGapMs:   () => DEFAULT_GAP_MS,
  getJitterMs:       () => JITTER_MS,
  getCooldownMaxMs:  () => COOLDOWN_MAX_MS,
}
