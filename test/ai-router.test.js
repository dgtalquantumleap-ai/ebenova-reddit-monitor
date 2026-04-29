import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { routeAIWithProviders, _internals, DEFAULT_PROVIDERS } from '../lib/ai-router.js'

const { TASK_ROUTING, FALLBACK_CHAIN, buildTryOrder } = _internals

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
  assert.equal(TASK_ROUTING.generate_reply_draft,         'GROQ_QUALITY')
  assert.equal(TASK_ROUTING.weekly_pattern_summary,       'DEEPSEEK')
  assert.equal(TASK_ROUTING.generate_icp,                 'DEEPSEEK')
  assert.equal(TASK_ROUTING.competitor_threat_summary,    'DEEPSEEK')
  assert.equal(TASK_ROUTING.generate_client_report,       'CLAUDE')
  assert.equal(TASK_ROUTING.check_ai_visibility,          'CLAUDE')
  assert.equal(TASK_ROUTING.generate_onboarding_keywords, 'CLAUDE')
})

test('FALLBACK_CHAIN is GROQ_QUALITY → GROQ_FAST', () => {
  assert.deepEqual(FALLBACK_CHAIN, ['GROQ_QUALITY', 'GROQ_FAST'])
})

test('buildTryOrder: preferred=DEEPSEEK → DEEPSEEK, GROQ_QUALITY, GROQ_FAST', () => {
  assert.deepEqual(buildTryOrder('DEEPSEEK'), ['DEEPSEEK', 'GROQ_QUALITY', 'GROQ_FAST'])
})

test('buildTryOrder: preferred=GROQ_QUALITY does not duplicate', () => {
  assert.deepEqual(buildTryOrder('GROQ_QUALITY'), ['GROQ_QUALITY', 'GROQ_FAST'])
})

test('buildTryOrder: preferred=GROQ_FAST does not duplicate', () => {
  assert.deepEqual(buildTryOrder('GROQ_FAST'), ['GROQ_FAST', 'GROQ_QUALITY'])
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

test('DEFAULT_PROVIDERS model strings match spec', () => {
  assert.equal(DEFAULT_PROVIDERS.GROQ_FAST.model,    'llama-3.1-8b-instant')
  assert.equal(DEFAULT_PROVIDERS.GROQ_QUALITY.model, 'llama-3.3-70b-versatile')
  assert.equal(DEFAULT_PROVIDERS.DEEPSEEK.model,     'deepseek-chat')
  assert.equal(DEFAULT_PROVIDERS.CLAUDE.model,       'claude-sonnet-4-6')
})
