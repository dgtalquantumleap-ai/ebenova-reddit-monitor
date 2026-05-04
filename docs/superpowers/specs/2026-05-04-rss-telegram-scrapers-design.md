# RSS + Telegram Scrapers Design

**Date:** 2026-05-04  
**Status:** Approved — pending implementation  
**Author:** Olumide / Claude

---

## 1. Architecture

Two new scrapers join the existing pipeline (Reddit, HN, Twitter). Both follow the same scraper interface:

```js
(keywordEntry, ctx) => Promise<match[]>
```

Where `ctx` is extended with:

```js
{
  seenIds,          // Set — global dedup across this cycle
  delay,            // async fn — inter-request pause
  MAX_AGE_MS,       // number — filter posts older than this
  allKeywords,      // string[] — all resolved keywords for this monitor
  rssFeeds,         // string[] — user-configured feed URLs
  telegramChannels, // string[] — user-configured channel handles
}
```

**Key difference from search-based scrapers:** RSS and Telegram are feed-based — no server-side keyword filter. Each scraper fetches the full feed once per source per cycle and matches client-side against `ctx.allKeywords`. The monitor loop skips calling these scrapers when the respective array is empty.

**Curated defaults:** The monitor cycle pre-populates `ctx.rssFeeds` with a small built-in list of relevant feeds (tech news, startup blogs, niche communities) merged with the user's custom feeds. Telegram has no built-in defaults — user-configured channels only.

---

## 2. RSS Scraper (`lib/scrapers/rss.js`)

### Feed parsing

Supports both RSS 2.0 (`<item>`) and Atom (`<entry>`) via regex — no npm XML parser.

| Field | RSS 2.0 | Atom |
|---|---|---|
| Item block | `<item>…</item>` | `<entry>…</entry>` |
| Title | `<title>` | `<title>` |
| URL | `<link>` | `<link href="…">` or `<id>` |
| Body | `<description>` | `<summary>` or `<content>` |
| Date | `<pubDate>` | `<published>` or `<updated>` |

CDATA sections are unwrapped. HTML tags are stripped from body. Entities decoded.

### Keyword matching

Each item body + title is tested against every entry in `ctx.allKeywords` (case-insensitive includes). First match wins; the item is tagged with that keyword. Items matching no keyword are discarded.

### Dedup + age filter

- Age: items older than `MAX_AGE_MS` are skipped (default 24 h)
- Dedup: canonical URL is hashed via `hashUrlToId(url, 'rss')` and checked against `ctx.seenIds`

### Output shape (same as all scrapers)

```js
{
  id, title, url, subreddit: feedHostname, author,
  score: 0, comments: 0, body,
  createdAt, keyword, source: 'rss', approved: true
}
```

### Error handling

Per-feed try/catch: one failing feed logs a warning and skips; others continue. No circuit breaker (feeds are independent). Returns `[]` gracefully on total failure.

### Limits

- Max 15 results per cycle across all feeds
- Per-feed fetch: 10 s timeout

---

## 3. Telegram Scraper (`lib/scrapers/telegram.js`)

### Fetch strategy

Public channels expose `https://t.me/s/{channel}` — no auth, no API key. One GET per channel per cycle.

### HTML parsing

Message blocks match `<div class="tgme_widget_message" data-post="{channel}/{id}">`. Extracted fields:

- **URL:** `https://t.me/{channel}/{id}` (canonical)
- **Body:** content of `.tgme_widget_message_text` div, HTML stripped
- **Date:** `<time datetime="…">` parsed directly

### Keyword matching

Same client-side matching as RSS: body tested against `ctx.allKeywords`, first match wins.

### Dedup + age filter

Same pattern: `hashUrlToId(url, 'telegram')` + `seenIds` + `MAX_AGE_MS`.

### Output shape

```js
{
  id, title: body.slice(0, 120), url,
  subreddit: '@' + channel, author: channel,
  score: 0, comments: 0, body,
  createdAt, keyword, source: 'telegram', approved: true
}
```

### Error handling

Per-channel try/catch: private/unavailable channels log once and skip. Returns `[]` gracefully. No circuit breaker.

### Limits

- Max 15 results per cycle across all channels
- Per-channel fetch: 10 s timeout

---

## 4. Monitor Schema + API Changes

### Schema (backward-compatible)

Two new optional fields on the monitor object in Redis, both default to `[]`:

```
rssFeeds:         string[]   // up to 5 RSS/Atom feed URLs
telegramChannels: string[]   // up to 5 channel handles (without @)
```

No migration required — existing monitors deserialize with `monitor.rssFeeds || []`.

### `PATCH /v1/monitors/:id`

Validation added for new fields:

- `rssFeeds`: array of strings, each must start with `https?://`, max 5 items
- `telegramChannels`: each must match `/^[a-zA-Z0-9_]{5,32}$/`, max 5 items

### `GET /v1/feeds/discover?url=` (new endpoint)

Resolves a user-pasted URL to one or more RSS/Atom feed URLs:

1. Fetch the URL (10 s timeout, browser-like user-agent)
2. Parse HTML for `<link rel="alternate" type="application/rss+xml" href="…">`
3. If none found, probe: `/feed`, `/rss`, `/feed.xml`, `/atom.xml`
4. Return `{ feeds: [{ url, title }] }` — empty array on no results, never an error response

### `monitor-v2.js` loop

When invoking RSS and Telegram scrapers:

```js
const feedCtx = {
  ...ctx,
  rssFeeds:         monitor.rssFeeds || [],
  telegramChannels: monitor.telegramChannels || [],
  allKeywords:      monitor.keywords.map(resolveKeyword),
}
// Skip if no sources configured
if (feedCtx.rssFeeds.length > 0 || CURATED_FEEDS.length > 0) {
  results.push(...await searchRSS(keyword, feedCtx))
}
if (feedCtx.telegramChannels.length > 0) {
  results.push(...await searchTelegram(keyword, feedCtx))
}
```

RSS and Telegram scrapers are called only once (on the first keyword iteration); subsequent keyword iterations skip them since `allKeywords` already covers the full set.

---

## 5. Settings UI

A "Custom Sources" section is added to the monitor edit drawer, below Keywords.

### RSS Feeds

- Text input + "Add" button
- On submit: calls `GET /v1/feeds/discover?url=…`
  - Feeds found → show as confirmation chips (confirm or dismiss)
  - None found → inline message "No feed detected — try the direct feed URL"
- Added feeds render as removable pill tags
- Collapsed disclosure: "Using curated feeds for [keyword]" — shows built-in list

### Telegram Channels

- Text input strips leading `@`, validates `/^[a-zA-Z0-9_]{5,32}$/` client-side before add
- Added channels render as removable `@handle` pill tags
- Input placeholder: `@channel`

### Save

Both arrays included in the existing `PATCH /v1/monitors/:id` call on Save. No new endpoint.

### Plan gating

None for now — 5 feeds + 5 channels available on all plans. PATCH handler can enforce plan limits later.

---

## 6. Testing

- `lib/scrapers/rss.js` — unit tests for RSS 2.0 parsing, Atom parsing, keyword matching, age filter, dedup, CDATA unwrap, graceful failure
- `lib/scrapers/telegram.js` — unit tests for HTML parsing, keyword matching, age filter, dedup, private channel graceful failure
- `GET /v1/feeds/discover` — unit test with mocked fetch: found via link tag, found via probe, not found
- `PATCH /v1/monitors/:id` — validation tests for `rssFeeds` and `telegramChannels`
