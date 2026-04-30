// lib/scrapers/youtube.js — YouTube Data API v3 (Roadmap "YouTube" PR).
//
// Two-stage probe per keyword:
//   1. /search.list?type=video — top 15 most-recent videos
//   2. /commentThreads.list?searchTerms — for the top 3 videos, pull up to
//      20 comments matching the keyword (relevance-sorted).
//
// Both videos AND comments are returned as separate matches. Subreddit
// namespaces them so dedup, sort, and the dashboard badges all see them
// distinctly:
//   subreddit: 'youtube:video'    for video matches
//   subreddit: 'youtube:comment'  for comment matches
//
// Why API v3 and not HTML scraping: YouTube's HTML is hostile to scrapers
// (server-rendered keys, frequent shape changes, ToS friction). The Data
// API is free, official, and rate-limited generously (10k units/day; one
// search costs 100, one commentThreads costs 1).
//
// No-key behavior: if YOUTUBE_API_KEY isn't set we log once and return [].
// Keeps test environments + early-stage deployments safe.

import { hashUrlToId } from './_id.js'

const API_BASE = 'https://www.googleapis.com/youtube/v3'
const TIMEOUT_MS = 12_000
const COMMENT_DELAY_MS = 1000   // polite spacing between commentThreads calls
const VIDEO_LIMIT = 3            // pull comments for the top 3 videos only
const COMMENTS_PER_VIDEO = 20

// One-shot warning so a misconfigured deploy doesn't spam the cron logs.
let _warnedNoKey = false

export default async function searchYouTube(keywordEntry, ctx = {}) {
  const apiKey = process.env.YOUTUBE_API_KEY
  const { keyword } = keywordEntry || {}
  const seenIds = ctx.seenIds || { has: () => false, add: () => {} }
  const MAX_AGE_MS = ctx.MAX_AGE_MS || 24 * 60 * 60 * 1000
  const results = []
  if (!keyword || typeof keyword !== 'string') return results

  if (!apiKey) {
    if (!_warnedNoKey) {
      console.warn('[youtube] YOUTUBE_API_KEY not set — skipping. Set it in env to enable.')
      _warnedNoKey = true
    }
    return results
  }

  // ── Stage 1: video search ────────────────────────────────────────────────
  const searchUrl = `${API_BASE}/search?` + new URLSearchParams({
    q:                  keyword,
    type:               'video',
    order:              'date',
    maxResults:         '15',
    relevanceLanguage:  'en',
    part:               'snippet',
    key:                apiKey,
  }).toString()

  let searchData
  try {
    const res = await fetch(searchUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) {
      console.warn(`[youtube] search ${res.status} for "${keyword}"`)
      return results
    }
    searchData = await res.json()
  } catch (err) {
    console.warn(`[youtube] fetch error for "${keyword}":`, err.message)
    return results
  }

  const cutoffMs = Date.now() - MAX_AGE_MS
  const videoItems = []
  for (const item of (searchData?.items || [])) {
    const videoId = item?.id?.videoId
    if (!videoId) continue
    const publishedAt = item?.snippet?.publishedAt
    const publishedMs = publishedAt ? new Date(publishedAt).getTime() : 0
    // Drop videos older than MAX_AGE_MS — we want recent signal, and the
    // commentThreads cost is wasted on dormant videos.
    if (Number.isFinite(publishedMs) && publishedMs < cutoffMs) continue
    videoItems.push({ videoId, snippet: item.snippet, publishedMs })
  }

  for (const v of videoItems) {
    const url = `https://www.youtube.com/watch?v=${v.videoId}`
    const id = hashUrlToId(url, 'youtube')
    if (seenIds.has(id)) continue
    seenIds.add(id)

    results.push({
      id,
      title:     (v.snippet?.title || '').slice(0, 240),
      url,
      subreddit: 'youtube:video',
      author:    v.snippet?.channelTitle || 'youtube-channel',
      score:     0,
      comments:  0,    // statistics aren't included in /search; fetch only when needed
      body:      (v.snippet?.description || '').slice(0, 400),
      createdAt: v.snippet?.publishedAt || new Date().toISOString(),
      keyword,
      source:    'youtube',
      approved:  true,
    })
  }

  // ── Stage 2: comments on the top N videos ────────────────────────────────
  // Spec says "top 3 videos found" — we sort by publishedAt (already
  // requested order: 'date') so "top" here means "most recent N".
  const topVideos = videoItems.slice(0, VIDEO_LIMIT)
  for (let i = 0; i < topVideos.length; i++) {
    const v = topVideos[i]
    const commentsUrl = `${API_BASE}/commentThreads?` + new URLSearchParams({
      videoId:     v.videoId,
      searchTerms: keyword,
      maxResults:  String(COMMENTS_PER_VIDEO),
      order:       'relevance',
      part:        'snippet',
      key:         apiKey,
    }).toString()

    let commentsData
    try {
      const res = await fetch(commentsUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) {
        // Comments-disabled videos return 403 with reason commentsDisabled.
        // Treat any non-2xx as "skip this video" — never abort the keyword.
        console.warn(`[youtube] commentThreads ${res.status} for video ${v.videoId}`)
        continue
      }
      commentsData = await res.json()
    } catch (err) {
      console.warn(`[youtube] commentThreads fetch error for ${v.videoId}: ${err.message}`)
      continue
    }

    for (const item of (commentsData?.items || [])) {
      const commentId = item?.id
      const top = item?.snippet?.topLevelComment?.snippet
      if (!commentId || !top) continue

      const url = `https://www.youtube.com/watch?v=${v.videoId}&lc=${commentId}`
      const id = hashUrlToId(url, 'youtube')
      if (seenIds.has(id)) continue
      seenIds.add(id)

      results.push({
        id,
        title:     `${(v.snippet?.title || '').slice(0, 200)} [comment]`,
        url,
        subreddit: 'youtube:comment',
        author:    top.authorDisplayName || 'youtube-commenter',
        score:     Number(top.likeCount) || 0,
        comments:  Number(item.snippet?.totalReplyCount) || 0,
        body:      (top.textDisplay || '').slice(0, 400),
        createdAt: top.publishedAt || new Date().toISOString(),
        keyword,
        source:    'youtube',
        approved:  true,
      })
    }

    // Polite throttle between video-comment fetches.
    if (i < topVideos.length - 1 && typeof ctx.delay === 'function') {
      await ctx.delay(COMMENT_DELAY_MS)
    }
  }

  return results
}

// Test-only export — let tests reset the one-shot warning between cases.
export const _internals = {
  API_BASE, TIMEOUT_MS, COMMENT_DELAY_MS, VIDEO_LIMIT, COMMENTS_PER_VIDEO,
  resetNoKeyWarning: () => { _warnedNoKey = false },
}
