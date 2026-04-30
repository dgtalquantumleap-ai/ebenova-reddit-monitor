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
