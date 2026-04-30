// lib/env-required.js — fail-fast required-env validator.
//
// Each binary (api-server, monitor-v2) calls requireEnv([...]) at the very
// top of boot, BEFORE any middleware/routes/cron is registered. Missing or
// empty values trigger process.exit(1) with a clear FATAL: message per var
// + a pointer to .env.example.
//
// Why this matters: without this, Redis env-misconfig boots happily and
// 500s on every request; FROM_EMAIL fall-back to the stale ebenova.dev
// domain causes Resend to fail every email in production.

/**
 * Verify every var name in the list is set to a non-empty string. On any
 * miss, log one FATAL line per missing var and exit the process with code 1.
 *
 * Reserve this for vars whose absence makes the binary nonfunctional —
 * Redis, Resend, Groq. Optional-but-recommended vars should use warnEnv()
 * so a misconfigured deploy degrades instead of going dark.
 *
 * @param {string[]} vars
 * @param {{ exit?: (code:number)=>void, log?: (...args:any[])=>void }} [io]
 *        Test seam — the loop calls io.log/io.exit so unit tests can assert
 *        without crashing the test runner.
 */
export function requireEnv(vars, io = {}) {
  const log  = io.log  || ((...a) => console.error(...a))
  const exit = io.exit || ((code) => process.exit(code))
  const missing = []
  for (const v of vars) {
    const val = process.env[v]
    if (val == null || String(val).trim() === '') missing.push(v)
  }
  if (missing.length > 0) {
    for (const v of missing) log(`FATAL: Missing required env var: ${v}`)
    log('See .env.example for setup instructions.')
    exit(1)
    return { ok: false, missing }
  }
  return { ok: true, missing: [] }
}

/**
 * Warn-only counterpart to requireEnv. Logs `WARN: env <name> is unset —
 * <reason>` for each missing var but never exits. Use for vars where
 * the code has a working fallback (APP_URL, FROM_EMAIL) or a graceful
 * degrade (ANTHROPIC_API_KEY → router falls through to Groq; Stripe →
 * billing endpoint returns 503).
 *
 * Hotfix shipped after PR #43 brought production down: hard-requiring
 * APP_URL / FROM_EMAIL / ANTHROPIC / Stripe broke a deploy where those
 * vars had been quietly relying on inline fallbacks. Hard-required set
 * is now scoped to the four vars whose absence is unrecoverable.
 *
 * @param {Array<string | { name: string, reason?: string }>} vars
 * @param {{ log?: (...args:any[])=>void }} [io]
 */
export function warnEnv(vars, io = {}) {
  const log = io.log || ((...a) => console.warn(...a))
  const missing = []
  for (const entry of vars) {
    const name = typeof entry === 'string' ? entry : entry.name
    const reason = typeof entry === 'string' ? '' : (entry.reason || '')
    const val = process.env[name]
    if (val == null || String(val).trim() === '') {
      missing.push({ name, reason })
      log(`WARN: env ${name} is unset${reason ? ' — ' + reason : ''}`)
    }
  }
  return { warned: missing }
}
