// test-apify-actor.js
// Standalone test for apify-actor.js using a mocked Apify SDK.
// Creates a temp mock module, runs the actor as a child process, then validates output.
// Run: node test-apify-actor.js

import dotenv from 'dotenv'
dotenv.config()

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { exec } from 'child_process'
import { promisify } from 'util'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const execAsync = promisify(exec)

// ── Test input configuration ─────────────────────────────────────────────────
const TEST_INPUT = {
  keywords: ['freelance contract'],
  productContext: 'I build freelance contract templates for clients.',
  maxPostAgeHours: 48,
  includeNairaland: false,
  generateReplies: false,
  groqApiKey: process.env.GROQ_API_KEY || '',
}

// ── Create mock Apify module ─────────────────────────────────────────────────
const mockModulePath = path.resolve(__dirname, '.test-apify-mock.mjs')
const outputPath = path.resolve(__dirname, '.test-output.json')

fs.writeFileSync(mockModulePath, `
const pushedData = [];
const testInput = ${JSON.stringify(TEST_INPUT)};
const outputFile = ${JSON.stringify(outputPath)};

export const Actor = {
  async init() {
    console.log('[mock] Actor.init()');
  },
  async getInput() {
    console.log('[mock] Actor.getInput() → returning test input');
    return testInput;
  },
  async pushData(item) {
    pushedData.push(item);
    console.log('[mock] Actor.pushData() — rows so far: ' + pushedData.length);
  },
  async exit() {
    console.log('[mock] Actor.exit()');
    const fs = await import('fs');
    fs.writeFileSync(outputFile, JSON.stringify({ pushedData, exited: true }, null, 2));
  }
};
`)

// ── Create modified actor that imports from mock ─────────────────────────────
const actorSource = fs.readFileSync(path.resolve(__dirname, 'apify-actor.js'), 'utf-8')
// On Windows, ESM requires file:// URLs
const mockImportPath = process.platform === 'win32'
  ? `file:///${mockModulePath.replace(/\\/g, '/')}`
  : `file://${mockModulePath}`
const modifiedSource = actorSource.replace(
  "import { Actor } from 'apify'",
  `import { Actor } from '${mockImportPath}'`
)

const tempActorPath = path.resolve(__dirname, '.test-apify-actor-temp.mjs')
fs.writeFileSync(tempActorPath, modifiedSource)

// Clean up previous output
if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)

// ── Run the actor ────────────────────────────────────────────────────────────
console.log('[test] Running apify-actor.js with mocked Apify SDK…')
console.log('[test] Input:', JSON.stringify(TEST_INPUT, null, 2))
console.log('')

let stdout = ''
let stderr = ''

try {
  const result = await execAsync('node .test-apify-actor-temp.mjs', {
    cwd: __dirname,
    timeout: 120000,
  })
  stdout = result.stdout
  stderr = result.stderr
} catch (err) {
  stdout = err.stdout || ''
  stderr = err.stderr || ''
  console.log('[test] Actor process exited with error (may still have produced output):')
  console.log(err.message)
}

console.log(stdout)
if (stderr) console.error(stderr)

// ── Read and validate results ────────────────────────────────────────────────
if (!fs.existsSync(outputPath)) {
  console.log('\n❌ No output file generated — actor likely failed before completion.')
  cleanup()
  process.exit(1)
}

const result = JSON.parse(fs.readFileSync(outputPath, 'utf-8'))
const { pushedData: dataRows, exited } = result

console.log('\n' + '='.repeat(60))
console.log('  TEST SUMMARY')
console.log('='.repeat(60))

const summaryRow = dataRows.find(r => r.summary && r.results === null)
const postDataRows = dataRows.filter(r => r.id && !r.summary)
const summaryData = summaryRow?.summary || {}

console.log(`  Total rows pushed:  ${dataRows.length}`)
console.log(`  Data rows (posts):  ${postDataRows.length}`)
console.log(`  Summary row:        ${summaryRow ? 'yes' : 'no'}`)
console.log(`  Total matches:      ${summaryData.totalMatches ?? 'N/A'}`)
console.log(`  Reddit matches:     ${summaryData.redditMatches ?? 'N/A'}`)
console.log(`  Nairaland matches:  ${summaryData.nairalandMatches ?? 'N/A'}`)
console.log(`  Drafts generated:   ${summaryData.matchesWithDrafts ?? 'N/A'}`)
console.log(`  Not approved:       ${summaryData.flaggedNotApproved ?? 'N/A'}`)
console.log(`  Actor exited:       ${exited ? 'yes ✅' : 'no ❌'}`)

if (postDataRows.length > 0) {
  console.log('\n  Sample posts:')
  postDataRows.slice(0, 5).forEach((r, i) => {
    console.log(`    ${i + 1}. [${r.source}] r/${r.subreddit} — "${r.title.slice(0, 60)}"`)
    console.log(`       URL:     ${r.url}`)
    console.log(`       Age:     ${r.postAgeHours}h | Approved: ${r.approved}`)
    if (r.draft) console.log(`       Draft:   ${r.draft.slice(0, 80)}…`)
  })
} else {
  console.log('\n  ℹ  No posts matched (this is valid — Reddit may have no recent results).')
}

// ── Validate structure ───────────────────────────────────────────────────────
let pass = true

if (dataRows.length === 0 && !summaryRow) {
  console.log('\n❌ No data pushed at all!')
  pass = false
}

if (summaryRow && summaryData.totalMatches === undefined) {
  console.log('\n⚠  Summary row missing totalMatches')
}

for (const r of postDataRows) {
  const required = ['id', 'title', 'url', 'subreddit', 'source', 'keyword', 'approved', 'postAgeHours']
  for (const field of required) {
    if (r[field] === undefined) {
      console.log(`\n❌ Row missing field "${field}": ${JSON.stringify(r).slice(0, 120)}`)
      pass = false
    }
  }
  if (r.source !== 'reddit' && r.source !== 'nairaland') {
    console.log(`\n❌ Invalid source: "${r.source}"`)
    pass = false
  }
  if (typeof r.approved !== 'boolean') {
    console.log(`\n❌ "approved" should be boolean, got: ${typeof r.approved}`)
    pass = false
  }
}

if (pass) {
  console.log('\n✅ All validation checks passed!')
} else {
  console.log('\n❌ Some checks failed — review above.')
  process.exitCode = 1
}

console.log('='.repeat(60) + '\n')

// ── Cleanup ───────────────────────────────────────────────────────────────────
cleanup()

function cleanup() {
  try { fs.unlinkSync(mockModulePath) } catch {}
  try { fs.unlinkSync(tempActorPath) } catch {}
  try { fs.unlinkSync(outputPath) } catch {}
}
