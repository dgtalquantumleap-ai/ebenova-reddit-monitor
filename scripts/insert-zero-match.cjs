// One-shot script: inserts GET /v1/monitors/:id/zero-match-cycles endpoint
const fs = require('fs')
const path = require('path')

const apiFile = path.join(__dirname, '..', 'api-server.js')
const content = fs.readFileSync(apiFile, 'utf8')

if (content.includes('/zero-match-cycles')) {
  console.log('Endpoint already present — skipping.')
  process.exit(0)
}

const code = `
// -- GET /v1/monitors/:id/zero-match-cycles --------------------------------
// Returns the consecutive zero-match cycle count for a monitor so the
// dashboard can surface a keyword-tuning nudge after 3+ empty cycles.
app.get('/v1/monitors/:id/zero-match-cycles', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { id } = req.params
  try {
    const redis = getRedis()
    const monitorRaw = await redis.get('insights:monitor:' + id)
    if (!monitorRaw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const monitor = typeof monitorRaw === 'string' ? JSON.parse(monitorRaw) : monitorRaw
    if (monitor.owner !== auth.owner)
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const raw = await redis.get('monitor:' + id + ':zero_match_cycles')
    const count = raw ? parseInt(raw, 10) : 0
    res.json({ success: true, monitor_id: id, zero_match_cycles: count, nudge: count >= 3 })
  } catch (err) {
    serverError(res, err)
  }
})

`

// Insert before the delete monitor endpoint
const MARKER = "app.delete('/v1/monitors/:id'"
const idx = content.indexOf(MARKER)
if (idx === -1) { console.error('Marker not found'); process.exit(1) }
fs.writeFileSync(apiFile, content.slice(0, idx) + code + content.slice(idx), 'utf8')
console.log('Zero-match-cycles endpoint inserted successfully.')
