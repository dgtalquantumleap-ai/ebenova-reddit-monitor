# Landing-Page Editorial Polish + Marketing Hooks — Design Spec

**Date:** 2026-04-29
**Status:** Awaiting approval
**Goal:** Make the Insights landing page (`public/index.html`) read less like an AI-generated SaaS template by leaning harder into the existing editorial/terminal identity, and add the two marketing hooks that are missing on the page (waitlist capture + interactive platform selector). Dashboard is out of scope except for one 10-line localStorage read.

---

## Context

- Live URL: `https://ebenova-insights-production.up.railway.app/`
- Existing identity: warm-black `#0a0907` + orange `#FF6B35` + Crimson Pro serif + JetBrains Mono — Bloomberg-terminal-meets-Financial-Times. Already distinctive.
- An external prompt requested a global redesign to slate-900 / cyan / violet / Inter-only. **Rejected** — that palette is the most over-generated AI-SaaS look in 2026 and would erase the existing identity rather than refine it.
- Real concern (per Olumide): Insights, getsignova.com, and ebenova.dev all read AI-generated. The fix is to remove AI-tells and double down on the editorial identity, not to repaint everything.
- 10-person demo is imminent. Big swing rewrites carry production-divergence risk.

---

## Scope

**In:**
- `public/index.html` — content/markup edits, inline `<style>` adjustments, inline `<script>` additions.
- `public/dashboard.html` — single 10-line addition that reads `localStorage('ebnv_landing_platform_prefs')` and pre-selects matching platforms in the new-monitor flow.

**Out:**
- Global token refactor of dashboard, settings, 404, exit-intent modal — **not doing.**
- Backend / API changes — `/v1/subscribe` already accepts the dispatch payload shape.
- Adding new dependencies, build steps, or frameworks — site stays single-file inline-everything.
- Twitter as a marketing claim — the public count stays at 9 platforms until production credentials are verified working.

---

## Visual Language

**Unchanged.** All existing CSS variables stay exactly as defined in `public/index.html` lines 12–27:
- Colors: `--bg`, `--bg-2`, `--bg-3`, `--ink`, `--ink-2`, `--ink-3`, `--gold`, `--gold-2`, `--green`, `--red`, `--line`
- Type: `--serif` (Crimson Pro), `--sans` (Inter), `--mono` (JetBrains Mono)

**No new tokens. No new fonts. No new color palette.** New components reuse the existing system.

**Two global cleanups:**
1. Remove the radial gradient blobs in `body { background-image: ... }` (lines 30–32) — they're a generic AI-SaaS visual move and not load-bearing.
2. Wrap all existing pulse/blink animations in a single `@media (prefers-reduced-motion: reduce)` block that disables animation. Currently zero motion-reduction support.

---

## Section-by-section verdict

| # | Section | Verdict | Action |
|---|---|---|---|
| 1 | Ticker bar (lines 428–442) | Keep | None |
| 2 | Nav (lines 446–457) | Keep | None |
| 3 | Hero (lines 460–551) | Keep + sharpen | Live-tail the terminal preview, see §Hero |
| 4 | Platforms strip (lines 553–567) | Keep | None |
| 5 | `#how` 3-col grid (lines 569–590) | **Kill, replace** | Replace with platform-selector marketing block, see §A |
| 6 | `#anatomy` (lines 592–653) | Keep + tighten | Connector lines on markers; one extra callout, see §Anatomy |
| 7 | Compare table (lines 655–685) | Keep | None |
| 8 | Manifesto (lines 687–696) | Keep | None |
| 9 | Pricing (lines 698–747) | Keep | None |
| 10 | **(new) Dispatch section** | Insert | Between pricing and final CTA, see §B |
| 11 | Final CTA banner (lines 749–754) | Keep | None |
| 12 | Footer (lines 756–767) | Keep | None |

---

## Hero — terminal preview live-tail

Today the feed rows in `.terminal .feed` (lines 494–545) are static markup with `animation-delay` one-shots. The "live" claim isn't backed by anything visibly live.

**Change:** an inline JS module that:
- Holds a fixed pool of ~20 mock match objects (source, title, score, time-template).
- On a 4–6 second interval (jittered), generates a fresh row from the pool with a current-time HH:MM:SS, prepends it to `.feed`, removes the oldest if more than 8 visible.
- Animates the new row: 60ms slide-down + opacity 0→1, 200ms duration.
- Pauses when `document.hidden` is true (avoids "scrolled three pages" backlog when the visitor returns to the tab).
- Pauses entirely when `prefers-reduced-motion: reduce` — feed renders as a static snapshot of the pool.
- The same pool feeds the platform-selector block in §A so they stay visually consistent.

Mock pool stays inline in the script (no fetches). Platform mix matches the platforms currently exposed in `lib/platforms.js`'s `PLATFORM_LABELS` minus `twitter` (still 9 — see §Scope).

---

## Anatomy — micro-tweaks

Two changes only:
1. The `.anatomy-marker.marker-1/2/3` labels (lines 617–619) currently float untethered. Add a 1px gold connector line from each marker to its target element using a thin `::before` pseudo-element, so the print-spread annotation feel is explicit instead of implied.
2. Add a fourth marker `marker-4` reading `INTENT 9.2/10 →` pointing at the score chip in `.anatomy-meta`.

No structural HTML change. Just CSS additions in the inline `<style>` and one new marker `<div>` in the markup.

---

## §A — Platform selector marketing block

**Position:** replaces the entire `#how` section (lines 569–590), keeping the `id="how"` so the existing nav anchor still works.

**Markup (skeleton):**

```html
<section id="how">
  <span class="label">PROTOCOL</span>
  <h2 class="h-display">Pick what you want <em>watched.</em></h2>
  <p class="how-intro">Toggle a source off and the feed below stops carrying it. The selection follows you to the dashboard when you sign up.</p>

  <div class="selector-grid" role="group" aria-label="Platform selection">
    <button type="button" role="switch" aria-checked="true"  data-platform="reddit">REDDIT</button>
    <button type="button" role="switch" aria-checked="true"  data-platform="hackernews">HACKER NEWS</button>
    <button type="button" role="switch" aria-checked="true"  data-platform="upwork">UPWORK</button>
    <button type="button" role="switch" aria-checked="true"  data-platform="fiverr">FIVERR</button>
    <button type="button" role="switch" aria-checked="true"  data-platform="quora">QUORA</button>
    <button type="button" role="switch" aria-checked="true"  data-platform="github">GITHUB</button>
    <button type="button" role="switch" aria-checked="true"  data-platform="medium">MEDIUM</button>
    <button type="button" role="switch" aria-checked="true"  data-platform="substack">SUBSTACK</button>
    <button type="button" role="switch" aria-checked="true"  data-platform="producthunt">PRODUCT HUNT</button>
  </div>

  <div class="selector-meta">
    WATCHING <span id="selector-count">9</span> OF 9 · ALL PLANS
  </div>

  <div class="selector-feed" role="log" aria-live="off"><!-- live-tail rows injected here --></div>
</section>
```

**Behavior:**
- All 9 chips selected by default.
- Clicking a chip toggles it: visually applies/removes a `.on` class (gold border, full-bright `--ink`); `aria-checked` flips; `data-platform` value updates the active set.
- The active set drives a filter on the live-tail feed used in this block (same pool as the hero terminal).
- Counter at top updates synchronously.
- Active set is persisted to `localStorage('ebnv_landing_platform_prefs')` as a JSON array of platform keys.
- Keyboard: Tab to focus, Space/Enter to toggle. Native `<button>` semantics carry this for free.

**Visual treatment:**
- Chips: pill-shaped, `var(--mono)`, `var(--ink-2)` text on `var(--bg-2)`, `1px solid var(--line)` border. Selected state: text becomes `var(--ink)`, border becomes `1px solid var(--gold)`, faint `box-shadow: inset 0 0 0 1px rgba(255,107,53,0.2)`.
- Hover (selected or not): translate-Y 1px lift, 100ms.
- Click: scale 0.97 → 1, 120ms bounce.
- NOT shadcn-style switches. NOT card grids. Horizontal flow with wrap, mono labels, gold accent.

**Counter animation:**
- Number updates with a 120ms opacity-flicker + slight Y-translate. No slot-machine roll (gimmicky).

**Layout below 640px:** chips wrap to 2-up grid (natural with `flex-wrap`).

---

## §B — Dispatch section

**Position:** inserted between the pricing section (closes line 747) and the final CTA banner (opens line 749).

**Markup (skeleton):**

```html
<section id="dispatch" style="border-top: 1px solid var(--line);">
  <span class="label">DISPATCH</span>
  <div class="dispatch-grid">
    <div>
      <h2 class="h-display">Not ready to run<br>your own monitor?<br><em>Read ours.</em></h2>
      <p class="dispatch-sub">A weekly briefing of buying-intent posts we caught — anonymized, with the reply that worked.</p>
    </div>
    <form class="dispatch-form" id="dispatch-form" novalidate>
      <label for="dispatch-email" class="dispatch-label">EMAIL</label>
      <input type="email" id="dispatch-email" name="email" required placeholder="you@company.com" autocomplete="email">
      <button type="submit" class="dispatch-cta">SUBSCRIBE <span class="btn-arrow">→</span></button>
      <div class="dispatch-meta" id="dispatch-meta">Free. Tuesdays. No "boost your reach" fluff.</div>
    </form>
  </div>
</section>
```

**Layout:**
- Two-column grid on desktop (1.1fr / 1fr), stacked single-column below 768px.
- Left: Crimson Pro headline (`h-display` class, already styled), short sub.
- Right: form with mono `EMAIL` label, single input, gold submit button, mono microcopy below.
- NO subscriber count. NO "early access" framing. NO "Join 1,247 founders." (Per editorial register; flag: if a real notable customer is willing to be named, swap the microcopy to "Read by founders at X, Y, Z" — out of scope until that's true.)

**Behavior:**
- Submit handler intercepts and POSTs to existing `/v1/subscribe` with body `{ email, plan: 'dispatch', source: 'landing_dispatch' }`. Endpoint already validates email, handles duplicates, and rate-limits.
- On submit: button label swaps to `SUBSCRIBING…` with a 3-dot mono animation, input is disabled.
- 200 response: form contents swap in place (no redirect, no navigation) to a confirmation block reading `✓ Subscribed. First dispatch lands Tuesday.` styled to match the editorial register.
- `already_on_waitlist: true` from API: same success state — the user shouldn't notice.
- Error (non-2xx, network fail): inline error in `var(--red)` below the form, button re-enables. Form-level shake animation (gated by `prefers-reduced-motion`).

**API contract — no changes needed:**
- `/v1/subscribe` (in `api-server.js`) already accepts `{ email, plan }` and ignores extra fields. We extend the payload with `source: 'landing_dispatch'` so future analytics can distinguish dispatch signups from generic waitlist; no server change is required to land safely.

---

## Funnel loop — landing → dashboard

**Bridge:** the `OPEN TERMINAL` CTA carries the platform selection forward.

**Implementation:**
- On the landing page, every chip-toggle writes the active array to `localStorage('ebnv_landing_platform_prefs')`.
- On `public/dashboard.html`, wherever the new-monitor flow renders its platform-selection UI (created in PR #12), read that localStorage key once on dashboard init. If present and non-empty, the existing platform-selection state is initialized to that subset; if absent or malformed JSON, fall back to the existing default behavior.
- Read happens once per dashboard load. We do NOT clear the key after reading — leaving it lets the visitor's selection persist across signup retries.
- Defensive validation: filter the parsed array down to a known-good platform set before applying. Source of truth for "known-good" is whatever the dashboard already uses to render its chips (no new dependency, no new fetch). Unknown keys are dropped silently.
- If the dashboard does not currently expose its platform set as a JS variable, the implementation step adds a small inline hardcoded array matching `lib/platforms.js`'s `VALID_PLATFORMS` — a known, stable list that changes only when we ship a platform PR (and we'd update both files in that PR).

**Surface:** ~10–15 lines of JS in `dashboard.html`. No CSS, no markup changes, no new endpoints. Exact location and surface area to be confirmed during plan-writing.

---

## Interactions summary

- All new transitions: 100–200ms, ease.
- All new animations gated by a single `@media (prefers-reduced-motion: reduce) { ... }` block at the top of the inline stylesheet that also covers the existing pulse/dot animations.
- No autoplay video. No external animation library. No GSAP. No framer-motion. CSS + tiny vanilla JS only.

## Accessibility

- Platform chips: native `<button role="switch" aria-checked>` + `aria-label`. Keyboard accessible by default.
- Live-tail feed: `role="log" aria-live="off"`. `aria-live="off"` is intentional — the feed is decorative on the marketing page; announcing every row would be hostile.
- Dispatch form: `<label for>` correctly associated; `aria-describedby="dispatch-meta"` on the input so the microcopy is read with the field.
- Focus rings: existing 2px gold focus outline already declared globally; new chips and form controls inherit it (no per-component overrides needed).
- Color contrast: existing `--ink #f5efe0` on `--bg #0a0907` already passes WCAG AA at 4.5:1; new components reuse the same tokens.

## Mobile

- Selector chips: wrap to 2-up below 640px (already natural with flex-wrap).
- Dispatch grid: stacks below 768px, both columns full-width.
- Hero terminal: responsive behavior unchanged (already collapses to single-column below md).
- Live-tail JS pauses on viewports below 480px to spare mobile CPU on a marketing page no one's reading on the train. Static pool snapshot is rendered instead.

---

## Testing

**No new automated tests.** This is a single HTML file with inline JS. The existing test runner is for backend/scraper logic; introducing Playwright/jsdom for the marketing page is overkill before a 10-person demo and would add CI surface area we'd then need to maintain.

**Manual verification checklist (run before merging the PR):**

1. Hero terminal: rows tail every 4–6s, oldest scrolls off, pause when tab hidden, freeze when reduced-motion is set in OS preferences.
2. Platform selector: each of 9 chips toggles correctly; counter stays in sync; selected/unselected visual state correct; keyboard (Tab + Space/Enter) works for every chip.
3. Selector → feed: toggling a platform off removes its rows from the live-tail feed within one tick; toggling back on, they reappear.
4. localStorage: select a non-default subset (e.g., 4 platforms), reload — the same 4 are pre-selected. Click `OPEN TERMINAL`, navigate to `/dashboard`, the new-monitor step shows the same 4 pre-ticked.
5. Dispatch form: empty submit → native validator fires; valid email submit → `SUBSCRIBING…` state → `/v1/subscribe` returns 200 → success state replaces form; resubmit same email → still success state (idempotent already_on_waitlist path); throttled 429 from rate limiter → inline error.
6. Lighthouse (mobile + desktop): no regression on Performance, Accessibility, Best Practices, SEO vs current production landing.
7. Breakpoints render cleanly at 360 / 768 / 1024 / 1440.
8. Browsers: Chrome, Safari, Firefox latest.

## Risk + rollback

- All edits land in two files (`public/index.html` heavily, `public/dashboard.html` ~10 lines).
- Single-commit revert is sufficient: `git revert <sha>` restores the prior landing in seconds.
- No DB schema, no API breaking change, no env-var change, no Railway deployment-flow change.
- Demo-day blast radius: limited to landing-page render. The dashboard's pre-fill defensively falls back to the default if localStorage is absent or malformed, so a bad payload never blocks signup.

## Out of scope (explicit)

- Dashboard redesign or token migration.
- Settings page, 404 page, exit-intent popup, modal waitlist.
- Build pipeline, framework introduction (React/Vue/Astro).
- Slate-900 / cyan / violet token system.
- Subscriber-count claim. Notable-customer logo wall. Testimonials.
- Automated visual-regression tests.
- LinkedIn or Twitter as marketing claims (Twitter pending creds-verified, LinkedIn parked per `lib/scrapers/linkedin.js` header).
