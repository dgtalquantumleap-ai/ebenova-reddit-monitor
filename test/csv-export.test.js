import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { escapeCsvField, toCsv, matchToExportRow, MATCH_EXPORT_COLUMNS } from '../lib/csv-export.js'

// ── escapeCsvField ─────────────────────────────────────────────────────────

test('escapeCsvField: passes simple ASCII through unchanged', () => {
  assert.equal(escapeCsvField('hello'), 'hello')
  assert.equal(escapeCsvField('123'),   '123')
  assert.equal(escapeCsvField('a-b_c'), 'a-b_c')
})

test('escapeCsvField: null / undefined → empty string', () => {
  assert.equal(escapeCsvField(null),      '')
  assert.equal(escapeCsvField(undefined), '')
})

test('escapeCsvField: numbers and booleans become string', () => {
  assert.equal(escapeCsvField(42),    '42')
  assert.equal(escapeCsvField(0),     '0')
  assert.equal(escapeCsvField(true),  'true')
  assert.equal(escapeCsvField(false), 'false')
})

test('escapeCsvField: Date becomes ISO string', () => {
  const d = new Date('2026-04-29T10:00:00.000Z')
  assert.equal(escapeCsvField(d), '2026-04-29T10:00:00.000Z')
})

test('escapeCsvField: comma triggers quote-wrapping', () => {
  assert.equal(escapeCsvField('a,b'), '"a,b"')
})

test('escapeCsvField: newline (LF or CR) triggers quote-wrapping', () => {
  assert.equal(escapeCsvField('line1\nline2'),   '"line1\nline2"')
  assert.equal(escapeCsvField('line1\r\nline2'), '"line1\r\nline2"')
})

test('escapeCsvField: double-quote inside is doubled, plus outer wrap', () => {
  assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""')
})

test('escapeCsvField: object is JSON-stringified then escaped', () => {
  // {} contains no comma/quote/nl when stringified — passes through
  assert.equal(escapeCsvField({}), '{}')
  // {a: 1} stringifies as '{"a":1}' which contains a quote → wrapped
  assert.equal(escapeCsvField({ a: 1 }), '"{""a"":1}"')
})

// ── toCsv ──────────────────────────────────────────────────────────────────

test('toCsv: header-only when rows array is empty', () => {
  const out = toCsv(['id', 'name'], [])
  assert.equal(out, 'id,name\r\n')
})

test('toCsv: header-only when rows is null/undefined', () => {
  assert.equal(toCsv(['id'], null),      'id\r\n')
  assert.equal(toCsv(['id'], undefined), 'id\r\n')
})

test('toCsv: serializes one row in the column order', () => {
  const out = toCsv(['id', 'title'], [{ title: 'T', id: 'x1' }])
  assert.equal(out, 'id,title\r\nx1,T\r\n')
})

test('toCsv: drops fields not in columns; missing fields become empty', () => {
  const out = toCsv(['a', 'b'], [{ a: 1, b: 2, c: 'EXTRA' }, { a: 3 }])
  assert.equal(out, 'a,b\r\n1,2\r\n3,\r\n')
})

test('toCsv: round-trips a draft with commas, newlines, and quotes correctly', () => {
  const draft = 'Hi, this draft has\n"quotes" in it.'
  const out = toCsv(['id', 'draft'], [{ id: 'm1', draft }])
  // Expected: header row, then m1, then quoted+escaped draft, then \r\n
  assert.equal(out, 'id,draft\r\nm1,"Hi, this draft has\n""quotes"" in it."\r\n')
})

test('toCsv: ends with \\r\\n on the final row (matches Excel expectations)', () => {
  const out = toCsv(['x'], [{ x: 'a' }, { x: 'b' }])
  assert.equal(out.endsWith('\r\n'), true)
  // Two rows + 1 header = 3 line terminators total
  assert.equal((out.match(/\r\n/g) || []).length, 3)
})

test('toCsv: numeric and null values render correctly', () => {
  const out = toCsv(['n', 'b', 'maybe'], [{ n: 0, b: false, maybe: null }])
  assert.equal(out, 'n,b,maybe\r\n0,false,\r\n')
})

// ── MATCH_EXPORT_COLUMNS ───────────────────────────────────────────────────

test('MATCH_EXPORT_COLUMNS is the spec-locked field list', () => {
  // Spec-locked. Reordering or removing is a downstream-pipeline-breaking
  // change. Adding columns is OK; do it at the end.
  assert.deepEqual(MATCH_EXPORT_COLUMNS, [
    'id', 'title', 'url', 'source', 'subreddit', 'author', 'score', 'comments',
    'postAgeHours', 'keyword', 'sentiment', 'intent', 'intentConfidence',
    'draft', 'postedAt', 'createdAt',
  ])
})

// ── matchToExportRow ───────────────────────────────────────────────────────

test('matchToExportRow: normalizes fields + computes postAgeHours', () => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const row = matchToExportRow({
    id: 'm1', title: 'T', url: 'u', source: 'reddit', subreddit: 'SaaS',
    author: 'alex', score: 42, comments: 3,
    keyword: 'kw', sentiment: 'positive', intent: 'buying', intentConfidence: 0.9,
    draft: 'reply', postedAt: null,
    createdAt: oneHourAgo,
  })
  assert.equal(row.id, 'm1')
  assert.equal(row.author, 'alex')
  assert.equal(row.intent, 'buying')
  assert.equal(row.postedAt, '')        // null → ''
  // postAgeHours: ~1 hour, allow a small float fuzz
  assert.ok(row.postAgeHours >= 0.9 && row.postAgeHours <= 1.1, `expected ~1, got ${row.postAgeHours}`)
})

test('matchToExportRow: empty input gives empty fields, no NaN', () => {
  const row = matchToExportRow({})
  for (const col of MATCH_EXPORT_COLUMNS) {
    assert.ok(row[col] === '' || row[col] === 0 || row[col] === null,
      `${col} should be empty-ish for an empty input, got ${row[col]}`)
  }
  // postAgeHours should NOT be NaN
  assert.ok(row.postAgeHours === '' || row.postAgeHours === null,
    `postAgeHours leaked NaN-ish: ${row.postAgeHours}`)
})

test('matchToExportRow: invalid createdAt does not produce NaN postAgeHours', () => {
  const row = matchToExportRow({ id: 'm', createdAt: 'not a date' })
  assert.ok(row.postAgeHours === '' || row.postAgeHours === null,
    `expected empty postAgeHours, got ${row.postAgeHours}`)
})

// ── End-to-end via toCsv + matchToExportRow ────────────────────────────────

test('end-to-end: real-shaped match list serializes cleanly', () => {
  const matches = [
    { id: 'r_x', title: 'A title, with comma', url: 'https://r/x', source: 'reddit',
      subreddit: 'SaaS', author: 'a', score: 5, comments: 1,
      keyword: 'kw', sentiment: 'positive', intent: 'buying', intentConfidence: 0.9,
      draft: 'Draft has\nnewline.', postedAt: null, createdAt: '2026-04-29T10:00:00Z' },
    { id: 'h_y', title: 'No specials', url: 'https://h/y', source: 'hackernews',
      subreddit: 'HackerNews', author: 'b', score: 30, comments: 12,
      keyword: 'kw', sentiment: 'neutral', intent: 'researching', intentConfidence: 0.7,
      draft: null, postedAt: '2026-04-29T11:00:00Z', createdAt: '2026-04-29T09:00:00Z' },
  ]
  const csv = toCsv(MATCH_EXPORT_COLUMNS, matches.map(matchToExportRow))
  // Header line
  assert.match(csv, /^id,title,url,source,subreddit,author,score,comments,postAgeHours,keyword,sentiment,intent,intentConfidence,draft,postedAt,createdAt\r\n/)
  // Row 1: title with comma should be wrapped, draft with newline should be wrapped
  assert.match(csv, /r_x,"A title, with comma"/)
  assert.match(csv, /"Draft has\nnewline\."/)
  // Row 2: clean fields, no wrapping
  assert.match(csv, /h_y,No specials,https:\/\/h\/y/)
  // Two row terminators + one header terminator = 3
  assert.equal((csv.match(/\r\n/g) || []).length, 3)
})
