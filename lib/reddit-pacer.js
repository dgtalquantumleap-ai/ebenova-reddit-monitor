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

// Module-level state — single shared timestamp across all callers in this
// process. Tests reset via _internals.reset().
let _lastFetchAt = 0

/**
 * Block until at least `gapMs` has elapsed since the previous call.
 * Concurrency-safe enough for our needs: even if two callers race to read
 * `_lastFetchAt`, both will wait, then both update — second update bumps
 * the timestamp, third caller sees a longer wait, system self-corrects.
 *
 * @param {number} [gapMs] override the default min-gap (otherwise reads env)
 * @returns {Promise<void>}
 */
export async function paceRedditRequest(gapMs = DEFAULT_GAP_MS) {
  if (gapMs <= 0) return
  const now = Date.now()
  const elapsed = now - _lastFetchAt
  if (elapsed < gapMs) {
    await new Promise(r => setTimeout(r, gapMs - elapsed))
  }
  _lastFetchAt = Date.now()
}

// Test-only helpers.
export const _internals = {
  reset: () => { _lastFetchAt = 0 },
  getLastFetchAt: () => _lastFetchAt,
  getDefaultGapMs: () => DEFAULT_GAP_MS,
}
