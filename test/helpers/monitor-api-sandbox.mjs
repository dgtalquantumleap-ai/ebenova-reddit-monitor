// Runs the real API in a child process. Every outbound fetch is intercepted;
// no production credentials, provider requests or Redis endpoint are used.
import { Server } from 'node:net'
import { createMockRedis } from './mock-redis.js'

const redis = createMockRedis()
const external = []
await redis.set('apikey:owner-test', JSON.stringify({ owner: 'owner@example.test', insights: true, insightsPlan: 'growth' }))
await redis.set('apikey:other-test', JSON.stringify({ owner: 'other@example.test', insights: true, insightsPlan: 'growth' }))
await redis.set('apikey:starter-test', JSON.stringify({ owner: 'starter@example.test', insights: true, insightsPlan: 'starter' }))

function encode(value) {
  if (typeof value === 'string' && value !== 'OK') return Buffer.from(value).toString('base64')
  if (Array.isArray(value)) return value.map(encode)
  return value
}

async function execute([command, ...args]) {
  const method = command.toLowerCase()
  if (typeof redis[method] !== 'function') throw new Error(`Unimplemented test Redis command: ${command}`)
  return { result: encode(await redis[method](...args)) }
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (url.hostname === 'redis.invalid') {
    const body = JSON.parse(options.body)
    const result = Array.isArray(body[0])
      ? await Promise.all(body.map(execute))
      : await execute(body)
    return Response.json(result)
  }
  external.push({ host: url.hostname, path: url.pathname })
  if (url.hostname === 'api.resend.com') return Response.json({ id: 'synthetic-email' })
  // Successful, synthetic keyword/community expansion. No live AI inference.
  return Response.json({ choices: [{ message: { content: '["synthetic owner phrase"]' } }], usage: {} })
}

process.on('message', async message => {
  if (message.type === 'snapshot') {
    // Let pending dynamic-import continuations settle before inspecting effects.
    await new Promise(resolve => setTimeout(resolve, 100))
    process.send({ type: 'snapshot', requestId: message.requestId,
      values: Object.fromEntries(redis._store),
      sets: Object.fromEntries([...redis._sets].map(([key, value]) => [key, [...value]])),
      external: [...external] })
  }
})

const originalListen = Server.prototype.listen
Server.prototype.listen = function (...args) {
  this.once('listening', () => process.send({ type: 'ready', port: this.address().port }))
  return originalListen.apply(this, args)
}

await import('../../api-server.js')
