// Redis-backed sliding-window rate limiter. Uses INCR + EXPIRE for a fixed
// window. Good enough for abuse prevention; not a precise token bucket.
//
// Usage:
//   const limit = makeRateLimiter(redis, { max: 3, windowSeconds: 3600 })
//   const { allowed, retryAfterSeconds } = await limit(`ip:${req.ip}`)
//   if (!allowed) return res.status(429).json({ retryAfterSeconds })

export function makeRateLimiter(redis, { max, windowSeconds }) {
  return async function check(key) {
    const fullKey = `ratelimit:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`
    const count = await redis.incr(fullKey)
    if (count === 1) {
      await redis.expire(fullKey, windowSeconds + 5)
    }
    if (count > max) {
      const elapsedInWindow = Math.floor(Date.now() / 1000) % windowSeconds
      return { allowed: false, retryAfterSeconds: windowSeconds - elapsedInWindow }
    }
    return { allowed: true, retryAfterSeconds: 0 }
  }
}
