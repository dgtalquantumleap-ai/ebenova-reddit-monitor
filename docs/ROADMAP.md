# Ebenova Insights — Complete Roadmap & Strategic Context

> **This file is the single source of truth for Claude Code.**
> Read this at the start of every session before touching any file.

---

## What We're Building

**Ebenova Insights** is a three-layer AI sales intelligence system, not a
monitoring tool. The distinction matters for every product decision.

### The Three Layers

**Layer 1 — INSIGHTS** ("What's happening in my market right now?")
Monitor platforms, classify intent/sentiment, surface priority matches.
Status: ~85% done. Stop adding features here unless critical.

**Layer 2 — RESEARCH** ("Who should I be targeting and what do they want?")
Author profiling, Builder Tracker, competitor intelligence, DeepSeek synthesis.
Status: ~30% done. This is where the current build focus should be.

**Layer 3 — EXECUTION** ("Go do it. Post, message, follow up, close.")
Reply outcome tracking, UTM attribution, webhook-to-CRM, WhatsApp handoff.
Status: ~20% done. Reply outcome tracking is the single highest-value feature.

---

## What's Already Built (merged PRs)

| PR | Feature | Layer |
|----|---------|-------|
| #9  | Audit fixes — AI dashes stripped, tone, Reddit visibility | 1 |
| #11 | Reddit RSS feeds (no OAuth) | 1 |
| #12 | Per-monitor platform selection (9 platforms, chip UI) | 1 |
| #13 | Account deletion + unsubscribe (CASL/NDPR compliant) | 1 |
| #19 | Intent/sentiment badges in dashboard MatchCard | 1 |
| #20 | Draft editing inline before copy | 3 |
| #21 | Mark as posted — postedAt timestamp + count | 3 |
| #22 | Author profile storage (Redis hash, dedup) | 2 |
| #23 | UTM injection in drafts (per-monitor UTM fields) | 3 |
| #24 | Generic outbound webhook per monitor | 3 |
| #25 | AI Router (lib/ai-router.js) — Groq/DeepSeek/Claude routing | infra |
| #26 | CSV export (matches + authors) | 2 |
| #27 | Weekly digest + classify.js wired to ai-router | 1 |

Current test baseline: ~358 passing + 1 skip (Twitter live test).
Verify exact count before starting any new PR.

---

## AI Stack (all in Railway env)

| Provider | Model | Use For | Cost |
|----------|-------|---------|------|
| Groq | llama-3.1-8b-instant | Classification per match (GROQ_FAST) | Cheapest |
| Groq | llama-3.3-70b-versatile | Draft generation, mid-value leads (GROQ_QUALITY) | Cheap |
| DeepSeek | deepseek-chat | Weekly synthesis, research summaries, pattern analysis | Cheap |
| Claude | claude-sonnet-4-6 | High-value drafts, client reports, onboarding, AI visibility | Premium |

### Draft Routing (via lib/ai-router.js)

```
intent: 'buying' or 'asking_for_tool'  → Claude Sonnet (best quality)
competitor keyword match               → Claude Sonnet (high stakes)
intent: 'researching' or 'complaining' → Groq 70b
intent: 'venting' or unclassified      → Groq 8b
```

### DeepSeek Tasks (weekly, not per-match)

- `weeklyPatternSummary` — narrative summary of week's matches
- `generateIdealCustomerProfile` — from author profile data
- `competitorThreatSummary` — competitor mention patterns

### Claude Tasks (premium, triggered by user action)

- `generateClientReport` — white label report executive summary
- `checkAIVisibility` — what do LLMs say about the brand
- `generateOnboardingKeywords` — personalised setup for new users
- `generate_premium_reply` — best lead re-draft in weekly digest

---

## Active PR Queue (in flight)

### PR #27 (GitHub) — White Label Client Report

- Branch: `feat/white-label-report`
- Status: Building
- Files: `lib/client-report.js` + `api-server.js` + `public/report-template.html`
- Key: shareToken per monitor, public URL, Claude writes executive summary
- No `dashboard.html` changes.

### PR #28 (GitHub) — Competitor Mode

- Branch: `feat/competitor-mode`
- Status: Building
- Files: `lib/keyword-types.js` + `api-server.js` + `monitor-v2.js` +
        `lib/draft-call.js` + `lib/ai-router.js` + `public/dashboard.html`
- Key: keywords gain type field (`'keyword'` | `'competitor'`)
       competitor drafts use Claude Sonnet with different system prompt
       share of voice tracking in Redis

---

## Approved Roadmap — Next PRs After #27/#28

### PRIORITY ORDER (do not deviate without approval)

**STOP building table stakes features.**
Brand24, Mention, Awario all have CSV export, sentiment, competitor tracking.
The differentiators are below. Build these next.

---

### PR #29 — Reply Outcome Tracking ⭐ HIGHEST PRIORITY

**This is the feature that proves ROI. No competitor has it.**

- Layer: 3 — Execution
- Files: `lib/reply-tracker.js` + `monitor-v2.js` (scheduled job) + `api-server.js`

Spec:

- When a match is marked as posted (postedAt set), schedule a check
  24 hours later
- Check: fetch the Reddit/platform post URL, compare comment count
  and score to the stored values at time of match
- Store engagement delta: `{ commentsDelta, scoreDelta, checkedAt }`
- If commentsDelta > 0: mark as `'got_engagement'`
- In weekly digest: "You replied to X posts. Y got engagement. Z drove
  traffic (UTM clicks if set)."
- In the client report: "Replies this month: X posted, Y engaged"
- This is the number a marketing manager shows their boss.

Why this beats competitors: Brandwatch at $800/month shows you mentions.
It cannot tell you whether your reply worked. This can.

---

### PR #30 — DeepSeek Weekly Intelligence Briefing ⭐ HIGH PRIORITY

**This turns the weekly digest from a report into a chief of staff.**

- Layer: 2 — Research
- Files: `lib/weekly-digest.js` (extend existing) + `lib/ai-router.js`

Spec:

After weekly digest runs, DeepSeek reads ALL matches from the week,
ALL author profiles, ALL competitor data, and writes a 5-bullet
strategic briefing appended to the digest email:

> **This Week's Intelligence:**
> - Dominant pain point: [what theme appeared most]
> - Competitor opportunity: [which competitor got complaints,
>   and are any threads still unanswered?]
> - Best unanswered thread: [title + url — still open to reply]
> - Top lead this week: [author username, platform, why they matter]
> - Recommended focus next week: [one concrete action]

DeepSeek prompt:
> "You are a sales intelligence analyst. Here is this week's data:
> Matches: {json}
> Author profiles: {json}
> Competitor matches: {json}
> Write exactly 5 bullet points as specified. Plain English.
> No markdown. No preamble. Write for a busy founder who reads
> this on Monday morning and needs to know what to do."

---

### PR #31 — Builder Tracker Mode ⭐ HIGH PRIORITY

**This is genuinely new. No competitor has it. Real customer waiting.**

- Layer: 2 — Research
- Customer: Steven Musielski (WhatsApp: +17149040697, USA)
- Willing to pay $50/month. Contact him when this ships.
- Files: `monitor-v2.js` + `api-server.js` + `public/dashboard.html`

Spec:

Monitor gains a mode field: `'keyword'` | `'builder_tracker'`

When `mode === 'builder_tracker'`:

- Keywords are builder signals, not problem keywords:
  Default set: "building in public", "buildinpublic", "launched my",
  "shipped today", "working on a startup", "my SaaS", "indie hacker",
  "day 1 of building", "week N of building"
- Instead of reply drafts, build author profiles
- Consistency scoring: daily (posted 5+ times in 7 days),
  weekly (2-4 times), occasional (1 time)
- Topic extraction: what are they building? (one Groq 8b call)
- Dashboard shows a "Builders" tab instead of "Matches"
- Export as CSV: platform, username, profileUrl, firstSeen, lastSeen,
  postCount, consistency, topics, latestPost

Platforms with real usernames (use for Builder Tracker):
Reddit, HackerNews, GitHub, ProductHunt, Substack, Twitter
Skip: Quora, Upwork, Fiverr (these use placeholder usernames)

---

### PR #32 — Monitor Mode Selector in Dashboard

- Depends on: PR #31
- Files: `public/dashboard.html` only

Add mode selector in monitor creation step 1:

```
[🔍 Find Customers] [👥 Track Builders] [🎯 Competitor Intel]
```

Each mode pre-configures:

- Keywords (preset list)
- Platforms (appropriate defaults)
- Draft behavior (reply drafts vs profile collection)

---

### PR #33 — Vertical Keyword Presets

- Layer: 1 — Insights (onboarding improvement)
- Files: `lib/keyword-presets.js` + `public/dashboard.html`

When creating a monitor, offer industry presets:
Healthcare, Real Estate, Fashion/Retail, Tech/SaaS, Food/Hospitality,
Hair/Beauty, Freelancing, Legal Services

Each preset loads a curated keyword list and platform set.
Generated by Claude on first load (`generateOnboardingKeywords` via ai-router).
User can edit before saving.

Why: removes the blank-keyword friction killing conversion on setup.

---

### PR #34 — AI Visibility Monitoring (LLM Mentions)

- Layer: 2 — Research (competitive intelligence)
- Files: `lib/ai-visibility.js` + `monitor-v2.js` (weekly job) + `api-server.js`

Weekly job asks Claude:

> "What do you know about [brandName]? If someone asked you to recommend
> a tool for [keywords], would you mention [brandName]? What alternatives
> would you suggest?"

Store response weekly. Track:

- Is brand mentioned? (yes/no)
- Position in response (first/second/not mentioned)
- Competitor mentions in same response
- Trend over time

Endpoint: `GET /v1/monitors/:id/ai-visibility`
Dashboard: "AI Visibility" section showing weekly trend

Why: Meltwater charges enterprise prices for GenAI Lens (LLM tracking).
You can build it for the cost of one Claude API call per week.
First mover in the mid-market.

---

### PR #35 — Jiji.ng Scraper

- Layer: 1 — Platform coverage
- Files: `lib/scrapers/jijing.js`

Nigerian marketplace, marked as LIVE in the product strategy document
but missing from codebase. High signal for fashion, real estate, food.
Same HTML scraping approach as Nairaland.
Add to platform selector as 🇳🇬 Jiji.ng

---

### PR #36 — Diaspora Monitor Mode

- Layer: 1 — Geographic intelligence
- Files: `lib/diaspora-corridors.js` + `public/dashboard.html`

Pre-configured platform bundles per diaspora corridor:

- Lagos ↔ London: Gumtree UK + Reddit UK + r/unitedkingdom
- Lagos ↔ Toronto: Kijiji Canada + Reddit Canada + r/toronto
- Lagos ↔ Houston: Reddit + Craigslist (Phase 2)

One toggle in dashboard, not 6 chips to configure manually.
This is unique positioning — no competitor monitors diaspora corridors.

---

## Platforms Currently Active

| Platform | Status | Scraper File |
|----------|--------|-------------|
| Reddit | ✅ Live (RSS) | `monitor-v2.js` inline |
| Hacker News | ✅ Live | `lib/scrapers/hackernews.js` |
| Medium | ✅ Live | `lib/scrapers/medium.js` |
| Substack | ✅ Live | `lib/scrapers/substack.js` |
| Quora | ✅ Live | `lib/scrapers/quora.js` |
| Upwork | ✅ Live | `lib/scrapers/upwork.js` |
| Fiverr | ✅ Live | `lib/scrapers/fiverr.js` |
| GitHub | ✅ Live | `lib/scrapers/github.js` |
| Product Hunt | ✅ Live | `lib/scrapers/producthunt.js` |
| Twitter | ⚠️ Partial | `lib/scrapers/twitter.js` (live test skipped) |
| Nairaland | ❌ Planned | Not yet built |
| Jiji.ng | ❌ Planned | PR #35 |
| Gumtree UK | ❌ Phase 2 | PR #36 |
| Kijiji Canada | ❌ Phase 2 | PR #36 |

---

## Products Being Monitored (for context)

| Product | URL | What it does |
|---------|-----|-------------|
| Signova | getsignova.com | AI contract generator for freelancers |
| Peekr | — | QR-based digital display sharing |
| FieldOps | ebenova.net | WhatsApp-native ops for service businesses |
| Ebenova API | api.ebenova.dev | Legal docs API, 27 types, 18 jurisdictions |
| Ebenova MCP | api.ebenova.dev | MCP server for Claude/Cursor |
| Scope Guard | getsignova.com | Scope creep detection + change orders |
| PocketBridge | ebenova.net | Africa payouts API |

---

## Pricing Context

Current: $29 Starter / $79 Growth / $199 Scale (USD)
Target: $99 Growth / $299 Agency after Layer 2+3 features ship

What justifies $99: Reply outcome tracking + DeepSeek synthesis
What justifies $299: Builder Tracker + white label reports + AI visibility

Nigerian market (separate surface):
₦50,000 Starter / ₦120,000 Growth / ₦200,000 Autopilot

---

## Key Technical Constraints

1. Never break existing monitors — all schema changes must be backward-compatible
2. Redis key structure is stable — no migrations without explicit approval
3. Classification (`lib/classify.js`) routes through `lib/ai-router.js`
4. All draft generation routes through `lib/ai-router.js`
5. Cost caps (`lib/cost-cap.js`) checked per provider separately
6. `emailEnabled=false` must always skip Resend calls
7. `unsubscribeToken` required on all alert emails (CASL/NDPR compliance)
8. No PR opened until tests pass and boots clean
9. Audit-style report format on every PR
10. No new npm packages without explicit approval

---

## Competitors We're Beating

| Competitor | Price | What they lack |
|------------|-------|----------------|
| Brand24 | $79/mo | No reply drafts, no outcome tracking |
| Mention | $49/mo | No AI drafts, no Builder Tracker |
| Awario | $49/mo | No multi-model AI, no author profiling |
| Brandwatch | $800+/mo | No reply layer, built for enterprises |
| Sprout Social | $249/user/mo | No community engagement focus |

Our positioning: "The only social listening tool that finds the
conversation, drafts the reply, tracks whether it worked, and
tells you who to follow up with next."

---

## Session Start Checklist

Before writing any code:

1. Read this file completely
2. Run test suite, confirm current baseline count
3. Check which GitHub PRs are currently open
4. Confirm which branch you're on
5. Read all files you plan to modify

_Last updated: April 2026_
