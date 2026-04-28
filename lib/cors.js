// CORS allowlist middleware. Replaces the wildcard `Access-Control-Allow-Origin: *`
// in api-server.js. Echoes the request's Origin only if it's in the allowlist.
//
// Usage:
//   import { makeCorsMiddleware } from './lib/cors.js'
//   const allowed = (process.env.ALLOWED_ORIGINS || 'https://ebenova.dev').split(',').map(s => s.trim())
//   app.use(makeCorsMiddleware(allowed))

export function makeCorsMiddleware(allowlist) {
  const allow = new Set(allowlist)
  return function corsMiddleware(req, res, next) {
    const origin = req.headers.origin
    res.setHeader('Vary', 'Origin')
    if (origin && allow.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, PATCH')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      res.setHeader('Access-Control-Max-Age', '86400')
    }
    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
  }
}
