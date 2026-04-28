import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  getRedditAccessToken,
  isRedditAuthConfigured,
  redditOAuthHost,
  redditPublicHost,
  redditUserAgent,
  invalidateRedditToken,
  _resetForTests,
} from '../lib/reddit-auth.js'

function withEnv(vars, fn) {
  const previous = {}
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k]
    if (v === null || v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

test('isRedditAuthConfigured: false when either var missing', () => {
  return withEnv({ REDDIT_CLIENT_ID: null, REDDIT_CLIENT_SECRET: null }, async () => {
    assert.equal(isRedditAuthConfigured(), false)
  }).then(() =>
    withEnv({ REDDIT_CLIENT_ID: 'abc', REDDIT_CLIENT_SECRET: null }, async () => {
      assert.equal(isRedditAuthConfigured(), false)
    })
  ).then(() =>
    withEnv({ REDDIT_CLIENT_ID: null, REDDIT_CLIENT_SECRET: 'xyz' }, async () => {
      assert.equal(isRedditAuthConfigured(), false)
    })
  )
})

test('isRedditAuthConfigured: true when both vars present', () =>
  withEnv({ REDDIT_CLIENT_ID: 'abc', REDDIT_CLIENT_SECRET: 'xyz' }, async () => {
    assert.equal(isRedditAuthConfigured(), true)
  })
)

test('redditOAuthHost / redditPublicHost: distinct hostnames', () => {
  assert.notEqual(redditOAuthHost(), redditPublicHost())
  assert.ok(redditOAuthHost().includes('oauth.reddit.com'))
  assert.ok(redditPublicHost().includes('www.reddit.com'))
})

test('redditUserAgent: env override wins', () =>
  withEnv({ REDDIT_USER_AGENT: 'custom/1.0 (/u/me)' }, async () => {
    assert.equal(redditUserAgent(), 'custom/1.0 (/u/me)')
  })
)

test('redditUserAgent: sensible default when env missing', () =>
  withEnv({ REDDIT_USER_AGENT: null }, async () => {
    const ua = redditUserAgent()
    assert.ok(ua.length > 0)
    assert.ok(/\bEbenovaBot\b|\bMozilla\b/.test(ua))
  })
)

test('getRedditAccessToken throws when creds missing', () => {
  _resetForTests()
  return withEnv({ REDDIT_CLIENT_ID: null, REDDIT_CLIENT_SECRET: null }, async () => {
    await assert.rejects(
      () => getRedditAccessToken(),
      /REDDIT_CLIENT_ID.*REDDIT_CLIENT_SECRET/
    )
  })
})

test('getRedditAccessToken: fetches token, caches, reuses without re-fetch', () => {
  _resetForTests()
  return withEnv({ REDDIT_CLIENT_ID: 'id1', REDDIT_CLIENT_SECRET: 'sec1' }, async () => {
    const originalFetch = global.fetch
    let calls = 0
    global.fetch = async (url, opts) => {
      calls++
      assert.equal(url, 'https://www.reddit.com/api/v1/access_token')
      assert.ok(opts.headers['Authorization'].startsWith('Basic '))
      assert.equal(opts.body, 'grant_type=client_credentials')
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: 'tok-123', expires_in: 3600, token_type: 'bearer' }),
      }
    }
    try {
      const r1 = await getRedditAccessToken()
      const r2 = await getRedditAccessToken()
      assert.equal(r1.token, 'tok-123')
      assert.equal(r2.token, 'tok-123')
      assert.equal(calls, 1)            // second call hits cache
    } finally {
      global.fetch = originalFetch
      _resetForTests()
    }
  })
})

test('getRedditAccessToken: refresh after invalidate', () => {
  _resetForTests()
  return withEnv({ REDDIT_CLIENT_ID: 'id1', REDDIT_CLIENT_SECRET: 'sec1' }, async () => {
    const originalFetch = global.fetch
    let calls = 0
    global.fetch = async () => {
      calls++
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: `tok-${calls}`, expires_in: 3600, token_type: 'bearer' }),
      }
    }
    try {
      const r1 = await getRedditAccessToken()
      assert.equal(r1.token, 'tok-1')
      invalidateRedditToken()
      const r2 = await getRedditAccessToken()
      assert.equal(r2.token, 'tok-2')
      assert.equal(calls, 2)
    } finally {
      global.fetch = originalFetch
      _resetForTests()
    }
  })
})

test('getRedditAccessToken: surfaces non-200 with status code', () => {
  _resetForTests()
  return withEnv({ REDDIT_CLIENT_ID: 'id1', REDDIT_CLIENT_SECRET: 'sec1' }, async () => {
    const originalFetch = global.fetch
    global.fetch = async () => ({
      ok: false, status: 401,
      text: async () => '{"error":"invalid_grant"}',
    })
    try {
      await assert.rejects(() => getRedditAccessToken(), /Reddit token fetch 401/)
    } finally {
      global.fetch = originalFetch
      _resetForTests()
    }
  })
})

test('getRedditAccessToken: rejects when response has no access_token', () => {
  _resetForTests()
  return withEnv({ REDDIT_CLIENT_ID: 'id1', REDDIT_CLIENT_SECRET: 'sec1' }, async () => {
    const originalFetch = global.fetch
    global.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ error: 'nope' }),  // missing access_token
    })
    try {
      await assert.rejects(() => getRedditAccessToken(), /missing access_token/)
    } finally {
      global.fetch = originalFetch
      _resetForTests()
    }
  })
})

test('getRedditAccessToken: defaults expires_in to 3600 if missing', () => {
  _resetForTests()
  return withEnv({ REDDIT_CLIENT_ID: 'id1', REDDIT_CLIENT_SECRET: 'sec1' }, async () => {
    const originalFetch = global.fetch
    global.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ access_token: 'tok-x', token_type: 'bearer' }),  // no expires_in
    })
    try {
      const r = await getRedditAccessToken()
      assert.ok(r.expiresAt > Date.now() + 30 * 60 * 1000)  // at least 30 min
      assert.ok(r.expiresAt < Date.now() + 65 * 60 * 1000)  // not absurdly long
    } finally {
      global.fetch = originalFetch
      _resetForTests()
    }
  })
})

test('getRedditAccessToken: concurrent callers share one in-flight refresh', () => {
  _resetForTests()
  return withEnv({ REDDIT_CLIENT_ID: 'id1', REDDIT_CLIENT_SECRET: 'sec1' }, async () => {
    const originalFetch = global.fetch
    let calls = 0
    global.fetch = async () => {
      calls++
      // Simulate slow-ish network so multiple calls can race
      await new Promise(r => setTimeout(r, 30))
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: 'tok-shared', expires_in: 3600, token_type: 'bearer' }),
      }
    }
    try {
      const [a, b, c] = await Promise.all([
        getRedditAccessToken(),
        getRedditAccessToken(),
        getRedditAccessToken(),
      ])
      assert.equal(a.token, 'tok-shared')
      assert.equal(b.token, 'tok-shared')
      assert.equal(c.token, 'tok-shared')
      assert.equal(calls, 1, 'expected exactly one fetch despite 3 concurrent callers')
    } finally {
      global.fetch = originalFetch
      _resetForTests()
    }
  })
})
