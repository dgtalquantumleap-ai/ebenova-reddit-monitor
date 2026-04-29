// lib/csv-export.js — minimal CSV serialization, zero deps.
//
// CSV escaping rules (RFC 4180):
//   - If a field contains a comma, newline, or double-quote, wrap the field
//     in double-quotes
//   - Inside a quoted field, escape literal double-quotes by doubling them
//   - Plain values (no special chars) are written as-is
//   - null/undefined become the empty string
//
// We don't pull in a CSV library because the spec is ~20 lines and an
// external dep adds maintenance surface for a one-shot export endpoint.

const NEEDS_QUOTES = /[,"\r\n]/

/**
 * Escape a single field per RFC 4180.
 * @param {*} value
 * @returns {string}
 */
export function escapeCsvField(value) {
  if (value == null) return ''
  let s
  if (typeof value === 'string') s = value
  else if (typeof value === 'number' || typeof value === 'boolean') s = String(value)
  else if (value instanceof Date) s = value.toISOString()
  else s = JSON.stringify(value)
  if (NEEDS_QUOTES.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

/**
 * Serialize an array of records into a CSV string.
 *
 * @param {string[]} columns   ordered list of field names — also the header row
 * @param {Array<object>} rows
 * @returns {string} CSV text including the header. Always ends with \r\n on each line.
 */
export function toCsv(columns, rows) {
  const lines = [columns.map(escapeCsvField).join(',')]
  for (const row of (rows || [])) {
    const cells = columns.map(col => escapeCsvField(row?.[col]))
    lines.push(cells.join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

// Standard column order for monitor-match exports. Locked-in so downstream
// pipelines (Builder Tracker CSV in #34, customer reports) get a predictable
// schema. Adding columns later is OK; reordering is a breaking change.
export const MATCH_EXPORT_COLUMNS = [
  'id',
  'title',
  'url',
  'source',
  'subreddit',
  'author',
  'score',
  'comments',
  'postAgeHours',
  'keyword',
  'sentiment',
  'intent',
  'intentConfidence',
  'draft',
  'postedAt',
  'createdAt',
]

/**
 * Project a stored match record into the CSV-export shape. Computes
 * postAgeHours from createdAt, normalizes nulls, and drops everything not
 * in the public column list.
 */
export function matchToExportRow(match) {
  const createdAt = match?.createdAt || ''
  let postAgeHours = null
  if (createdAt) {
    const ts = new Date(createdAt).getTime()
    if (Number.isFinite(ts)) {
      postAgeHours = Math.round((Date.now() - ts) / 36e5 * 10) / 10
    }
  }
  return {
    id:               match?.id ?? '',
    title:            match?.title ?? '',
    url:              match?.url ?? '',
    source:           match?.source ?? '',
    subreddit:        match?.subreddit ?? '',
    author:           match?.author ?? '',
    score:            match?.score ?? '',
    comments:         match?.comments ?? '',
    postAgeHours:     postAgeHours == null ? '' : postAgeHours,
    keyword:          match?.keyword ?? '',
    sentiment:        match?.sentiment ?? '',
    intent:           match?.intent ?? '',
    intentConfidence: match?.intentConfidence ?? '',
    draft:            match?.draft ?? '',
    postedAt:         match?.postedAt ?? '',
    createdAt,
  }
}
