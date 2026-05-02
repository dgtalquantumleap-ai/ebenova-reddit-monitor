// lib/scrapers/github.js — GitHub Issues search
// Public REST API — 10 req/min unauthenticated; set GITHUB_TOKEN for 30 req/min

export default async function searchGitHub(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword, type } = keywordEntry
  const token = process.env.GITHUB_TOKEN
  const headers = {
    'User-Agent': 'EbenovaInsights/2.0',
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
  const results = []
  try {
    // GitHub search supports "exact phrase" syntax natively
    const rawQ = type === 'phrase' ? `"${keyword}"` : keyword
    const q = encodeURIComponent(rawQ)
    const res = await fetch(
      `https://api.github.com/search/issues?q=${q}&sort=created&order=desc&per_page=20`,
      { headers, signal: AbortSignal.timeout(9000) }
    )
    if (!res.ok) return []
    const data = await res.json()
    for (const item of (data.items || [])) {
      const createdAt = new Date(item.created_at).getTime()
      if (MAX_AGE_MS && Date.now() - createdAt > MAX_AGE_MS) continue
      const id = `github_${item.id}`
      if (seenIds.has(id)) continue
      seenIds.add(id)
      // Drop automated bot accounts — no human intent
      const _ghAuthor = (item.user?.login || '').toLowerCase()
      if (
        _ghAuthor.includes('[bot]') ||
        _ghAuthor.includes('dependabot') ||
        _ghAuthor.includes('renovate') ||
        _ghAuthor.includes('github-actions')
      ) continue
      const repoMatch = item.repository_url?.match(/repos\/(.+)$/)
      results.push({
        id, source: 'github',
        title: item.title,
        body: (item.body || '').slice(0, 500),
        url: item.html_url,
        subreddit: repoMatch ? repoMatch[1] : 'github',
        author: item.user?.login || '',
        score: 0,
        comments: item.comments || 0,
        createdAt: item.created_at,
        keyword, approved: true,
      })
      if (results.length >= 15) break
    }
  } catch (err) {
    console.warn(`[github] search error for "${keyword}":`, err.message)
  }
  return results
}
