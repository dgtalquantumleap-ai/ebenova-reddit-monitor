// lib/scrapers/upwork.js — Upwork Community forum search (public HTML)
// Returns posts in the same shape as searchReddit() in monitor.js

import * as cheerio from 'cheerio'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

export default async function searchUpwork(keywordEntry, { seenIds, delay, MAX_AGE_MS }) {
  const { keyword } = keywordEntry
  const results = []

  const url = `https://community.upwork.com/t5/forums/searchpage/tab/message?q=${encodeURIComponent(keyword)}&sort_by=-topicPostDate`
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    })
    if (!res.ok) {
      console.warn(`[upwork] HTTP ${res.status} for "${keyword}"`)
      return results
    }

    const html = await res.text()
    const $ = cheerio.load(html)

    // Upwork Community uses Lithium/Khoros — search results are in .search-result or message list items
    const candidates = []

    // Primary selector: search result message rows
    $('li.search-result, .message-list-item, .lia-message-item, h3.lia-message-subject a, .search-results .message-subject a').each((i, el) => {
      const $el = $(el)
      const $link = $el.is('a') ? $el : $el.find('a').first()
      const href = $link.attr('href') || ''
      const title = ($link.text() || $el.find('.message-subject, .lia-message-subject').text() || '').trim()
      if (href && title && href.includes('/t5/')) candidates.push({ href, title })
    })

    // Fallback: any link into the t5 board with a reasonable title
    if (candidates.length === 0) {
      $('a[href*="/t5/"]').each((i, el) => {
        const href  = $(el).attr('href') || ''
        const title = $(el).text().trim()
        if (title.length > 15 && title.length < 250 && !href.includes('searchpage') && !href.includes('/category/')) {
          candidates.push({ href, title })
        }
      })
    }

    const seen = new Set()
    for (const { href, title } of candidates.slice(0, 10)) {
      const fullUrl = href.startsWith('http') ? href : `https://community.upwork.com${href}`
      const id = `upwork_${href.replace(/[^a-z0-9]/gi,'_').slice(0, 40)}`
      if (seen.has(id) || seenIds.has(id)) continue
      seen.add(id)
      seenIds.add(id)

      results.push({
        id, title,
        url: fullUrl,
        subreddit: 'upwork-community',
        author: 'upwork',
        score: 0, comments: 0,
        body: '',
        createdAt: new Date().toUTCString(),
        keyword, source: 'upwork', approved: true,
      })
    }
  } catch (err) {
    console.warn(`[upwork] fetch error for "${keyword}":`, err.message)
  }

  if (delay) await delay(3000)
  return results
}
