// In-memory @upstash/redis-shaped mock for tests. Supports the subset of methods
// used by api-server.js, routes/stripe.js, and monitor-v2.js.
export function createMockRedis() {
  const store = new Map()
  const sets  = new Map()  // key -> Set
  const hashes = new Map() // key -> Map

  const client = {
    async get(key) {
      return store.has(key) ? store.get(key) : null
    },
    async set(key, value, opts = {}) {
      if (opts.nx && store.has(key)) return null
      store.set(key, value)
      return 'OK'
    },
    async del(...keys) {
      let n = 0
      for (const k of keys) { if (store.delete(k)) n++ }
      return n
    },
    async incr(key) {
      const cur = Number(store.get(key) || 0) + 1
      store.set(key, cur)
      return cur
    },
    async expire(_key, _seconds) { return 1 },
    async ping() { return 'PONG' },
    async sadd(key, ...members) {
      const s = sets.get(key) || new Set()
      let added = 0
      for (const m of members) { if (!s.has(m)) { s.add(m); added++ } }
      sets.set(key, s)
      return added
    },
    async smembers(key) { return Array.from(sets.get(key) || []) },
    async srem(key, ...members) {
      const s = sets.get(key)
      if (!s) return 0
      let n = 0
      for (const m of members) { if (s.delete(m)) n++ }
      return n
    },
    async hset(key, fields) {
      const h = hashes.get(key) || new Map()
      for (const [k, v] of Object.entries(fields)) h.set(k, v)
      hashes.set(key, h)
      return Object.keys(fields).length
    },
    async hget(key, field) {
      return hashes.get(key)?.get(field) ?? null
    },
    async hgetall(key) {
      const h = hashes.get(key)
      if (!h) return null
      return Object.fromEntries(h)
    },
    // Test helper: inspect store contents
    _store: store,
    _sets: sets,
    _hashes: hashes,
  }
  return client
}
