// One-shot script: inserts PATCH /v1/matches/:id/rating into api-server.js
// Run: node scripts/insert-rating.cjs
const fs = require('fs')
const path = require('path')

const apiFile = path.join(__dirname, '..', 'api-server.js')
const content = fs.readFileSync(apiFile, 'utf8')

if (content.includes('/v1/matches/:id/rating')) {
  console.log('Rating endpoint already present — skipping.')
  process.exit(0)
}

const ratingCode = `
// -- PATCH /v1/matches/:id/rating -----------------------------------------
// Stores a user quality rating: hot_lead | replied | noise | too_early |
// converted | wrong_intent. Accumulates per-monitor for calibration insights.
app.patch('/v1/matches/:id/rating', async (req, res) => {
  const auth = await authenticate(req)
  if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
  const { id: match_id } = req.params
  const { monitor_id, rating } = req.body
  const VALID_RATINGS = ['hot_lead', 'replied', 'noise', 'too_early', 'converted', 'wrong_intent']
  if (!monitor_id || !match_id || !VALID_RATINGS.includes(rating))
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'monitor_id, match_id, and rating required' } })
  try {
    const redis = getRedis()
    const monitorRaw = await redis.get('insights:monitor:' + monitor_id)
    if (!monitorRaw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const monitor = typeof monitorRaw === 'string' ? JSON.parse(monitorRaw) : monitorRaw
    if (monitor.owner !== auth.owner)
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Monitor not found' } })
    const matchKey = 'insights:match:' + monitor_id + ':' + match_id
    const raw = await redis.get(matchKey)
    if (!raw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Match not found' } })
    const match = typeof raw === 'string' ? JSON.parse(raw) : raw
    const ratedAt = new Date().toISOString()
    await redis.set(matchKey, JSON.stringify(Object.assign({}, match, { rating, ratedAt })))
    await redis.expire(matchKey, 60 * 60 * 24 * 7)
    await redis.hincrby('monitor:' + monitor_id + ':ratings', rating, 1)
    res.json({ success: true, match_id, rating, ratedAt })
  } catch (err) {
    serverError(res, err)
  }
})

`

const MARKER = "app.post('/v1/matches/draft'"
const idx = content.indexOf(MARKER)
if (idx === -1) { console.error('Marker not found'); process.exit(1) }
fs.writeFileSync(apiFile, content.slice(0, idx) + ratingCode + content.slice(idx), 'utf8')
console.log('Rating endpoint inserted successfully.')
