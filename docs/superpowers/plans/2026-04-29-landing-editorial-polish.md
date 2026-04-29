# Landing-Page Editorial Polish + Marketing Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the design from `docs/superpowers/specs/2026-04-29-landing-editorial-polish-design.md` — remove AI-tells from the marketing landing page, sharpen the existing editorial/terminal identity, add an interactive platform-selector marketing block (replaces `#how`), add a Dispatch (curated weekly briefing) capture section, and bridge platform selection from landing → dashboard via localStorage.

**Architecture:** Single-file inline-everything (no build step, no framework). All edits land in `public/index.html` (heavy) plus ~10–15 lines in `public/dashboard.html`. New behavior is vanilla ES2020 in inline `<script>` blocks. Existing CSS variables and design tokens are kept exactly as-is. No new dependencies. No new tests in the automated suite — the spec mandates a manual verification checklist run before merge.

**Tech Stack:** Plain HTML + CSS + ES2020 JS. Existing `/v1/subscribe` endpoint (already in `api-server.js`) for the Dispatch form. `localStorage` for the funnel-loop bridge.

**Branch:** continue on `docs/landing-editorial-polish-spec` (the spec already lives there). The final PR will carry both the spec doc and the implementation. Optionally rename to `feat/landing-editorial-polish` before opening the PR — purely cosmetic.

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `public/index.html` | All landing-page markup, inline CSS, inline JS | Modify (heavy) |
| `public/dashboard.html` | Read `localStorage('ebnv_landing_platform_prefs')` and pre-select matching platforms in the new-monitor flow | Modify (~10–15 lines) |
| `docs/superpowers/specs/2026-04-29-landing-editorial-polish-design.md` | Design spec | Already committed |
| `docs/superpowers/plans/2026-04-29-landing-editorial-polish.md` | This plan | New |

No new component files (pattern is single-file inline). No new CSS files. No new JS modules.

---

## Pre-flight (run once before Task 1)

- [ ] **Step P1: Confirm branch + clean tree**

```bash
git status
git branch --show-current
```

Expected: clean tree, branch is `docs/landing-editorial-polish-spec`. If on a different branch, switch first: `git checkout docs/landing-editorial-polish-spec`.

- [ ] **Step P2: Start a local API server in a separate shell**

```bash
npm run start:api
```

This serves `public/index.html` at `http://localhost:3001/`. Keep this running for the entire implementation. The Dispatch form's `/v1/subscribe` endpoint is mounted by this same server — tests of the form will hit it.

- [ ] **Step P3: Open both pages in the browser to confirm baseline render**

Open `http://localhost:3001/` and `http://localhost:3001/dashboard` in Chrome. Note the current state of:
- The radial gradient blobs in the page background (top-left + bottom-right tinted orange)
- The 3-column "Three signals. Three minutes." `#how` section
- The hero terminal with static feed rows
- No Dispatch section anywhere

These are what we're changing.

---

## Task 1: Global cleanups — remove gradient blobs + add reduced-motion guard

**Files:**
- Modify: `public/index.html` (lines 28–34 in the `<style>` block)

**What we're doing:** killing two AI-template tells (background gradient blobs) and adding the missing accessibility guard for users who set `prefers-reduced-motion: reduce` at the OS level.

- [ ] **Step 1.1: Remove the `body { background-image: ... }` rule**

Open `public/index.html`. Find this block at lines 29–34:

```css
  body {
    background-image:
      radial-gradient(circle at 12% 8%, rgba(255,107,53,0.04), transparent 50%),
      radial-gradient(circle at 88% 92%, rgba(255,107,53,0.03), transparent 60%);
    min-height: 100vh;
  }
```

Replace it with:

```css
  body { min-height: 100vh; }
```

- [ ] **Step 1.2: Add `prefers-reduced-motion` guard near the top of the `<style>` block**

Right after the `:root { ... }` block (insert after line 27), add:

```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
```

This single block disables every animation/transition site-wide for users who request reduced motion. It's a standard pattern; safe to leave in for the long term.

- [ ] **Step 1.3: Manual verification**

Reload `http://localhost:3001/`. Verify:
- Background is a flat warm-black — no orange tint at corners
- Page otherwise renders identically (ticker pulse still works for users without reduced-motion)
- Open OS Accessibility settings → enable "Reduce motion" (macOS: System Settings → Accessibility → Display; Windows: Settings → Accessibility → Visual effects). Reload. The ticker dots and pulses freeze. Disable the OS setting before continuing.

- [ ] **Step 1.4: Commit**

```bash
git add public/index.html
git commit -m "chore(landing): remove background gradient blobs + add reduced-motion guard"
```

---

## Task 2: Anatomy section — connector lines + add INTENT marker

**Files:**
- Modify: `public/index.html` (CSS for `.anatomy-marker` and the `<div class="anatomy">` block around lines 598–620)

**What we're doing:** the existing `marker-1/2/3` callouts visually float; we ground them with thin gold connector lines using `::before` pseudo-elements, and add a fourth marker pointing at the INTENT score chip. Pure CSS + one new `<div>`.

- [ ] **Step 2.1: Locate the existing anatomy-marker CSS**

Find the existing `.anatomy-marker.marker-1`, `.marker-2`, `.marker-3` rules in the inline `<style>` block (search for "marker-1"). Note their current positioning rules (top/right/bottom values). Keep those.

- [ ] **Step 2.2: Add connector-line CSS**

Append the following rule to the `<style>` block, immediately after the existing `.anatomy-marker` rules:

```css
  .anatomy-marker::before {
    content: '';
    position: absolute;
    background: var(--gold);
    opacity: 0.6;
  }
  .anatomy-marker.marker-1::before { top: 50%; right: -28px; width: 24px; height: 1px; }
  .anatomy-marker.marker-2::before { top: 50%; right: -28px; width: 24px; height: 1px; }
  .anatomy-marker.marker-3::before { top: 50%; right: -28px; width: 24px; height: 1px; }
  .anatomy-marker.marker-4::before { top: 50%; right: -28px; width: 24px; height: 1px; }
  .anatomy-marker.marker-4 {
    position: absolute; right: -180px; top: 24px;
    font-family: var(--mono); font-size: 10px; color: var(--gold);
    letter-spacing: 1px; white-space: nowrap;
  }
  @media (max-width: 1024px) {
    .anatomy-marker::before { display: none; }
    .anatomy-marker.marker-4 { position: static; display: inline-block; margin: 6px 0; }
  }
```

The `.marker-4` block matches the visual weight of marker-1/2/3 (existing CSS) and sets its own position. Adjust the `right`/`top` if it visually overlaps marker-3 — values are starting points.

- [ ] **Step 2.3: Add the marker-4 element to the markup**

Find the existing markers block (lines 617–619 of the original file):

```html
      <div class="anatomy-marker marker-1">SOURCE + SCORE →</div>
      <div class="anatomy-marker marker-2">CONTEXT →</div>
      <div class="anatomy-marker marker-3">REPLY DRAFT →</div>
```

Add a fourth line after marker-3:

```html
      <div class="anatomy-marker marker-1">SOURCE + SCORE →</div>
      <div class="anatomy-marker marker-2">CONTEXT →</div>
      <div class="anatomy-marker marker-3">REPLY DRAFT →</div>
      <div class="anatomy-marker marker-4">INTENT 9.2/10 →</div>
```

- [ ] **Step 2.4: Manual verification**

Reload. In the "Anatomy of a signal" section:
- Each of the four markers shows a thin gold connector line pointing toward the anatomy card
- The new "INTENT 9.2/10 →" marker appears, ideally aligned near the score chip in the anatomy-meta row. If it overlaps marker-3 visually, tune the `top` value in `.anatomy-marker.marker-4` (e.g. `top: 60px`) until it sits cleanly.
- Resize to 1023px width: connector lines disappear, `marker-4` falls inline below the card. No visual breakage.

- [ ] **Step 2.5: Commit**

```bash
git add public/index.html
git commit -m "feat(landing): anatomy markers — gold connector lines + INTENT callout"
```

---

## Task 3: Hero terminal — refactor markup for JS injection (no behavior change yet)

**Files:**
- Modify: `public/index.html` (the `<div class="terminal">...</div>` block around lines 488–550)

**What we're doing:** the existing hero terminal has 8 hardcoded feed rows with `animation-delay`. Before adding live-tail JS in Task 4, we trim to the 6 that should appear on initial render and add `id="hero-feed"` so JS can target the container. The page must still look identical after this task (visual no-op).

- [ ] **Step 3.1: Locate the `.feed` container**

Inside `<div class="terminal">` (line ~488), find `<div class="feed">`. Add an id attribute:

```html
    <div class="feed" id="hero-feed">
```

- [ ] **Step 3.2: Trim feed rows to 6**

Inside `#hero-feed`, keep the first 6 `.feed-row` elements (the ones at delays 0s through 0.5s) and delete the bottom 2 (delays 0.6s and 0.7s — the PH and SUBSTACK rows). The kept rows are: REDDIT, HN, UPWORK, QUORA, FIVERR, GITHUB. Their order top-to-bottom stays the same.

- [ ] **Step 3.3: Manual verification**

Reload. The hero terminal still renders. The visible feed shows 6 rows (the bottom 2 are gone). Background is unchanged. No console errors.

- [ ] **Step 3.4: Commit**

```bash
git add public/index.html
git commit -m "refactor(landing): tag hero feed for JS, trim to 6 initial rows"
```

---

## Task 4: Hero terminal — live-tail JS module

**Files:**
- Modify: `public/index.html` — add a new inline `<script>` block at the bottom of the page (just above the existing invite-code script around line 771)

**What we're doing:** install a tiny vanilla JS module that:
1. Holds a fixed pool of mock match objects.
2. Every 4–6 seconds (jittered), generates a fresh row from the pool with a current HH:MM:SS, prepends it to `#hero-feed`, removes the oldest row if more than 8 are visible.
3. Pauses when the tab is hidden (`document.hidden`), resumes on visibility-return.
4. Pauses entirely when the user has `prefers-reduced-motion: reduce` set, and on viewports below 480px.

The same pool will also be used by the platform selector in Task 7; we structure it as a module-scoped constant that Task 7 will reference.

- [ ] **Step 4.1: Add the live-tail script block**

Find the existing invite-code `<script>` near the bottom of the file (it starts with `<!-- Invite-code propagation:` and contains `(function () {` then `var params = new URLSearchParams(...)`). Insert the following ABOVE that comment:

```html
<!-- Live-tail mock feed for the hero terminal + (later) platform selector.
     No fetches — pool stays inline. Pauses on tab-hidden, reduced-motion,
     and small viewports. -->
<script>
(function () {
  // Shared pool. window.__ebnvFeedPool exposed so the platform-selector
  // script (loaded later in the page) can read the same source of truth.
  var POOL = [
    { src: 'reddit',     cls: 'src-reddit',   title: '"Anyone using AI to draft sales emails? Looking for recommendations…"', score: 9.2, summary: 'r/SaaS · 14 comments · author has shipped before' },
    { src: 'hackernews', cls: 'src-hn',       title: 'Show HN: I want to monitor Reddit for buying signals',                  score: 8.7, summary: '94 points · 22 comments' },
    { src: 'upwork',     cls: 'src-upwork',   title: 'Need a Shopify dev — looking for ongoing relationship',                 score: 7.4, summary: 'job posted 12m ago · fixed-price' },
    { src: 'quora',      cls: 'src-quora',    title: "What's the best alternative to Brand24 for monitoring mentions?",       score: 8.9, summary: '47 followers · 3 answers' },
    { src: 'fiverr',     cls: 'src-fiverr',   title: 'Looking for a freelance copywriter who has worked with B2B SaaS',       score: 7.8, summary: 'buyer request · open' },
    { src: 'github',     cls: 'src-github',   title: 'Issue: best library for AI prompt sanitization?',                       score: 6.5, summary: 'opened 8m ago · 2 reactions' },
    { src: 'producthunt',cls: 'src-ph',       title: 'Frustrated by manual outreach — what\'s the modern stack?',             score: 8.1, summary: 'discussion · 6 comments' },
    { src: 'substack',   cls: 'src-substack', title: 'Comment on "AI tools that actually save me time" → asks recs',         score: 7.0, summary: 'inline comment · 11 likes' },
    { src: 'medium',     cls: 'src-medium',   title: 'How I built a dripped-out outbound stack on $50/mo',                    score: 6.8, summary: 'article · 240 claps' },
    { src: 'reddit',     cls: 'src-reddit',   title: 'Need help finding leads in r/Entrepreneur without getting banned',      score: 8.4, summary: 'r/Entrepreneur · 9 comments' },
    { src: 'hackernews', cls: 'src-hn',       title: 'Ask HN: how do you replace cold email in 2026?',                         score: 7.9, summary: '38 points · 19 comments' },
    { src: 'quora',      cls: 'src-quora',    title: 'Has anyone moved off Brand24? Looking for cheaper options',             score: 8.2, summary: '12 followers · 1 answer' },
    { src: 'upwork',     cls: 'src-upwork',   title: 'Need ongoing AI engineer — comfortable with LangChain + Python',        score: 8.6, summary: 'hourly · long-term' },
    { src: 'fiverr',     cls: 'src-fiverr',   title: 'Want a designer who has shipped a SaaS marketing site before',          score: 7.1, summary: 'open brief · negotiable' },
    { src: 'github',     cls: 'src-github',   title: 'PR comment: "Could we use OpenRouter instead of direct Groq?"',          score: 6.9, summary: 'review thread · merged' },
    { src: 'producthunt',cls: 'src-ph',       title: 'Founders: what\'s actually working for new-customer acquisition?',     score: 8.0, summary: 'maker discussion · 14 comments' },
    { src: 'substack',   cls: 'src-substack', title: 'Reply on "The death of paid ads" → asks for tool recs',                 score: 7.5, summary: 'comment · 8 likes' },
    { src: 'medium',     cls: 'src-medium',   title: 'My honest review of every social-listening tool I tried in Q1',         score: 7.3, summary: 'article · 180 claps' },
  ];
  window.__ebnvFeedPool = POOL;

  var heroFeed = document.getElementById('hero-feed');
  if (!heroFeed) return;

  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var smallViewport = window.matchMedia && window.matchMedia('(max-width: 480px)').matches;
  if (reducedMotion || smallViewport) return; // leave the static rows in place

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function nowStamp() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function rowMarkup(item) {
    var titleClass = item.score >= 8 ? 'feed-title' : 'feed-title-low';
    var summary = item.summary
      ? '<span class="feed-summary">' + item.summary + '</span>'
      : '';
    return ''
      + '<div class="feed-row">'
      +   '<span class="feed-time">' + nowStamp() + '</span>'
      +   '<span class="feed-source ' + item.cls + '">' + item.src.toUpperCase().replace('PRODUCTHUNT', 'PH').replace('HACKERNEWS', 'HN') + '</span>'
      +   '<span class="' + titleClass + '">' + item.title + '</span>'
      +   '<span class="feed-score">' + item.score.toFixed(1) + '</span>'
      +   summary
      + '</div>';
  }
  function pickItem() {
    return POOL[Math.floor(Math.random() * POOL.length)];
  }

  var timer = null;
  function tick() {
    if (document.hidden) return;
    var item = pickItem();
    var temp = document.createElement('div');
    temp.innerHTML = rowMarkup(item);
    var newRow = temp.firstChild;
    heroFeed.insertBefore(newRow, heroFeed.firstChild);
    while (heroFeed.children.length > 8) {
      heroFeed.removeChild(heroFeed.lastChild);
    }
  }
  function schedule() {
    var delay = 4000 + Math.floor(Math.random() * 2000); // 4–6 s jitter
    timer = setTimeout(function () { tick(); schedule(); }, delay);
  }
  schedule();

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (timer) { clearTimeout(timer); timer = null; }
    } else if (!timer) {
      schedule();
    }
  });
})();
</script>
```

- [ ] **Step 4.2: Manual verification — desktop**

Reload `http://localhost:3001/`. Watch the hero terminal for ~30 seconds:
- New rows appear at the top every 4–6 seconds
- The oldest rows roll off the bottom (max ~8 visible at any time)
- Each new row uses the existing `slide-in` keyframe animation, so it slides in from the left

- [ ] **Step 4.3: Manual verification — tab-hidden pause**

Reload. Switch to a different tab for 30 seconds. Switch back. The feed should NOT have a pile of rows that ticked while the tab was hidden — it picks up where it left off.

- [ ] **Step 4.4: Manual verification — reduced motion**

Enable OS-level "Reduce motion". Hard reload (Cmd+Shift+R). The hero terminal shows the 6 static rows from Task 3, no live-tailing happens. Disable the OS setting.

- [ ] **Step 4.5: Manual verification — small viewport**

In Chrome DevTools, switch to mobile view (any device width ≤ 480px). Hard reload. No live-tailing; static rows only.

- [ ] **Step 4.6: Commit**

```bash
git add public/index.html
git commit -m "feat(landing): hero terminal live-tail with pause guards"
```

---

## Task 5: Replace `#how` section markup + selector CSS

**Files:**
- Modify: `public/index.html` (the `<section id="how">...</section>` block around lines 569–590, and the `<style>` block to add new rules)

**What we're doing:** drop the AI-templated 3-col grid and replace it with the platform-selector marketing block markup. CSS for the selector chips, counter, and selector-feed container goes in this task. JS toggle behavior is added in Task 6; feed wiring in Task 7. After this task, the new section renders statically with all chips visually "on" but does nothing on click.

- [ ] **Step 5.1: Add CSS rules for the selector**

Append the following to the `<style>` block, ideally near the other section-specific styles:

```css
  /* Platform selector marketing block */
  #how .how-intro {
    color: var(--ink-2); font-size: 16px; line-height: 1.7;
    max-width: 640px; margin: 12px 0 36px;
  }
  .selector-grid {
    display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px;
  }
  .selector-chip {
    font-family: var(--mono); font-size: 12px; letter-spacing: 1px;
    padding: 9px 14px; border-radius: 999px;
    background: var(--bg-2); color: var(--ink-2);
    border: 1px solid var(--line); cursor: pointer;
    transition: transform 0.1s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .selector-chip:hover { transform: translateY(-1px); border-color: var(--ink-3); }
  .selector-chip:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .selector-chip:active { transform: scale(0.97); }
  .selector-chip.on {
    color: var(--ink); border-color: var(--gold);
    box-shadow: inset 0 0 0 1px rgba(255,107,53,0.2);
  }
  .selector-meta {
    font-family: var(--mono); font-size: 11px; color: var(--ink-3);
    letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 24px;
  }
  .selector-count { color: var(--gold); font-weight: 700; transition: opacity 0.12s ease; }
  .selector-count.flicker { opacity: 0.4; }
  .selector-feed {
    background: var(--bg-2); border: 1px solid var(--line);
    border-radius: 8px; padding: 8px 0; min-height: 240px; max-height: 360px;
    overflow: hidden; position: relative; font-family: var(--mono); font-size: 12px;
  }
  .selector-feed::after {
    content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 60px;
    background: linear-gradient(to bottom, transparent, var(--bg-2));
    pointer-events: none;
  }
  @media (max-width: 640px) {
    .selector-grid { gap: 8px; }
    .selector-chip { font-size: 11px; padding: 8px 12px; }
  }
```

- [ ] **Step 5.2: Replace the `#how` section markup**

Find the existing block (lines 569–590 of the original file):

```html
<!-- HOW IT WORKS -->
<section id="how">
  <span class="label">PROTOCOL</span>
  <h2 class="h-display">Three signals. <em>Three minutes.</em><br>One unfair advantage.</h2>
  <div style="margin-top: 64px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 8px; overflow: hidden;">
    <!-- … three cards … -->
  </div>
</section>
```

Replace the whole block with:

```html
<!-- PROTOCOL — interactive platform selector -->
<section id="how">
  <span class="label">PROTOCOL</span>
  <h2 class="h-display">Pick what you want <em>watched.</em></h2>
  <p class="how-intro">Toggle a source off and the feed below stops carrying it. The selection follows you to the dashboard when you sign up.</p>

  <div class="selector-grid" role="group" aria-label="Platform selection">
    <button type="button" role="switch" aria-checked="true" class="selector-chip on" data-platform="reddit"     aria-label="Toggle Reddit">REDDIT</button>
    <button type="button" role="switch" aria-checked="true" class="selector-chip on" data-platform="hackernews" aria-label="Toggle Hacker News">HACKER NEWS</button>
    <button type="button" role="switch" aria-checked="true" class="selector-chip on" data-platform="upwork"     aria-label="Toggle Upwork">UPWORK</button>
    <button type="button" role="switch" aria-checked="true" class="selector-chip on" data-platform="fiverr"     aria-label="Toggle Fiverr">FIVERR</button>
    <button type="button" role="switch" aria-checked="true" class="selector-chip on" data-platform="quora"      aria-label="Toggle Quora">QUORA</button>
    <button type="button" role="switch" aria-checked="true" class="selector-chip on" data-platform="github"     aria-label="Toggle GitHub">GITHUB</button>
    <button type="button" role="switch" aria-checked="true" class="selector-chip on" data-platform="medium"     aria-label="Toggle Medium">MEDIUM</button>
    <button type="button" role="switch" aria-checked="true" class="selector-chip on" data-platform="substack"   aria-label="Toggle Substack">SUBSTACK</button>
    <button type="button" role="switch" aria-checked="true" class="selector-chip on" data-platform="producthunt" aria-label="Toggle Product Hunt">PRODUCT HUNT</button>
  </div>

  <div class="selector-meta">
    Watching <span class="selector-count" id="selector-count">9</span> of 9 · all plans
  </div>

  <div class="selector-feed" id="selector-feed" role="log" aria-live="off"></div>
</section>
```

- [ ] **Step 5.3: Manual verification**

Reload. The "Pick what you want watched." section renders in the slot where the 3-col grid was. All 9 chips show with the gold-bordered "on" state. The counter reads "9 of 9". The selector-feed container is visible but empty (will be filled in Task 7). Click any chip — nothing happens yet (no JS attached, expected).

Resize to 480px width: chips wrap onto multiple rows, smaller padding/font.

- [ ] **Step 5.4: Commit**

```bash
git add public/index.html
git commit -m "feat(landing): replace #how 3-col grid with platform-selector markup + CSS"
```

---

## Task 6: Platform selector — toggle behavior + counter + localStorage

**Files:**
- Modify: `public/index.html` — add a new inline `<script>` block immediately after the live-tail script from Task 4

**What we're doing:** wire up chip clicks. Each click toggles `aria-checked`, the `.on` class, updates the counter, and writes the active set to `localStorage('ebnv_landing_platform_prefs')`. On page load, if the localStorage key exists, restore the saved subset before rendering. No feed filtering yet — that's Task 7.

- [ ] **Step 6.1: Add the selector controller script**

Insert AFTER the live-tail `<script>` from Task 4 and BEFORE the existing invite-code script:

```html
<script>
(function () {
  var STORAGE_KEY = 'ebnv_landing_platform_prefs';
  var KNOWN = ['reddit','hackernews','medium','substack','quora','upwork','fiverr','github','producthunt'];

  var grid = document.querySelector('.selector-grid');
  var countEl = document.getElementById('selector-count');
  if (!grid || !countEl) return;

  var chips = Array.prototype.slice.call(grid.querySelectorAll('.selector-chip'));

  // Active set — load from localStorage if valid, else default to all KNOWN.
  var active = (function () {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return KNOWN.slice();
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return KNOWN.slice();
      var filtered = parsed.filter(function (k) { return KNOWN.indexOf(k) !== -1; });
      return filtered.length > 0 ? filtered : KNOWN.slice();
    } catch (e) { return KNOWN.slice(); }
  })();

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(active)); } catch (e) {}
  }
  function flickerCount() {
    countEl.classList.add('flicker');
    setTimeout(function () { countEl.classList.remove('flicker'); }, 120);
  }
  function render() {
    chips.forEach(function (chip) {
      var key = chip.getAttribute('data-platform');
      var isOn = active.indexOf(key) !== -1;
      chip.classList.toggle('on', isOn);
      chip.setAttribute('aria-checked', isOn ? 'true' : 'false');
    });
    countEl.textContent = String(active.length);
    flickerCount();
  }

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var key = chip.getAttribute('data-platform');
      var idx = active.indexOf(key);
      if (idx === -1) active.push(key); else active.splice(idx, 1);
      persist();
      render();
      // Fire a custom event so the selector-feed (Task 7) can react.
      window.dispatchEvent(new CustomEvent('ebnv:selection-change', { detail: { active: active.slice() } }));
    });
  });

  // Initial render reflects loaded state.
  render();
  // Expose for Task 7's feed renderer to read on init.
  window.__ebnvSelection = active;
  window.__ebnvSelectorChips = chips;
})();
</script>
```

- [ ] **Step 6.2: Manual verification — toggle**

Reload. Click `REDDIT`. The chip loses its gold border and becomes muted; counter ticks to `8`; no console errors. Click again — restores. Toggle a few; counter stays in sync.

- [ ] **Step 6.3: Manual verification — persistence**

Toggle off REDDIT, FIVERR, GITHUB (counter shows `6`). Reload the page. The same 6 chips are still selected; counter still reads `6`.

- [ ] **Step 6.4: Manual verification — keyboard**

Tab into the selector grid until a chip has focus. Hit Space — chip toggles, counter updates. Hit Enter — same. Focus ring is visible when navigating with the keyboard.

- [ ] **Step 6.5: Manual verification — defensive load**

Open DevTools → Console:

```js
localStorage.setItem('ebnv_landing_platform_prefs', '["reddit","not-a-platform","github"]');
location.reload();
```

After reload, only REDDIT and GITHUB are selected (the bogus key was filtered out). Counter shows `2`.

Now corrupt the value:

```js
localStorage.setItem('ebnv_landing_platform_prefs', 'not-json-at-all');
location.reload();
```

After reload, all 9 chips are selected (parse failure → fall back to defaults). Clean up:

```js
localStorage.removeItem('ebnv_landing_platform_prefs');
```

- [ ] **Step 6.6: Commit**

```bash
git add public/index.html
git commit -m "feat(landing): platform-selector toggle + counter + localStorage persistence"
```

---

## Task 7: Selector feed — initial render + filter + live-tail

**Files:**
- Modify: `public/index.html` — add a new inline `<script>` block after the selector controller from Task 6

**What we're doing:** populate `#selector-feed` with rows from the same pool as the hero terminal, but only those whose `src` matches an active platform. Re-renders fully when a chip toggles. Also tails on its own ~5–8 second cadence (slower than hero so the two don't visibly sync).

- [ ] **Step 7.1: Add the selector-feed renderer script**

Insert AFTER the selector controller script:

```html
<script>
(function () {
  var feed = document.getElementById('selector-feed');
  if (!feed) return;

  var pool = window.__ebnvFeedPool || [];
  if (pool.length === 0) return; // hero script didn't load

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function nowStamp() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function rowMarkup(item) {
    var titleClass = item.score >= 8 ? 'feed-title' : 'feed-title-low';
    var summary = item.summary
      ? '<span class="feed-summary">' + item.summary + '</span>'
      : '';
    return ''
      + '<div class="feed-row">'
      +   '<span class="feed-time">' + nowStamp() + '</span>'
      +   '<span class="feed-source ' + item.cls + '">' + item.src.toUpperCase().replace('PRODUCTHUNT', 'PH').replace('HACKERNEWS', 'HN') + '</span>'
      +   '<span class="' + titleClass + '">' + item.title + '</span>'
      +   '<span class="feed-score">' + item.score.toFixed(1) + '</span>'
      +   summary
      + '</div>';
  }

  function activeSet() {
    return new Set(window.__ebnvSelection || []);
  }
  function filteredPool() {
    var s = activeSet();
    return pool.filter(function (it) { return s.has(it.src); });
  }
  function renderInitial() {
    var pool2 = filteredPool();
    var pick = pool2.slice(0, 6);
    feed.innerHTML = pick.map(rowMarkup).join('');
    if (pick.length === 0) {
      feed.innerHTML = '<div style="padding:32px 14px;color:var(--ink-3);font-family:var(--mono);font-size:11px;letter-spacing:1px;text-align:center;">// NO PLATFORMS SELECTED</div>';
    }
  }

  renderInitial();

  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var smallViewport = window.matchMedia && window.matchMedia('(max-width: 480px)').matches;

  var timer = null;
  function tick() {
    if (document.hidden) return;
    var pool2 = filteredPool();
    if (pool2.length === 0) return; // selector-feed already shows the empty state
    var item = pool2[Math.floor(Math.random() * pool2.length)];
    var temp = document.createElement('div');
    temp.innerHTML = rowMarkup(item);
    var newRow = temp.firstChild;
    feed.insertBefore(newRow, feed.firstChild);
    while (feed.children.length > 6) feed.removeChild(feed.lastChild);
  }
  function schedule() {
    var delay = 5000 + Math.floor(Math.random() * 3000); // 5–8 s
    timer = setTimeout(function () { tick(); schedule(); }, delay);
  }
  if (!reducedMotion && !smallViewport) schedule();

  // Re-render fully when the selection changes.
  window.addEventListener('ebnv:selection-change', function () {
    renderInitial();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (timer) { clearTimeout(timer); timer = null; }
    } else if (!timer && !reducedMotion && !smallViewport) {
      schedule();
    }
  });
})();
</script>
```

- [ ] **Step 7.2: Manual verification — initial render**

Reload. The selector-feed container is no longer empty — it shows ~6 rows from the pool. They use the same row layout as the hero terminal.

- [ ] **Step 7.3: Manual verification — filter**

Toggle off REDDIT and HACKER NEWS. The selector-feed re-renders within one tick — no `REDDIT` or `HN` rows present. Toggle back on; their rows reappear.

Toggle ALL chips off. The selector-feed shows `// NO PLATFORMS SELECTED`. Toggle one back on; it re-renders.

- [ ] **Step 7.4: Manual verification — live tail**

Wait ~30 seconds with a partial selection. New rows append at the top of the selector-feed every 5–8 seconds. Only sources matching the active set appear. Older rows roll off (max 6 visible).

- [ ] **Step 7.5: Manual verification — pause guards**

Reduced motion + small viewport: same as hero — initial 6 render, no tailing. (Re-test only if Task 4 didn't already cover this clearly.)

- [ ] **Step 7.6: Commit**

```bash
git add public/index.html
git commit -m "feat(landing): selector feed with filter + independent live-tail"
```

---

## Task 8: Dispatch section — markup + CSS

**Files:**
- Modify: `public/index.html` (insert a new `<section id="dispatch">` between the existing pricing section's closing `</section>` and the `<div class="cta-banner">` that currently follows it; add CSS rules in the `<style>` block)

**What we're doing:** stand up the markup and styles for the Dispatch capture section. Form is non-interactive after this task — submit-handler JS lands in Task 9.

- [ ] **Step 8.1: Add Dispatch CSS**

Append the following to the `<style>` block:

```css
  /* Dispatch */
  #dispatch {
    padding: 96px 24px;
    max-width: 1280px; margin: 0 auto;
    border-top: 1px solid var(--line);
  }
  .dispatch-grid {
    display: grid; grid-template-columns: 1.1fr 1fr; gap: 64px; align-items: center;
    margin-top: 24px;
  }
  .dispatch-sub {
    color: var(--ink-2); font-size: 16px; line-height: 1.7; max-width: 520px; margin-top: 18px;
  }
  .dispatch-form { display: flex; flex-direction: column; gap: 12px; }
  .dispatch-label {
    font-family: var(--mono); font-size: 11px; color: var(--ink-3);
    letter-spacing: 2.5px; text-transform: uppercase;
  }
  .dispatch-form input[type="email"] {
    background: var(--bg-2); color: var(--ink);
    border: 1px solid var(--line); border-radius: 6px;
    padding: 14px 16px; font-family: var(--mono); font-size: 14px;
    transition: border-color 0.15s ease;
  }
  .dispatch-form input[type="email"]:focus {
    outline: none; border-color: var(--gold);
    box-shadow: inset 0 0 0 1px rgba(255,107,53,0.2);
  }
  .dispatch-form input[type="email"]:disabled { opacity: 0.5; }
  .dispatch-cta {
    background: var(--gold); color: #000; font-weight: 700;
    padding: 14px 22px; border-radius: 6px; border: none; cursor: pointer;
    font-family: var(--mono); font-size: 13px; letter-spacing: 0.5px;
    display: inline-flex; align-items: center; gap: 10px; align-self: flex-start;
    transition: background 0.15s ease, transform 0.1s ease;
  }
  .dispatch-cta:hover { background: var(--gold-2); transform: translateY(-1px); }
  .dispatch-cta:disabled { opacity: 0.6; cursor: progress; transform: none; }
  .dispatch-meta {
    font-family: var(--mono); font-size: 11px; color: var(--ink-3); letter-spacing: 0.5px;
  }
  .dispatch-error {
    font-family: var(--mono); font-size: 11px; color: var(--red); letter-spacing: 0.5px;
    margin-top: 4px;
  }
  .dispatch-success {
    font-family: var(--serif); font-size: 22px; color: var(--ink);
    line-height: 1.4;
  }
  .dispatch-success small {
    display: block; font-family: var(--mono); font-size: 11px;
    color: var(--ink-3); letter-spacing: 1px; margin-top: 8px;
  }
  @keyframes dispatch-shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-4px); }
    75% { transform: translateX(4px); }
  }
  .dispatch-form.shake { animation: dispatch-shake 0.25s ease; }
  @media (max-width: 768px) {
    #dispatch { padding: 72px 24px; }
    .dispatch-grid { grid-template-columns: 1fr; gap: 32px; }
  }
```

- [ ] **Step 8.2: Insert Dispatch section markup**

Find the existing pricing section's closing `</section>` (line 747 of original) followed immediately by `<!-- CTA BANNER -->` and `<div class="cta-banner">` (line 750). BETWEEN them, insert:

```html
<!-- DISPATCH — weekly briefing capture -->
<section id="dispatch">
  <span class="label">DISPATCH</span>
  <div class="dispatch-grid">
    <div>
      <h2 class="h-display">Not ready to run<br>your own monitor?<br><em>Read ours.</em></h2>
      <p class="dispatch-sub">A weekly briefing of buying-intent posts we caught — anonymized, with the reply that worked.</p>
    </div>
    <form class="dispatch-form" id="dispatch-form" novalidate>
      <label for="dispatch-email" class="dispatch-label">EMAIL</label>
      <input type="email" id="dispatch-email" name="email" required placeholder="you@company.com" autocomplete="email" aria-describedby="dispatch-meta">
      <button type="submit" class="dispatch-cta" id="dispatch-submit">SUBSCRIBE <span class="btn-arrow">→</span></button>
      <div class="dispatch-meta" id="dispatch-meta">Free. Tuesdays. No "boost your reach" fluff.</div>
    </form>
  </div>
</section>
```

- [ ] **Step 8.3: Manual verification**

Reload. Scroll to just above the final CTA banner — the Dispatch section renders. Two-column on desktop, single-column when narrowed below 768px. Form input focuses with a gold border. Submit button hovers to `--gold-2`. No JS yet, so submitting reloads the page (expected — we'll fix in Task 9).

- [ ] **Step 8.4: Commit**

```bash
git add public/index.html
git commit -m "feat(landing): add Dispatch capture section markup + styles"
```

---

## Task 9: Dispatch form behavior

**Files:**
- Modify: `public/index.html` — add a new inline `<script>` block after the selector-feed script

**What we're doing:** intercept submit, POST to `/v1/subscribe`, swap to success state on 200, show error + shake on failure. Defends against double-submit via the disabled state.

- [ ] **Step 9.1: Add the dispatch form script**

Insert AFTER the selector-feed `<script>` from Task 7:

```html
<script>
(function () {
  var form = document.getElementById('dispatch-form');
  if (!form) return;
  var input = document.getElementById('dispatch-email');
  var submit = document.getElementById('dispatch-submit');
  var meta = document.getElementById('dispatch-meta');

  function showError(message) {
    var existing = form.querySelector('.dispatch-error');
    if (existing) existing.remove();
    var err = document.createElement('div');
    err.className = 'dispatch-error';
    err.textContent = '⚠ ' + message;
    err.setAttribute('role', 'alert');
    form.appendChild(err);
    form.classList.remove('shake');
    void form.offsetWidth; // restart animation
    form.classList.add('shake');
  }
  function clearError() {
    var existing = form.querySelector('.dispatch-error');
    if (existing) existing.remove();
  }
  function setBusy(busy) {
    if (busy) {
      input.disabled = true;
      submit.disabled = true;
      submit.innerHTML = 'SUBSCRIBING<span style="display:inline-block;animation:dispatch-shake 0.5s infinite;">…</span>';
    } else {
      input.disabled = false;
      submit.disabled = false;
      submit.innerHTML = 'SUBSCRIBE <span class="btn-arrow">→</span>';
    }
  }
  function showSuccess() {
    form.innerHTML = ''
      + '<div class="dispatch-success" role="status">'
      +   '<span style="color:var(--green);font-family:var(--mono);font-size:14px;letter-spacing:1px;">✓ SUBSCRIBED.</span><br>'
      +   'First dispatch lands Tuesday.'
      +   '<small>Check your inbox if you don\'t see it by Wednesday.</small>'
      + '</div>';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearError();
    var email = (input.value || '').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    fetch('/v1/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, plan: 'dispatch', source: 'landing_dispatch' }),
    })
      .then(function (r) {
        if (r.status === 429) {
          throw new Error('Too many requests. Try again in a minute.');
        }
        if (!r.ok) {
          throw new Error('Subscription failed (' + r.status + '). Try again.');
        }
        return r.json();
      })
      .then(function (data) {
        if (data && data.success) showSuccess();
        else throw new Error('Unexpected response.');
      })
      .catch(function (err) {
        setBusy(false);
        showError(err.message || 'Network error. Try again.');
      });
  });
})();
</script>
```

- [ ] **Step 9.2: Manual verification — empty submit**

Reload. Click `SUBSCRIBE` with the field empty. The native validator fires (email required). No network request.

- [ ] **Step 9.3: Manual verification — invalid email**

Type `notanemail` and submit. Inline error: "Enter a valid email address." Form shakes. No network request. Clear and continue.

- [ ] **Step 9.4: Manual verification — successful submit**

Type a real email (e.g., `dispatch-test-1@example.com`) and submit. Button briefly shows `SUBSCRIBING…`, then the form swaps to the success block (`✓ SUBSCRIBED.` + "First dispatch lands Tuesday."). Open DevTools → Network — confirm the POST to `/v1/subscribe` returned 200.

- [ ] **Step 9.5: Manual verification — duplicate submit**

Reload. Submit the SAME email again. Server returns `{ success: true, already_on_waitlist: true }` → form shows the same success block. The user shouldn't notice it was a dup — that's intentional.

- [ ] **Step 9.6: Manual verification — server error simulation**

In a separate shell, stop `npm run start:api` (`Ctrl+C`). Reload the page (it'll show whatever was cached; that's fine). Submit a valid email. Network request fails → inline error appears, form shakes, stays editable. Restart `npm run start:api` to continue.

- [ ] **Step 9.7: Commit**

```bash
git add public/index.html
git commit -m "feat(landing): wire Dispatch form to /v1/subscribe with idempotent success + error states"
```

---

## Task 10: Funnel loop — dashboard pre-fill

**Files:**
- Modify: `public/dashboard.html` — find the platform-selection UI added in PR #12 and inject a small init block that reads `localStorage('ebnv_landing_platform_prefs')`.

**What we're doing:** when the visitor reached the dashboard from the landing page (with a saved platform selection), pre-tick those platforms in the new-monitor flow's chip selector. Defensively falls back to the default behavior if the key is missing or invalid.

- [ ] **Step 10.1: Locate the dashboard's new-monitor platform chip selector**

```bash
grep -n -E "platform|VALID_PLATFORMS|data-platform" public/dashboard.html | head -30
```

Identify which JS function renders the chip set for the new-monitor flow. Common patterns: a function called `renderPlatformChips`, a hardcoded array of known keys, or a list of `<button data-platform>` rendered into a parent container. Note the array of known platform keys the dashboard uses — we want to validate the localStorage value against that exact list, so they stay in lockstep.

- [ ] **Step 10.2: Add an init helper at the top of the same `<script>` block that owns the new-monitor flow**

Add this helper function near the top of the relevant `<script>`:

```js
function readLandingPlatformPrefs(known) {
  try {
    var raw = localStorage.getItem('ebnv_landing_platform_prefs');
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    var filtered = parsed.filter(function (k) { return known.indexOf(k) !== -1; });
    return filtered.length > 0 ? filtered : null;
  } catch (e) { return null; }
}
```

- [ ] **Step 10.3: Wire it into the new-monitor flow**

Where the new-monitor platform-selection UI is initialized, BEFORE the default selection is applied, add:

```js
// Honor a selection the visitor made on the landing page. Falls back to the
// existing default if nothing valid is stored.
var landingPrefs = readLandingPlatformPrefs(KNOWN_PLATFORMS); // KNOWN_PLATFORMS = the dashboard's existing platform-key array
var initialSelection = landingPrefs || DEFAULT_PLATFORMS;     // DEFAULT_PLATFORMS = whatever default the dashboard already uses
```

Substitute `KNOWN_PLATFORMS` and `DEFAULT_PLATFORMS` with the dashboard's actual variable names (found in Step 10.1). If the dashboard does not currently expose a `KNOWN_PLATFORMS` constant, add one inline that mirrors `lib/platforms.js`'s `VALID_PLATFORMS` (excluding `linkedin` per the parking note):

```js
var KNOWN_PLATFORMS = ['reddit','hackernews','medium','substack','quora','upwork','fiverr','github','producthunt','twitter'];
```

Use `initialSelection` to seed the chip-checked state. This must be a non-destructive override: if `landingPrefs` is null, the dashboard behaves exactly as before this commit.

- [ ] **Step 10.4: Manual verification — round-trip**

1. Open `http://localhost:3001/`.
2. On the platform selector, toggle so only **REDDIT, FIVERR, GITHUB, MEDIUM** are selected (counter shows `4`).
3. Click **OPEN TERMINAL** (or paste the dashboard URL — same effect since localStorage is shared).
4. On the dashboard, start the new-monitor flow.
5. The chip selector should show only those 4 pre-selected. Counter (if any) reflects 4.
6. Verify: open DevTools → Application → Local Storage. The key `ebnv_landing_platform_prefs` is still there (we don't clear it — re-running signup keeps the same selection).

- [ ] **Step 10.5: Manual verification — fallback**

```js
localStorage.removeItem('ebnv_landing_platform_prefs');
location.reload();
```

The new-monitor flow falls back to the dashboard's existing default selection. No errors.

```js
localStorage.setItem('ebnv_landing_platform_prefs', '["badkey","reddit"]');
location.reload();
```

Only `reddit` is pre-selected (bad key filtered).

```js
localStorage.setItem('ebnv_landing_platform_prefs', 'garbage');
location.reload();
```

Falls back to the default. No console errors. Clean up:

```js
localStorage.removeItem('ebnv_landing_platform_prefs');
```

- [ ] **Step 10.6: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(dashboard): honor landing-page platform selection on new-monitor flow"
```

---

## Task 11: Cross-browser + Lighthouse + breakpoint sweep

**Files:** none modified — verification only.

- [ ] **Step 11.1: Lighthouse run on landing**

In Chrome DevTools → Lighthouse:
- Run mobile audit on `http://localhost:3001/`. Note Performance, Accessibility, Best Practices, SEO scores.
- Compare against a Lighthouse run from `https://ebenova-insights-production.up.railway.app/` (current production landing).
- Required: Accessibility ≥ 90 on mobile, Performance score not worse than production by more than 5 points, no new "best practices" warnings.

If Accessibility regressed: most likely cause is a missing `aria-label` on a chip or button — re-check Task 5/8 markup.

- [ ] **Step 11.2: Breakpoint sweep**

Resize the browser (or use DevTools device toolbar) to each of: 360 px, 768 px, 1024 px, 1440 px. At each width:
- No horizontal scrollbar
- Hero stacks below the terminal preview at narrow widths (existing behavior)
- Selector chips wrap to multiple rows below 640 px
- Dispatch section stacks below 768 px
- Anatomy markers fall inline below 1024 px (per Task 2 CSS)

- [ ] **Step 11.3: Cross-browser**

Open the page in Chrome, Safari, and Firefox latest. In each:
- Hero terminal tails
- Platform selector toggles + persists
- Dispatch form submits and shows the success state
- No console errors

- [ ] **Step 11.4: No commit (verification only)**

If anything fails, fix in a follow-up commit on this branch with a message like `fix(landing): correct <issue> at <breakpoint>` and re-run the affected verification.

---

## Task 12: Push branch + open PR

**Files:** none modified — git operations only.

- [ ] **Step 12.1: Confirm branch is up-to-date and pushed**

```bash
git push 2>&1 | tail -5
```

If the branch was created locally during pre-flight without an upstream, run `git push -u origin <branch>` instead.

- [ ] **Step 12.2: Open the PR**

Use the existing PR template via `gh`:

```bash
gh pr create --base main --head $(git branch --show-current) --title "feat(landing): editorial polish + platform-selector + Dispatch capture" --body "$(cat <<'EOF'
## Summary
- Removes AI-template tells from the marketing landing page (background gradient blobs, generic 3-col "how it works" grid)
- Adds an interactive platform-selector marketing block in the slot the 3-col grid used to occupy — visitors toggle the 9 sources and watch a live-tailed mock feed reflect their selection
- Adds a Dispatch (curated weekly briefing) capture section between Pricing and the final CTA banner; submits to the existing /v1/subscribe endpoint
- Funnel loop: the visitor's platform selection persists to localStorage and pre-fills the new-monitor flow on the dashboard
- Hero terminal now actually tails (was static rows with animation-delays); pauses on tab-hidden, prefers-reduced-motion, and viewports below 480px
- Anatomy section markers gain gold connector lines + a fourth INTENT callout
- Adds a global prefers-reduced-motion guard

## Out of scope (intentional)
- No global token refactor; existing orange/Crimson/JetBrains-Mono identity preserved
- Dashboard is unchanged except for the ~10-line localStorage read
- Twitter is excluded from the marketing claim until prod creds are verified working

## Test plan
- [ ] Spec acceptance criteria from docs/superpowers/specs/2026-04-29-landing-editorial-polish-design.md "Testing" section, items 1–8, all pass on localhost:3001
- [ ] Lighthouse mobile: Accessibility ≥ 90, Performance not regressed > 5 points vs production
- [ ] Cross-browser: Chrome, Safari, Firefox latest
- [ ] Breakpoints render cleanly at 360 / 768 / 1024 / 1440

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 12.3: Verify the PR opens, link it back to the user**

`gh` prints the PR URL. Confirm it loads in the browser. Done.

---

## Self-review checklist (run before handing the plan off)

- [x] **Spec coverage:** every section of the spec has a corresponding task — Globals (Task 1), Anatomy (Task 2), Hero live-tail (Tasks 3+4), `#how` replacement (Tasks 5+6+7), Dispatch (Tasks 8+9), Funnel loop (Task 10), verification (Task 11), shipping (Task 12). ✓
- [x] **Placeholder scan:** no TBDs, all code blocks complete, error-handling paths shown explicitly. ✓
- [x] **Type/name consistency:** localStorage key `ebnv_landing_platform_prefs` consistent across landing + dashboard. Custom event name `ebnv:selection-change` used by both Task 6 emitter and Task 7 listener. Pool reference `window.__ebnvFeedPool` exposed in Task 4 and consumed in Task 7. ✓
- [x] **Dependencies between tasks:** linear order. Tasks 1–2 are independent of each other; 3 must precede 4; 5 must precede 6 must precede 7; 8 must precede 9; 10 is independent of 1–9 but easier to verify last; 11–12 are gates. Following the order top-to-bottom is safe. ✓
