# Self-Serve Demo Readiness — Design Spec

**Date:** 2026-04-28
**Status:** Awaiting approval
**Goal:** Make the Reddit Monitor SaaS testable by 10 strangers from a single shared URL with zero hand-holding from Olumide. Their messages back to him should be feedback, not questions.

---

## Context

- Standalone product on `https://ebenova-insights-production.up.railway.app` (Railway). Not linked to ebenova.dev.
- Find Customers flow + Groq drafts just shipped to prod (verified live).
- Demo audience: 10 testers Olumide invites by sending one URL.
- Success metrics Olumide cares about: signups completed, monitors created, drafts generated, replies posted to Reddit, NPS-style "would you pay."

---

## What changes

Three independent commits, shipped in order:

### 1. Demo invite + auto-comp on signup

**Why:** Starter plan caps users at 1 monitor. Testers need to try multiple ideas to give meaningful feedback. Sending Olumide emails to provision them defeats the "self-serve" goal.

**How:**
- Landing page (`public/index.html`) reads `?invite=CODE` from URL on load. If present, the signup form POSTs `{ email, name, inviteCode }` to `/v1/auth/signup`.
- `/v1/auth/signup` validates: if `inviteCode === process.env.DEMO_INVITE_CODE`, the new user record gets:
  - `insightsPlan: 'growth'` (20 monitors, 100 keywords)
  - `compExpiresAt: <now + 30 days ISO string>`
  - `compOriginalPlan: 'starter'`
  - `source: 'demo-invite'`
- Existing users hitting the invite link also get bumped to growth comp:
  - If they're currently on `starter` or already on `demo-invite` comp: their plan becomes `growth`, `compExpiresAt` is reset to `now + 30 days`, magic link is resent. (Effectively extending or reapplying their comp.)
  - If they're on a paid Stripe plan (subscription active): the invite code is ignored — they're already getting more than the comp. Magic link is still resent.
- Welcome email copy is updated when `source === 'demo-invite'`: explains it's a 30-day demo with growth tier and asks for feedback via the in-app widget.
- Invalid or missing invite codes are silently ignored — signup proceeds as normal starter.
- **No expiry enforcement in this commit.** `compExpiresAt` is recorded as metadata only. Olumide manually downgrades after demo if needed. (Trade-off: simpler code, tiny risk of free service overrun. Acceptable for 10 users.)

**New file:** `lib/invite.js` — single function `validateInvite(code)` that returns `{ valid, plan, durationDays }` or `{ valid: false }`. Keeps invite logic isolated and testable.

**Modified:** `api-server.js` (signup handler), `public/index.html` (form), `.env.example`.

### 2. In-product feedback widget

**Why:** Testers will hit issues, have ideas, or feel things they want to share. We want that signal flowing into Olumide's Slack in real time, not into his DMs as questions.

**How:**
- `POST /v1/feedback` endpoint:
  - Auth: requires valid `apikey` (we want to know who's submitting)
  - Body: `{ npsScore, message, category }` where `npsScore` is integer 0-10, `message` is 1-2000 chars, `category` is one of `'bug'|'idea'|'praise'|'pricing'|'other'`
  - Rate limit: 5 submissions per hour per user (sliding window via existing `lib/rate-limit.js`)
  - On success: posts to `process.env.SLACK_FEEDBACK_WEBHOOK_URL` with formatted block including email, plan, NPS score, category, message, timestamp
  - If Slack webhook not configured, falls back to `console.log` (no failure to user)
  - Stores submission in Redis at `feedback:${userKey}:${ts}` with 90-day TTL for archival
  - Returns `{ success: true }` even if Slack delivery fails — never blocks user flow
- Floating widget on dashboard (`public/dashboard.html`):
  - Bottom-right, fixed position, signal-coral button: "💬 Feedback"
  - On click: modal with three fields:
    - NPS slider (0-10) labeled "How likely are you to recommend this to a friend?"
    - Category radio buttons (Bug / Idea / Praise / Pricing / Other)
    - Textarea: "What's on your mind?" (placeholder rotates: "Found a bug?" / "Wishing for a feature?" / "Just want to say something?")
  - Submit → POST → success state ("Thanks — that's gold." auto-closes in 3s) → on error, show inline "Couldn't send right now, try again."
- Widget visible on every dashboard tab. No prompt to open it — fully user-initiated.

**New files:** `routes/feedback.js`, `lib/slack-feedback.js`, `test/feedback.test.js`.

**Modified:** `api-server.js` (mount router), `public/dashboard.html` (FeedbackWidget component + render in App), `.env.example` (`SLACK_FEEDBACK_WEBHOOK_URL`).

### 3. Empty-state copy + tooltips

**Why:** Pure copy work. Testers who land on an empty Find Customers screen or empty Monitor Feed need to know what's happening and what to do next.

**How:** No new endpoints. Pure edits to `public/dashboard.html`:

- **FindCustomers state 1 (input):**
  - Headline: "Find people asking for what you sell."
  - Subhead: "Tell me about your business in a sentence or two. I'll find Reddit threads where buyers are talking — right now."
  - Add a "What's a good description?" expandable hint with a worked example.
- **MatchesFeed empty state (no monitors):**
  - "Your first monitor will appear here. Head to Find Customers to set one up."
- **MatchesFeed empty state (monitor exists but no matches yet):**
  - "Scanning Reddit, Hacker News, and 7 other platforms. First matches usually land within 15 minutes — you'll get an email and Slack alert."
- **Settings tab — new "Demo notes" section** (only shown if `source === 'demo-invite'`):
  - "You're on a 30-day demo of the Growth plan — 20 monitors, 100 keywords. Drag the feedback button bottom-right to share thoughts."

---

## Architecture decisions

- **Why a separate `lib/invite.js`:** isolates invite logic from the signup handler. Future: we'll want different invite types (referral, partner, beta) and we don't want signup to grow a switch statement.
- **Why store feedback in Redis:** Olumide may want to read submissions in bulk later. 90-day TTL is enough for the demo plus a buffer.
- **Why the rate limit:** prevents accidental spam if a tester double-clicks submit, and prevents a malicious actor from flooding Slack if the apikey leaks.
- **Why no enforcement on `compExpiresAt`:** for 10 users over 30 days, the implementation cost of expiry-aware auth (with Stripe subscription override logic) outweighs the cost of Olumide manually downgrading 0-2 freeloaders later.
- **Why no NPS auto-prompt:** auto-prompts feel pushy; a clear floating button respects the user's choice. We can add a one-time prompt after first draft generated as a follow-up if engagement is low.

## Out of scope

- Reply-tone customization, monitor edit, negative keywords, feed filters — all confirmed-but-deferred per `project_customization_deferred.md`.
- Replies-posted-to-Reddit metric — impossible server-side. Captured via NPS comments instead.
- Admin metrics dashboard — covered by Slack feedback flow + Olumide running ad-hoc Redis SCAN if needed.
- Comp expiry enforcement — manual for v1.
- Custom domain on the product — Olumide will attach later, Railway URL is canonical for now.

## Testing strategy

- `lib/invite.js`: unit tests for valid/invalid/missing codes.
- `routes/feedback.js`: unit tests for auth, validation, rate limiting, Slack-webhook-missing fallback. Mock the `fetch` to Slack.
- Signup with invite code: integration test using existing mock-redis pattern, verify the user record gets `insightsPlan: 'growth'` + `compExpiresAt`.
- Manual smoke test on prod after deploy: hit the invite URL, sign up with a throwaway email, verify magic link arrives, verify dashboard shows growth limits, submit feedback, verify Slack message arrives.

## Rollout

- Single PR with 3 commits.
- Squash-merge to main after each commit's tests pass locally.
- Railway deploys on merge.
- Olumide picks an invite code, sets `DEMO_INVITE_CODE` and `SLACK_FEEDBACK_WEBHOOK_URL` env vars in Railway dashboard before sharing the URL with testers.

## Risks

- **Slack webhook flakiness:** if Slack is down during demo, feedback still saves to Redis. Olumide can read post-hoc.
- **Magic-link email deliverability:** existing risk, not new. Resend is already wired and tested.
- **Invite code leaks publicly:** worst case, strangers get growth comp. Olumide rotates the code by changing the env var. Existing comp users keep their plan (we don't auto-revoke).
- **Tester confusion:** primary mitigation is commit 3 (copy work). Secondary mitigation is the feedback widget — they tell us what's confusing, we fix in real-time.
