import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Regression guard for the 2026-06-18 dashboard outage.
//
// public/dashboard.html runs React off the UMD global and compiles its inline
// `<script type="text/babel">` in the browser via @babel/standalone. The script
// tag was loaded UNPINNED:
//     https://unpkg.com/@babel/standalone/babel.min.js
// unpkg resolves the bare specifier to the `latest` dist-tag, which rolled to
// 8.0.2. Babel 8's @babel/preset-react defaults the JSX runtime to "automatic",
// so plain JSX now compiles to `import { jsx } from "react/jsx-runtime"`.
// babel-standalone injects the compiled code as a CLASSIC <script>; the browser
// hits the import, throws "Cannot use import statement outside a module", and
// the app never mounts — a blank dashboard for every user. Nothing in our code
// changed; the unpinned CDN dependency drifted across a major version under us.
//
// The page depends on the CLASSIC runtime (React.createElement + the React
// global), which is the default in @babel/standalone v7. Keep it pinned to a v7
// release. If you ever intentionally adopt v8 + the automatic runtime you must
// also supply react/jsx-runtime (import map + type="module") — update this test
// deliberately when you do.

const __dirname = dirname(fileURLToPath(import.meta.url))
const dashboardHtml = readFileSync(
  join(__dirname, '..', 'public', 'dashboard.html'),
  'utf8'
)

test('dashboard does not load @babel/standalone from an unpinned CDN URL', () => {
  // The bare URL resolves to `latest` and silently drifts across majors.
  assert.doesNotMatch(
    dashboardHtml,
    /unpkg\.com\/@babel\/standalone\/babel(\.min)?\.js/,
    'dashboard.html must not load @babel/standalone unpinned — pin an exact version'
  )
})

test('dashboard pins @babel/standalone to a classic-runtime (v7) release', () => {
  const m = dashboardHtml.match(/@babel\/standalone@(\d+)\.\d+\.\d+\/babel(\.min)?\.js/)
  assert.ok(
    m,
    'dashboard.html must reference a version-pinned @babel/standalone@<major.minor.patch>/babel.min.js'
  )
  assert.equal(
    m[1],
    '7',
    `expected @babel/standalone v7 (classic JSX runtime); found v${m[1]}. ` +
      'v8 defaults to the automatic runtime and breaks the in-browser classic setup.'
  )
})
