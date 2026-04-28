import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { makeCorsMiddleware } from '../lib/cors.js'

function fakeReqRes(origin, method = 'GET') {
  let status = 200, headers = {}, ended = false, nextCalled = false
  return {
    req: { headers: { origin }, method },
    res: {
      setHeader(k, v) { headers[k] = v },
      status(s) { status = s; return this },
      end() { ended = true; return this },
    },
    next: () => { nextCalled = true },
    get headers() { return headers },
    get status() { return status },
    get ended() { return ended },
    get nextCalled() { return nextCalled },
  }
}

test('allows origin in allowlist', () => {
  const cors = makeCorsMiddleware(['https://ebenova.dev'])
  const t = fakeReqRes('https://ebenova.dev')
  cors(t.req, t.res, t.next)
  assert.equal(t.headers['Access-Control-Allow-Origin'], 'https://ebenova.dev')
  assert.equal(t.nextCalled, true)
})

test('does not echo origin not in allowlist', () => {
  const cors = makeCorsMiddleware(['https://ebenova.dev'])
  const t = fakeReqRes('https://attacker.example')
  cors(t.req, t.res, t.next)
  assert.equal(t.headers['Access-Control-Allow-Origin'], undefined)
  assert.equal(t.nextCalled, true, 'request still proceeds — browser enforces CORS')
})

test('OPTIONS preflight returns 204 with allowlist origin', () => {
  const cors = makeCorsMiddleware(['https://ebenova.dev'])
  const t = fakeReqRes('https://ebenova.dev', 'OPTIONS')
  cors(t.req, t.res, t.next)
  assert.equal(t.status, 204)
  assert.equal(t.ended, true)
  assert.equal(t.nextCalled, false)
})

test('Vary: Origin header always set', () => {
  const cors = makeCorsMiddleware(['https://ebenova.dev'])
  const t = fakeReqRes('https://attacker.example')
  cors(t.req, t.res, t.next)
  assert.equal(t.headers['Vary'], 'Origin')
})
