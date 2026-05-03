// lib/platform-health.js — health-check runner for the admin endpoint.
// Calls each scraper in the provided map with a probe keyword and collects
// per-platform status + sample counts. Pure function — fully testable without
// Express. api-server.js wires it to GET /v1/admin/platform-health.

export async function buildHealthReport(scraperMap, keyword = 'freelance', ctx = {}) {
  const results = {}
  await Promise.allSettled(
    Object.entries(scraperMap).map(async ([id, scraper]) => {
      try {
        const items = await scraper({ keyword }, ctx)
        results[id] = {
          status:       Array.isArray(items) ? 'ok' : 'error',
          sample_count: Array.isArray(items) ? items.length : 0,
        }
      } catch (err) {
        results[id] = { status: 'error', sample_count: 0, error: err.message }
      }
    })
  )
  return results
}
