import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { paceRedditRequest, pushCooldown, cooldownRemainingMs, _internals } from '../lib/reddit-pacer.js'

test('paceRedditRequest: first call returns immediately', async () => {
  _internals.reset()
  const t0 = Date.now()
  await paceRedditRequest(200)
  const elapsed = Date.now() - t0
  // First call has nothing to wait for — should be near-instant.
  assert.ok(elapsed < 50, `expected near-zero wait, got ${elapsed}ms`)
})

test('paceRedditRequest: enforces the default gap between consecutive calls', async () => {
  _internals.reset()
  await paceRedditRequest()            // no arg → DEFAULT_GAP_MS
  const t0 = Date.now()
  await paceRedditRequest()            // second call waits ~DEFAULT_GAP_MS + jitter
  const elapsed = Date.now() - t0
  const defaultGap = _internals.getDefaultGapMs()
  const jitter = _internals.getJitterMs()
  const maxWait = defaultGap + jitter + 500  // 500ms slack for slow runners
  assert.ok(elapsed >= defaultGap * 0.8, `expected ~default-gap wait, got ${elapsed}ms`)
  assert.ok(elapsed < maxWait, `expected wait ≤ ${maxWait}ms (gap+jitter+slack), got ${elapsed}ms`)
})

test('paceRedditRequest: honours a per-caller gapMs override below the default', async () => {
  _internals.reset()
  await paceRedditRequest(300)         // first call seeds _lastFetchAt (~0 wait)
  const t0 = Date.now()
  await paceRedditRequest(300)         // its OWN 300ms gap, well under the 1500ms default
  const elapsed = Date.now() - t0
  const defaultGap = _internals.getDefaultGapMs()
  // Proves the drain applies the caller's gap, not a fixed default. Under the
  // old "param ignored" behaviour this would wait ~defaultGap and fail the
  // upper bound. (The same mechanism lets dynamic subreddits request a WIDER
  // 3000ms gap — see searchReddit in monitor-v2.js.)
  assert.ok(elapsed >= 250, `expected ~300ms gap honoured, got ${elapsed}ms`)
  assert.ok(elapsed < defaultGap, `expected wait below the ${defaultGap}ms default, got ${elapsed}ms`)
})

test('paceRedditRequest: gapMs=0 disables pacing entirely', async () => {
  _internals.reset()
  await paceRedditRequest(0)
  const t0 = Date.now()
  await paceRedditRequest(0)
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 30, `expected near-zero wait when disabled, got ${elapsed}ms`)
})

test('paceRedditRequest: concurrent callers serialize via the shared timestamp', async () => {
  _internals.reset()
  const t0 = Date.now()
  // Three "monitors" race each other. The pacer doesn't lock, but the
  // last-write-wins on _lastFetchAt is enough — each call updates the
  // timestamp on completion, so the next caller picks it up.
  await Promise.all([
    paceRedditRequest(120),
    paceRedditRequest(120),
    paceRedditRequest(120),
  ])
  const elapsed = Date.now() - t0
  // First call: ~0ms. Second: depends on race. We just assert the suite
  // didn't bypass the pacer entirely (would be < 50ms with three concurrent
  // no-waits). 120ms minimum from the gap tells us at least one wait fired.
  assert.ok(elapsed >= 100, `expected at least one paced wait, got ${elapsed}ms`)
})

test('_internals exposes default gap and reset hook', () => {
  assert.equal(typeof _internals.getDefaultGapMs(), 'number')
  assert.equal(typeof _internals.reset, 'function')
  assert.equal(typeof _internals.getLastFetchAt, 'function')
})

// ── Adaptive 429 cooldown ─────────────────────────────────────────────────

test('pushCooldown: blocks paceRedditRequest until cooldown expires', async () => {
  _internals.reset()
  pushCooldown(200)
  const t0 = Date.now()
  await paceRedditRequest(0)  // gapMs=0 normally returns immediately, but cooldown still blocks
  const elapsed = Date.now() - t0
  assert.ok(elapsed >= 180, `expected wait ~200ms from cooldown, got ${elapsed}ms`)
  assert.ok(elapsed < 350, `expected wait close to 200ms, got ${elapsed}ms`)
})

test('pushCooldown: only extends forward, never backward', async () => {
  _internals.reset()
  pushCooldown(500)
  const after500 = _internals.getCooldownUntil()
  pushCooldown(100)  // smaller — should NOT shorten cooldown
  const afterSmaller = _internals.getCooldownUntil()
  assert.equal(after500, afterSmaller, 'smaller cooldown must not move the target backward')
  pushCooldown(800)  // larger — should extend
  assert.ok(_internals.getCooldownUntil() > after500, 'larger cooldown must extend the target')
})

test('pushCooldown: clamped to COOLDOWN_MAX_MS so a runaway value cannot halt the worker', async () => {
  _internals.reset()
  const t0 = Date.now()
  pushCooldown(10 * 60 * 60 * 1000)  // 10 hours — must clamp
  const target = _internals.getCooldownUntil()
  const span = target - t0
  assert.ok(span <= _internals.getCooldownMaxMs() + 50, `expected cooldown ≤ COOLDOWN_MAX_MS, got ${span}ms`)
})

test('pushCooldown: ignores non-finite and non-positive values', () => {
  _internals.reset()
  pushCooldown(NaN); assert.equal(_internals.getCooldownUntil(), 0)
  pushCooldown(0);   assert.equal(_internals.getCooldownUntil(), 0)
  pushCooldown(-100);assert.equal(_internals.getCooldownUntil(), 0)
})

test('cooldownRemainingMs: reflects active cooldown and returns 0 when expired', async () => {
  _internals.reset()
  pushCooldown(150)
  assert.ok(cooldownRemainingMs() > 0, 'should be positive while active')
  await new Promise(r => setTimeout(r, 200))
  assert.equal(cooldownRemainingMs(), 0, 'should be 0 after expiry')
})

test('paceRedditRequest: adds jitter on top of base gap', async () => {
  _internals.reset()
  // First call sets _lastFetchAt
  await paceRedditRequest(100)
  // Subsequent waits should include jitter (0-JITTER_MS), so observed mean
  // should be > the pure gap. Run 5 to dampen variance.
  const waits = []
  for (let i = 0; i < 5; i++) {
    const t = Date.now()
    await paceRedditRequest(100)
    waits.push(Date.now() - t)
  }
  const mean = waits.reduce((a, b) => a + b, 0) / waits.length
  assert.ok(mean > 100, `jitter should push mean above pure gap; got mean ${mean}ms`)
})
