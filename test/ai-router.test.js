import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { routeAIWithProviders, _internals, DEFAULT_PROVIDERS } from '../lib/ai-router.js'

const { TASK_ROUTING, FALLBACK_CHAIN, TASK_FALLBACK_OVERRIDES, buildTryOrder } = _internals

// ── Routing table sanity ───────────────────────────────────────────────────

test('TASK_ROUTING has the 8 spec\'d tasks mapped to a known provider key', () => {
  const expected = [
    'classify_match', 'generate_reply_draft',
    'weekly_pattern_summary', 'generate_icp', 'competitor_threat_summary',
    'generate_client_report', 'check_ai_visibility', 'generate_onboarding_keywords',
  ]
  for (const t of expected) {
    assert.ok(TASK_ROUTING[t], `missing routing for ${t}`)
    assert.ok(['GROQ_FAST', 'GROQ_QUALITY', 'DEEPSEEK', 'CLAUDE'].includes(TASK_ROUTING[t]),
      `${t} → ${TASK_ROUTING[t]} is not a known provider key`)
  }
})

test('per-spec routing assignments', () => {
  // Spec-locked: changing these is a behavior change, not a refactor.
  assert.equal(TASK_ROUTING.classify_match,               'GROQ_FAST')
  assert.equal(TASK_ROUTING.extract_builder_topics,       'GROQ_QUALITY')
  assert.equal(TASK_ROUTING.generate_reply_draft,         'DEEPSEEK')
  assert.equal(TASK_ROUTING.generate_premium_reply,       'CLAUDE')
  assert.equal(TASK_ROUTING.weekly_pattern_summary,       'DEEPSEEK')
  assert.equal(TASK_ROUTING.weekly_intelligence_briefing, 'DEEPSEEK')
  assert.equal(TASK_ROUTING.generate_icp,                 'DEEPSEEK')
  assert.equal(TASK_ROUTING.competitor_threat_summary,    'DEEPSEEK')
  assert.equal(TASK_ROUTING.generate_client_report,       'CLAUDE')
  assert.equal(TASK_ROUTING.check_ai_visibility,          'CLAUDE')
  assert.equal(TASK_ROUTING.generate_onboarding_keywords, 'CLAUDE')
})

test('FALLBACK_CHAIN is GROQ_QUALITY → GROQ_FAST → DEEPSEEK', () => {
  assert.deepEqual(FALLBACK_CHAIN, ['GROQ_QUALITY', 'GROQ_FAST', 'DEEPSEEK'])
})

test('buildTryOrder: preferred=DEEPSEEK → DEEPSEEK, GROQ_QUALITY, GROQ_FAST', () => {
  assert.deepEqual(buildTryOrder('DEEPSEEK'), ['DEEPSEEK', 'GROQ_QUALITY', 'GROQ_FAST'])
})

test('buildTryOrder: preferred=GROQ_QUALITY does not duplicate', () => {
  assert.deepEqual(buildTryOrder('GROQ_QUALITY'), ['GROQ_QUALITY', 'GROQ_FAST', 'DEEPSEEK'])
})

test('buildTryOrder: preferred=GROQ_FAST does not duplicate', () => {
  assert.deepEqual(buildTryOrder('GROQ_FAST'), ['GROQ_FAST', 'GROQ_QUALITY', 'DEEPSEEK'])
})

test('extract_builder_topics fallback override excludes GROQ_FAST', () => {
  const override = TASK_FALLBACK_OVERRIDES.extract_builder_topics
  assert.ok(Array.isArray(override), 'override must exist')
  assert.ok(!override.includes('GROQ_FAST'), 'GROQ_FAST must not appear in fallback')
  assert.deepEqual(buildTryOrder('GROQ_QUALITY', override), ['GROQ_QUALITY', 'DEEPSEEK'])
})

test('extract_builder_topics routes to GROQ_QUALITY and falls back to DEEPSEEK, never GROQ_FAST', async () => {
  const { catalog, calls } = mockProviders({ GROQ_QUALITY: 'throw' })
  const r = await routeAIWithProviders(catalog, { task: 'extract_builder_topics', prompt: 'x' })
  assert.equal(r.ok, true)
  assert.equal(r.providerKey, 'DEEPSEEK')
  assert.ok(!calls.some(c => c.provider === 'groq-fast'), 'groq-fast must not be called')
})

// ── Mock provider helpers ──────────────────────────────────────────────────

function mockProviders(overrides = {}) {
  const calls = []
  const make = (name, behavior = 'ok') => ({
    name,
    model: name,
    available: () => true,
    call: async (args) => {
      calls.push({ provider: name, args })
      if (typeof behavior === 'function') return behavior(args)
      if (behavior === 'ok')      return `OK from ${name}`
      if (behavior === 'throw')   throw new Error(`${name} blew up`)
      if (behavior === 'unavail') throw new Error('should not be called')
      return behavior
    },
  })
  return {
    catalog: {
      GROQ_FAST:    make('groq-fast',    overrides.GROQ_FAST),
      GROQ_QUALITY: make('groq-quality', overrides.GROQ_QUALITY),
      DEEPSEEK:     make('deepseek',     overrides.DEEPSEEK),
      CLAUDE:       make('claude',       overrides.CLAUDE),
    },
    calls,
  }
}

// ── routeAIWithProviders behavior ──────────────────────────────────────────

test('rejects unknown task name', async () => {
  const { catalog } = mockProviders()
  const r = await routeAIWithProviders(catalog, { task: 'not_a_real_task', prompt: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.error, /unknown task/)
  assert.equal(r.attempts.length, 0)
})

test('routes to preferred provider on success', async () => {
  const { catalog, calls } = mockProviders()
  const r = await routeAIWithProviders(catalog, { task: 'classify_match', prompt: 'hello' })
  assert.equal(r.ok, true)
  assert.equal(r.providerKey, 'GROQ_FAST')
  assert.equal(r.text, 'OK from groq-fast')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'groq-fast')
  assert.equal(calls[0].args.prompt, 'hello')
})

test('falls back to GROQ_QUALITY when preferred fails', async () => {
  const { catalog, calls } = mockProviders({ DEEPSEEK: 'throw' })
  const r = await routeAIWithProviders(catalog, { task: 'weekly_pattern_summary', prompt: 'x' })
  assert.equal(r.ok, true)
  assert.equal(r.providerKey, 'GROQ_QUALITY')
  assert.equal(r.text, 'OK from groq-quality')
  assert.deepEqual(calls.map(c => c.provider), ['deepseek', 'groq-quality'])
  assert.equal(r.attempts[0].status, 'error')
  assert.equal(r.attempts[1].status, 'ok')
})

test('falls back further to GROQ_FAST when GROQ_QUALITY also fails', async () => {
  const { catalog, calls } = mockProviders({ DEEPSEEK: 'throw', GROQ_QUALITY: 'throw' })
  const r = await routeAIWithProviders(catalog, { task: 'generate_icp', prompt: 'x' })
  assert.equal(r.ok, true)
  assert.equal(r.providerKey, 'GROQ_FAST')
  assert.deepEqual(calls.map(c => c.provider), ['deepseek', 'groq-quality', 'groq-fast'])
})

test('returns ok:false when all providers fail', async () => {
  const { catalog } = mockProviders({ DEEPSEEK: 'throw', GROQ_QUALITY: 'throw', GROQ_FAST: 'throw' })
  const r = await routeAIWithProviders(catalog, { task: 'weekly_pattern_summary', prompt: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.error, /all providers failed/)
  assert.equal(r.attempts.length, 3)
  for (const a of r.attempts) assert.equal(a.status, 'error')
})

test('skips providers reporting unavailable (no API key)', async () => {
  const { catalog, calls } = mockProviders()
  catalog.DEEPSEEK.available = () => false
  const r = await routeAIWithProviders(catalog, { task: 'weekly_pattern_summary', prompt: 'x' })
  assert.equal(r.ok, true)
  assert.equal(r.providerKey, 'GROQ_QUALITY')
  assert.deepEqual(calls.map(c => c.provider), ['groq-quality'])
  assert.equal(r.attempts[0].status, 'unavailable')
})

test('respects costCap per provider — caps preferred, falls back to next', async () => {
  const { catalog, calls } = mockProviders()
  const costCap = async (providerKey) => {
    if (providerKey === 'DEEPSEEK') return { allowed: false, used: 100, max: 100 }
    return { allowed: true }
  }
  const r = await routeAIWithProviders(catalog, { task: 'competitor_threat_summary', prompt: 'x', costCap })
  assert.equal(r.ok, true)
  assert.equal(r.providerKey, 'GROQ_QUALITY')
  assert.deepEqual(calls.map(c => c.provider), ['groq-quality'])
  assert.equal(r.attempts[0].status, 'cost-cap')
  assert.equal(r.attempts[0].detail, '100/100')
})

test('costCap that throws does not block — provider still attempted', async () => {
  const { catalog, calls } = mockProviders()
  const costCap = async () => { throw new Error('redis unavailable') }
  const r = await routeAIWithProviders(catalog, { task: 'classify_match', prompt: 'x', costCap })
  assert.equal(r.ok, true)
  assert.equal(r.providerKey, 'GROQ_FAST')
  assert.equal(calls.length, 1)
})

test('forwards system / maxTokens / temperature / jsonMode to the provider call', async () => {
  const { catalog, calls } = mockProviders()
  const r = await routeAIWithProviders(catalog, {
    task: 'classify_match',
    prompt: 'classify this',
    system: 'You are a classifier.',
    maxTokens: 256,
    temperature: 0.2,
    jsonMode: true,
  })
  assert.equal(r.ok, true)
  assert.equal(calls[0].args.system,      'You are a classifier.')
  assert.equal(calls[0].args.prompt,      'classify this')
  assert.equal(calls[0].args.maxTokens,   256)
  assert.equal(calls[0].args.temperature, 0.2)
  assert.equal(calls[0].args.jsonMode,    true)
})

test('attempts log records each provider tried with status', async () => {
  const { catalog } = mockProviders({ DEEPSEEK: 'throw', GROQ_QUALITY: 'throw' })
  const r = await routeAIWithProviders(catalog, { task: 'generate_icp', prompt: 'x' })
  assert.equal(r.attempts.length, 3)
  assert.equal(r.attempts[0].provider, 'DEEPSEEK')
  assert.equal(r.attempts[0].status,   'error')
  assert.match(r.attempts[0].error,    /deepseek blew up/)
  assert.equal(r.attempts[1].provider, 'GROQ_QUALITY')
  assert.equal(r.attempts[1].status,   'error')
  assert.equal(r.attempts[2].provider, 'GROQ_FAST')
  assert.equal(r.attempts[2].status,   'ok')
})

// ── DEFAULT_PROVIDERS shape ────────────────────────────────────────────────

test('DEFAULT_PROVIDERS has all 4 providers with required interface', () => {
  for (const key of ['GROQ_FAST', 'GROQ_QUALITY', 'DEEPSEEK', 'CLAUDE']) {
    const p = DEFAULT_PROVIDERS[key]
    assert.ok(p, `${key} missing`)
    assert.equal(typeof p.name, 'string')
    assert.equal(typeof p.model, 'string')
    assert.equal(typeof p.available, 'function')
    assert.equal(typeof p.call, 'function')
  }
})

test('DEFAULT_PROVIDERS use currently offered model defaults', () => {
  assert.equal(DEFAULT_PROVIDERS.GROQ_FAST.model,    'qwen/qwen3.8-27b')
  assert.equal(DEFAULT_PROVIDERS.GROQ_QUALITY.model, 'qwen/qwen3.8-27b')
  assert.equal(DEFAULT_PROVIDERS.DEEPSEEK.model,     'deepseek-flash')
  assert.equal(DEFAULT_PROVIDERS.CLAUDE.model,       'claude-sonnet-4-6')
})

test('real provider request builders use current IDs and preserve JSON and token budgets', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) })
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] })
  })
  for (const key of ['GROQ_FAST', 'GROQ_QUALITY', 'DEEPSEEK']) {
    assert.equal(await DEFAULT_PROVIDERS[key].call({ prompt: 'Return JSON.', maxTokens: 256, jsonMode: true }), '{"ok":true}')
    const body = requests.at(-1).body
    assert.equal(body.model, DEFAULT_PROVIDERS[key].model)
    assert.equal(body.max_tokens, 256)
    assert.deepEqual(body.response_format, { type: 'json_object' })
    if (key === 'DEEPSEEK') assert.deepEqual(body.thinking, { type: 'disabled' })
    else assert.equal(body.reasoning_effort, 'none')
  }
})

test('model overrides are trimmed, used in requests and metadata, and blank overrides fall back', async t => {
  let sent
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent = JSON.parse(options.body)
    return Response.json({ choices: [{ message: { content: 'ok' } }] })
  })
  const cases = [
    ['GROQ_FAST', 'GROQ_FAST_MODEL', 'qwen/qwen3.8-27b'],
    ['GROQ_QUALITY', 'GROQ_QUALITY_MODEL', 'qwen/qwen3.8-27b'],
    ['DEEPSEEK', 'DEEPSEEK_MODEL', 'deepseek-flash'],
  ]
  for (const [key, variable, fallback] of cases) {
    const original = process.env[variable]
    t.after(() => { if (original === undefined) delete process.env[variable]; else process.env[variable] = original })
    process.env[variable] = '  synthetic-override  '
    await DEFAULT_PROVIDERS[key].call({ prompt: 'x' })
    assert.equal(sent.model, 'synthetic-override')
    assert.equal(DEFAULT_PROVIDERS[key].model, sent.model)
    if (key !== 'DEEPSEEK') assert.equal('reasoning_effort' in sent, false)
    process.env[variable] = '   '
    await DEFAULT_PROVIDERS[key].call({ prompt: 'x' })
    assert.equal(sent.model, fallback)
    assert.equal(DEFAULT_PROVIDERS[key].model, fallback)
  }
})

test('empty or truncated provider completions fail so a usable fallback can run', async t => {
  for (const key of ['GROQ_FAST', 'DEEPSEEK']) {
    for (const choice of [
      { finish_reason: 'stop', message: { content: '   ' } },
      { finish_reason: 'length', message: { content: '{"partial":' } },
    ]) {
      const stub = t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [choice] }))
      await assert.rejects(DEFAULT_PROVIDERS[key].call({ prompt: 'x' }), /empty|truncated/i)
      stub.mock.restore()
    }
  }
})

test('reasoning-budget exhaustion reaches the next usable provider', async t => {
  let attempts = 0
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [++attempts === 1
    ? { finish_reason: 'length', message: { content: '' } }
    : { finish_reason: 'stop', message: { content: '{"intent":"buying"}' } }] }))
  const catalog = {
    GROQ_FAST: { ...DEFAULT_PROVIDERS.GROQ_FAST, available: () => true },
    GROQ_QUALITY: { ...DEFAULT_PROVIDERS.GROQ_QUALITY, available: () => false },
    DEEPSEEK: { ...DEFAULT_PROVIDERS.DEEPSEEK, available: () => true },
  }
  const result = await routeAIWithProviders(catalog, { task: 'classify_match', prompt: 'Return JSON.', maxTokens: 120 })
  assert.equal(result.ok, true)
  assert.equal(result.providerKey, 'DEEPSEEK')
  assert.equal(result.text, '{"intent":"buying"}')
  assert.equal(attempts, 2)
})
