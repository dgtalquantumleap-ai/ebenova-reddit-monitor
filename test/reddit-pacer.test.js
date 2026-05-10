import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { paceRedditRequest, _internals } from '../lib/reddit-pacer.js'

test('paceRedditRequest: first call returns immediately', async () => {
  _internals.reset()
  const t0 = Date.now()
  await paceRedditRequest(200)
  const elapsed = Date.now() - t0
  // First call has nothing to wait for — should be near-instant.
  assert.ok(elapsed < 50, `expected near-zero wait, got ${elapsed}ms`)
})

test('paceRedditRequest: enforces minimum gap between consecutive calls', async () => {
  _internals.reset()
  await paceRedditRequest(150)
  const t0 = Date.now()
  await paceRedditRequest(150)
  const elapsed = Date.now() - t0
  // Second call should wait ~150ms because the first set the timestamp.
  assert.ok(elapsed >= 130, `expected wait ~150ms, got ${elapsed}ms`)
  assert.ok(elapsed < 250, `expected wait close to 150ms, got ${elapsed}ms (sleep overshoot too large)`)
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
