// In-memory @upstash/redis-shaped mock for tests. Supports the subset of methods
// used by api-server.js, routes/stripe.js, and monitor-v2.js.
export function createMockRedis() {
  const store = new Map()
  const sets  = new Map()  // key -> Set
  const hashes = new Map() // key -> Map
  const lists  = new Map() // key -> Array (head at index 0, like Redis lpush)

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
    async incrby(key, amount) {
      const cur = Number(store.get(key) || 0) + Number(amount || 0)
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
    // ── List ops (for matches list, alert digests, etc.) ──────────────────
    async lpush(key, ...values) {
      const arr = lists.get(key) || []
      // Real Redis lpush prepends each value in order; preserve that semantic.
      for (const v of values) arr.unshift(v)
      lists.set(key, arr)
      return arr.length
    },
    async rpush(key, ...values) {
      const arr = lists.get(key) || []
      for (const v of values) arr.push(v)
      lists.set(key, arr)
      return arr.length
    },
    async lrange(key, start, stop) {
      const arr = lists.get(key) || []
      // Redis range is inclusive; stop=-1 means last element.
      const s = start < 0 ? Math.max(0, arr.length + start) : start
      const e = stop  < 0 ? arr.length + stop : stop
      return arr.slice(s, e + 1)
    },
    async ltrim(key, start, stop) {
      const arr = lists.get(key)
      if (!arr) return 'OK'
      const s = start < 0 ? Math.max(0, arr.length + start) : start
      const e = stop  < 0 ? arr.length + stop : stop
      lists.set(key, arr.slice(s, e + 1))
      return 'OK'
    },
    // setex (set with TTL) — TTL ignored in mock; tests don't care
    async setex(key, _seconds, value) {
      store.set(key, value)
      return 'OK'
    },
    // Override del to also clean up list/set/hash entries for the key
    // (covers the deleteMonitorAndData paths)
    // Test helper: inspect store contents
    _store: store,
    _sets: sets,
    _hashes: hashes,
    _lists: lists,
  }
  // Patch del to also clear lists (needed by deleteMonitorAndData)
  const baseDel = client.del.bind(client)
  client.del = async (...keys) => {
    let n = await baseDel(...keys)
    for (const k of keys) {
      if (lists.delete(k)) n++
      if (sets.delete(k)) n++
      if (hashes.delete(k)) n++
    }
    return n
  }
  return client
}
