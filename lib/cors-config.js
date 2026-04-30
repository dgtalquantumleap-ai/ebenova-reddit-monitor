// lib/cors-config.js — default CORS allowlist (testable).
//
// Extracted from api-server.js so production-hardening tests can pin the
// default list without spinning up Express. The api-server still reads
// process.env.ALLOWED_ORIGINS first; this is just the fallback.
//
// FIX 10 — ebenova.org + www.ebenova.org added (production primary).
// Legacy ebenova.dev kept for the marketing-site iframe case until the
// migration completes.

export const ALLOWED_ORIGINS_DEFAULT = [
  'https://ebenova.org',
  'https://www.ebenova.org',
  'https://ebenova.dev',
  'https://www.ebenova.dev',
  'https://ebenova-insights-production.up.railway.app',
]

export function resolveAllowedOrigins(envValue) {
  if (typeof envValue === 'string' && envValue.trim().length > 0) {
    return envValue.split(',').map(s => s.trim()).filter(Boolean)
  }
  return ALLOWED_ORIGINS_DEFAULT.slice()
}
