import { test } from 'node:test'
import { strict as assert } from 'node:assert'

// We test the isPolling pattern directly rather than importing all of monitor-v2.js
// (which has top-level side effects). The pattern under test is small and
// trivially extracted — the same pattern is applied to monitor-v2.js's poll().

function makeGuardedPoll(asyncBody) {
  let isPolling = false
  return async function poll() {
    if (isPolling) return { skipped: true }
    isPolling = true
    try {
      return await asyncBody()
    } finally {
      isPolling = false
    }
  }
}

test('first call to poll() runs the body', async () => {
  let ran = 0
  const poll = makeGuardedPoll(async () => { ran++ ; return { ran } })
  const r = await poll()
  assert.equal(r.ran, 1)
})

test('concurrent second call short-circuits', async () => {
  let started = 0
  let release
  const block = new Promise(r => { release = r })
  const poll = makeGuardedPoll(async () => { started++ ; await block ; return { started } })
  const p1 = poll()
  const p2 = poll()
  // Give microtasks a chance
  await new Promise(r => setImmediate(r))
  assert.equal(started, 1)  // body only ran once
  release()
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.started, 1)
  assert.equal(r2.skipped, true)
})

test('after first call finishes, next call runs again', async () => {
  let ran = 0
  const poll = makeGuardedPoll(async () => { ran++ })
  await poll()
  await poll()
  assert.equal(ran, 2)
})

test('isPolling resets even if body throws', async () => {
  let ran = 0
  const poll = makeGuardedPoll(async () => { ran++ ; throw new Error('boom') })
  await poll().catch(() => {})
  await poll().catch(() => {})
  assert.equal(ran, 2)  // second call ran because flag was reset in finally
})
