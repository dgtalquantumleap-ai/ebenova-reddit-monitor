import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadEnv } from '../lib/env.js'

function makeTempEnv(content) {
  const dir = mkdtempSync(join(tmpdir(), 'envtest-'))
  const path = join(dir, '.env')
  writeFileSync(path, content)
  return { path, cleanup: () => { try { unlinkSync(path) } catch {} ; try { rmdirSync(dir) } catch {} } }
}

test('loads simple key=value pairs', () => {
  const { path, cleanup } = makeTempEnv('FOO_TEST=bar\nBAZ_TEST=qux\n')
  delete process.env.FOO_TEST; delete process.env.BAZ_TEST
  loadEnv(path)
  assert.equal(process.env.FOO_TEST, 'bar')
  assert.equal(process.env.BAZ_TEST, 'qux')
  cleanup()
})

test('handles quoted values without including the quotes', () => {
  const { path, cleanup } = makeTempEnv('STRIPE_QUOTED_TEST="whsec_abc123"\n')
  delete process.env.STRIPE_QUOTED_TEST
  loadEnv(path)
  assert.equal(process.env.STRIPE_QUOTED_TEST, 'whsec_abc123', 'literal quotes must NOT be included')
  cleanup()
})

test('does not overwrite existing env vars', () => {
  const { path, cleanup } = makeTempEnv('OVERRIDE_TEST=fromfile\n')
  process.env.OVERRIDE_TEST = 'fromenv'
  loadEnv(path)
  assert.equal(process.env.OVERRIDE_TEST, 'fromenv')
  delete process.env.OVERRIDE_TEST
  cleanup()
})

test('missing .env file is silently OK', () => {
  // Should not throw
  loadEnv('/nonexistent/path/.env')
  assert.ok(true)
})
