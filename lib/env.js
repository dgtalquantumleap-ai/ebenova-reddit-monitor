// Single shared .env loader. Wraps `dotenv` so all entry points use one
// implementation. Replaces hand-rolled parsers in api-server.js, monitor.js,
// monitor-v2.js, scripts/provision-client.js, scripts/backfill-stripe-index.js
// — all of which had subtle bugs (e.g. literal quotes preserved, comment
// handling). dotenv handles all of those correctly.
//
// Usage:
//   import { loadEnv } from './lib/env.js'
//   loadEnv()  // loads ./.env, no-op if missing
//
// Or with an explicit path:
//   loadEnv('/some/other/.env')

import { config } from 'dotenv'
import { resolve } from 'path'

export function loadEnv(path) {
  const envPath = path || resolve(process.cwd(), '.env')
  // dotenv silently no-ops on missing files. override:false means existing
  // process.env values win (matches all 5 hand-rolled parsers' behavior).
  config({ path: envPath, override: false })
}
