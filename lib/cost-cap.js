// Cost cap: Redis-backed counter per resource per time window.
// Used to fail-soft on Anthropic, Groq, OpenAI embeddings, Resend, and
// per-user-per-hour caps for the Find Customers flow.
//
// Usage:
//   const cap = makeCostCap(redis, { resource: 'anthropic', dailyMax: 1000 })
//   const r = await cap()
//   if (!r.allowed) // fall back / skip / log
//
// Windows:
//   - Default (no windowSeconds): daily, key bucket = YYYY-MM-DD
//   - With windowSeconds: rolling fixed window, key bucket = floor(now / window)
//
// Sub-day example (per-hour cap):
//   const cap = makeCostCap(redis, { resource: 'find-preview', dailyMax: 10, windowSeconds: 3600 })
export function makeCostCap(redis, { resource, dailyMax, windowSeconds }) {
  const useDay = !windowSeconds
  const ttl = useDay ? 60 * 60 * 26 : windowSeconds + 60
  return async function check() {
    const bucket = useDay
      ? new Date().toISOString().slice(0, 10)
      : Math.floor(Date.now() / 1000 / windowSeconds)
    const key = `costcap:${resource}:${bucket}`
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, ttl)
    return { allowed: count <= dailyMax, used: count, max: dailyMax, resource }
  }
}
