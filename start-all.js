// start-all.js — Railway entry point
// Forks: api-server.js (HTTP API), monitor.js (v1 cron), monitor-v2.js (v2 multi-tenant cron)
// All three run under a single Railway service.
// If any worker crashes, it auto-restarts after 10 seconds.

import { fork } from 'child_process'
import { resolve } from 'path'

const WORKERS = [
  { name: 'api',  file: 'api-server.js' },
  { name: 'v1',   file: 'monitor.js'    },
  { name: 'v2',   file: 'monitor-v2.js' },
]

const processes = new Map()

function startWorker(worker) {
  console.log(`[launcher] Starting ${worker.name} (${worker.file})…`)
  const child = fork(resolve(process.cwd(), worker.file), [], {
    stdio: 'inherit',
    env: process.env,
  })
  processes.set(worker.name, child)
  child.on('exit', (code, signal) => {
    console.warn(`[launcher] ${worker.name} exited (code=${code}, signal=${signal}) — restarting in 10s`)
    setTimeout(() => startWorker(worker), 10_000)
  })
  child.on('error', err => {
    console.error(`[launcher] ${worker.name} error:`, err.message)
  })
}

console.log('━'.repeat(60))
console.log('  Ebenova Monitor Launcher')
console.log(`  Workers: ${WORKERS.map(w => w.name).join(', ')}`)
console.log('━'.repeat(60))

for (const worker of WORKERS) startWorker(worker)

process.on('SIGTERM', () => {
  console.log('[launcher] SIGTERM — shutting down…')
  for (const [name, child] of processes) { console.log(`[launcher] Killing ${name}…`); child.kill('SIGTERM') }
  setTimeout(() => process.exit(0), 3000)
})
process.on('SIGINT', () => process.emit('SIGTERM'))
