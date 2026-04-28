// Daily cost cap. Redis-backed counter per resource per day.
// Used to fail-soft on Anthropic, Groq, OpenAI embeddings, Resend.
//
// Usage:
//   const cap = makeCostCap(redis, { resource: 'anthropic', dailyMax: 1000 })
//   const r = await cap()
//   if (!r.allowed) // fall back / skip / log
//
// On a new UTC day the counter resets (key includes YYYY-MM-DD).
export function makeCostCap(redis, { resource, dailyMax }) {
  return async function check() {
    const day = new Date().toISOString().slice(0, 10)
    const key = `costcap:${resource}:${day}`
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, 60 * 60 * 26)  // 26h buffer
    return { allowed: count <= dailyMax, used: count, max: dailyMax, resource }
  }
}
