# Mobile Responsive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both `public/index.html` (landing page) and `public/dashboard.html` (app) usable on mobile phones via a shared `public/mobile.css` file and two small React components.

**Architecture:** A new `public/mobile.css` file contains all `@media (max-width: 768px)` and `@media (max-width: 480px)` overrides for both pages. The dashboard gets two new React components (`MobileTopBar`, `MobileBottomNav`) defined inline in `dashboard.html` and rendered inside the existing `App` component. The landing page already has a 900px breakpoint; mobile.css refines the remaining gaps at 768px and 480px.

**Tech Stack:** Vanilla CSS media queries, React 18 (JSX via Babel CDN, already in use), Phosphor Icons (already loaded in dashboard.html).

---

## File Map

| File | Action | What changes |
| ---- | ------ | ------------ |
| `public/mobile.css` | **Create** | All mobile media query overrides for both pages |
| `public/index.html` | **Modify** | Add `<link>` to mobile.css in `<head>` |
| `public/dashboard.html` | **Modify** | Add `<link>` to mobile.css; add `MobileTopBar` and `MobileBottomNav` React components; update `App` render |

---

## Task 1: Create mobile.css and link from both HTML files

**Files:**
- Create: `public/mobile.css`
- Modify: `public/index.html` (add link tag in `<head>`, line ~9 after the Google Fonts link)
- Modify: `public/dashboard.html` (add link tag in `<head>`, line ~13 after the Babel script tag)

- [ ] **Step 1: Create `public/mobile.css` with section skeleton**

```css
/* =============================================================
   EBENOVA — mobile.css
   Overrides for ≤768px (phones) and ≤480px (small phones)
   Applies to both index.html and dashboard.html
   ============================================================= */

/* ── Dashboard-only elements (hidden on desktop via these rules) ── */
.mob-top-bar    { display: none; }
.mob-bottom-nav { display: none; }

/* ── 768px breakpoint ── */
@media (max-width: 768px) {

  /* LANDING -------------------------------------------------- */

  /* Hero title too large at narrow widths (base is clamp(48px,...)) */
  .hero-title { font-size: clamp(32px, 9vw, 52px) !important; }

  /* Footer: stack logo + links vertically */
  footer { flex-direction: column; gap: 16px; text-align: center; }
  footer .right { justify-content: center; }

  /* Ticker: clip overflow so it never causes horizontal scroll */
  .ticker-bar { overflow: hidden; }

  /* DASHBOARD ----------------------------------------------- */

  /* Hide desktop sidebar */
  .sidebar { display: none !important; }

  /* Main content: remove left margin left by sidebar */
  .main { margin-left: 0 !important; padding-bottom: 72px; }

  /* Mobile top bar (rendered by MobileTopBar component) */
  .mob-top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    height: 48px;
    background: #0F172A;
    position: sticky;
    top: 0;
    z-index: 90;
    flex-shrink: 0;
    border-bottom: 1px solid #1E293B;
  }
  .mob-top-title {
    color: #F8FAFC;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.3px;
  }

  /* Mobile bottom nav (rendered by MobileBottomNav component) */
  .mob-bottom-nav {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 60px;
    background: #0F172A;
    border-top: 1px solid #1E293B;
    z-index: 200;
    justify-content: space-around;
    align-items: stretch;
  }
  .mob-tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    background: none;
    border: none;
    cursor: pointer;
    color: #64748B;
    font-size: 10px;
    font-weight: 600;
    font-family: inherit;
    min-height: 44px;
    transition: color 0.15s;
  }
  .mob-tab i { font-size: 18px; }
  .mob-tab.active { color: #FF6B35; }

  /* More sheet overlay + panel */
  .mob-more-overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.6);
    z-index: 300;
    display: flex;
    align-items: flex-end;
  }
  .mob-more-sheet {
    background: #fff;
    border-radius: 16px 16px 0 0;
    padding: 0 0 32px;
    width: 100%;
  }
  .mob-more-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid #F1F5F9;
    font-size: 15px;
    font-weight: 700;
    color: #0F172A;
  }
  .mob-more-close {
    background: none;
    border: none;
    font-size: 20px;
    cursor: pointer;
    color: #94A3B8;
    padding: 4px 8px;
    border-radius: 6px;
    line-height: 1;
  }
  .mob-more-item {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    padding: 16px 20px;
    background: none;
    border: none;
    border-bottom: 1px solid #F8FAFC;
    cursor: pointer;
    font-size: 15px;
    font-weight: 500;
    color: #0F172A;
    font-family: inherit;
    text-align: left;
    min-height: 52px;
  }
  .mob-more-item i { font-size: 18px; color: #64748B; }
  .mob-more-item:active { background: #F8FAFC; }

  /* Content padding */
  .page-header { padding: 14px 16px !important; }
  .page-body   { padding: 14px 16px !important; }

  /* Full-width cards */
  .card { width: 100% !important; max-width: 100% !important; }

  /* Match/result cards: wrap badge rows, full-width action buttons */
  .result-card { padding: 14px 14px; }
  .result-card > div[style*="flex"] { flex-wrap: wrap; }

  /* Inputs: font-size 16px prevents iOS auto-zoom on focus */
  input.inp, select.inp, textarea.inp { font-size: 16px !important; min-height: 44px; }
  .btn { min-height: 44px; }
  .btn-sm { min-height: 38px; }

  /* Tables: horizontal scroll instead of breaking layout */
  .card table, table.data-table {
    display: block;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
}

/* ── 480px breakpoint (small phones) ── */
@media (max-width: 480px) {

  /* LANDING */
  section          { padding: 40px 16px !important; }
  .hero            { padding: 32px 16px !important; }
  .hero-title      { font-size: clamp(28px, 9vw, 38px) !important; }
  .hero-sub        { font-size: 15px; }
  .price-card      { padding: 22px 16px; }
  .compare-col     { padding: 22px 16px; }
  .pricing-grid    { gap: 10px; }
  #dispatch        { padding: 40px 16px !important; }
  .cta-banner      { padding: 32px 16px; }

  /* DASHBOARD */
  .page-header { padding: 12px 14px !important; }
  .page-body   { padding: 12px 14px !important; }
}
```

- [ ] **Step 2: Add link to `index.html`**

In `public/index.html`, find the line:
```html
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono...
```
Add immediately after the closing `</style>` tag and before `</head>` (line ~552):
```html
<link rel="stylesheet" href="/mobile.css">
```

- [ ] **Step 3: Add link to `dashboard.html`**

In `public/dashboard.html`, find line 13:
```html
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
```
Add immediately after it:
```html
<link rel="stylesheet" href="/mobile.css">
```

- [ ] **Step 4: Smoke-test at 375px in browser DevTools**

Open `http://localhost:3000` (or the local dev server) in Chrome. Open DevTools → toggle device toolbar → set to 375px width. Verify no horizontal scroll on landing page. Verify dashboard sidebar is hidden (dashboard is in React, so the component renders first — this just confirms CSS loads).

- [ ] **Step 5: Commit**

```bash
git add public/mobile.css public/index.html public/dashboard.html
git commit -m "feat(mobile): add mobile.css + link from both HTML pages"
```

---

## Task 2: Dashboard — add MobileTopBar and MobileBottomNav React components

**Files:**
- Modify: `public/dashboard.html` (add 2 components before line 779, update App render at lines 4122–4130)

The dashboard uses React 18 with Babel JSX transpilation. Both components go in the same `<script type="text/babel">` block, before the existing `Sidebar` function at line 779.

- [ ] **Step 1: Add `MobileTopBar` component before the `Sidebar` function (line 779)**

Find the line:
```js
function Sidebar({ tab, setTab, userEmail, plan, monitorCount, draftCount, onSignOut, onHelp, onTour }) {
```

Insert immediately before it:
```jsx
function MobileTopBar({ tab }) {
  const titles = {
    find: 'Find Customers',
    feed: 'Monitor Feed',
    drafts: 'Drafts',
    settings: 'Settings',
  };
  return (
    <div className="mob-top-bar">
      <span className="mob-top-title">{titles[tab] || 'Ebenova'}</span>
    </div>
  );
}
```

- [ ] **Step 2: Add `MobileBottomNav` component immediately after `MobileTopBar`**

Insert immediately after the `MobileTopBar` closing brace:
```jsx
function MobileBottomNav({ tab, setTab, onHelp, onSignOut }) {
  const [showMore, setShowMore] = React.useState(false);
  const tabs = [
    { id: 'find',     icon: 'ph-magnifying-glass-plus', label: 'Monitors' },
    { id: 'feed',     icon: 'ph-newspaper',             label: 'Feed'     },
    { id: 'settings', icon: 'ph-gear',                  label: 'Settings' },
  ];
  return (
    <>
      <nav className="mob-bottom-nav">
        {tabs.map(({ id, icon, label }) => (
          <button
            key={id}
            className={`mob-tab${tab === id ? ' active' : ''}`}
            onClick={() => { setTab(id); setShowMore(false); }}
          >
            <i className={`ph-bold ${icon}`}></i>
            <span>{label}</span>
          </button>
        ))}
        <button
          className={`mob-tab${showMore ? ' active' : ''}`}
          onClick={() => setShowMore(s => !s)}
        >
          <i className="ph-bold ph-dots-three-outline"></i>
          <span>More</span>
        </button>
      </nav>
      {showMore && (
        <div className="mob-more-overlay" onClick={() => setShowMore(false)}>
          <div className="mob-more-sheet" onClick={e => e.stopPropagation()}>
            <div className="mob-more-header">
              <span>More</span>
              <button className="mob-more-close" onClick={() => setShowMore(false)}>✕</button>
            </div>
            <button className="mob-more-item" onClick={() => { setTab('drafts'); setShowMore(false); }}>
              <i className="ph-bold ph-pencil-line"></i>
              Drafts
            </button>
            <button className="mob-more-item" onClick={() => { onHelp(); setShowMore(false); }}>
              <i className="ph-bold ph-question"></i>
              Help Guide
            </button>
            <button className="mob-more-item" onClick={onSignOut}>
              <i className="ph-bold ph-sign-out"></i>
              Sign Out
            </button>
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: Update the App render to include the two new components**

Find the current App render block (lines 4122–4130):
```jsx
      <Sidebar tab={tab} setTab={setTab} userEmail={userEmail} plan={plan} monitorCount={monitors.length} draftCount={draftCount} onSignOut={signOut} onHelp={() => setShowHelp(true)} onTour={() => setShowTour(true)} />
      <FeedbackWidget apiKey={apiKey} />
      <div className="main">
        {tab==='find'     && <FindCustomers apiKey={apiKey} onMonitorCreated={()=>{ loadMonitors(); setTab('feed'); }} />}
        {tab==='feed'     && <MatchesFeed apiKey={apiKey} monitors={monitors} />}
        {tab==='drafts'   && <DraftsFeed apiKey={apiKey} monitors={monitors} onDraftCount={setDraftCount} />}
        {tab==='settings' && <Settings apiKey={apiKey} userEmail={userEmail} plan={plan} onSignOut={signOut} monitors={monitors} onRefresh={loadMonitors} />}
      </div>
```

Replace with:
```jsx
      <MobileTopBar tab={tab} />
      <Sidebar tab={tab} setTab={setTab} userEmail={userEmail} plan={plan} monitorCount={monitors.length} draftCount={draftCount} onSignOut={signOut} onHelp={() => setShowHelp(true)} onTour={() => setShowTour(true)} />
      <FeedbackWidget apiKey={apiKey} />
      <div className="main">
        {tab==='find'     && <FindCustomers apiKey={apiKey} onMonitorCreated={()=>{ loadMonitors(); setTab('feed'); }} />}
        {tab==='feed'     && <MatchesFeed apiKey={apiKey} monitors={monitors} />}
        {tab==='drafts'   && <DraftsFeed apiKey={apiKey} monitors={monitors} onDraftCount={setDraftCount} />}
        {tab==='settings' && <Settings apiKey={apiKey} userEmail={userEmail} plan={plan} onSignOut={signOut} monitors={monitors} onRefresh={loadMonitors} />}
      </div>
      <MobileBottomNav tab={tab} setTab={setTab} onHelp={() => setShowHelp(true)} onSignOut={signOut} />
```

- [ ] **Step 4: Default to Feed tab on mobile**

The `App` component starts on `'find'` (`useState('find')`). On mobile, Feed should be the default per spec.

Find in `public/dashboard.html` the App component's `useEffect` block that runs on mount (around line 4090):
```js
  useEffect(()=>{
    if (!apiKey) return;
    loadMonitors();
```

Add a mobile-default check at the start of the App function body, after `const [tab, setTab] = useState('find');` (line 4072):
```js
  // Default to feed on mobile so users see matches first
  useEffect(() => {
    if (window.innerWidth <= 768) setTab('feed');
  }, []);
```

- [ ] **Step 5: Verify in browser at 375px**

Open `/dashboard` at 375px width in DevTools. Confirm:
- Sidebar is hidden
- Dark top bar appears showing the current section name
- Bottom nav shows Monitors / Feed / Settings / More tabs
- Tapping a tab switches the main content
- Tapping More opens the sheet
- Tapping outside the sheet or ✕ closes it

- [ ] **Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(mobile): add MobileTopBar + MobileBottomNav components to dashboard"
```

> **Note — out of scope for this plan:** The spec mentions match detail panels opening as full-screen overlays. The current `MatchCard` component renders inline (`.result-card`), not as a separate navigable view. Implementing a full-screen detail overlay would require significant React refactoring (new route or modal state per card) and is deferred to a future PR.

---

## Task 3: Landing page — verify and fix remaining mobile gaps

**Files:**
- Modify: `public/mobile.css` (already created in Task 1 — verify rules cover all gaps)
- Modify: `public/index.html` (wrap comparison table in scroll container)

The landing page already has a `@media (max-width: 900px)` block inside `index.html` that handles: hero stacking, nav links hidden, pricing stacking, anatomy stacking, section padding reduction, CTA button stacking. The `mobile.css` refines what 900px misses.

- [ ] **Step 1: Wrap the comparison section in a scroll container**

The `.compare` grid already collapses to 1 column at 900px. Nothing to change structurally. However the `feed-row` grid inside the hero terminal (`grid-template-columns: 70px 60px 1fr auto`) can overflow at 320px. Add this rule to the `@media (max-width: 480px)` block in `mobile.css`:

```css
  /* Terminal feed rows: tighten columns for very small screens */
  .feed-row {
    grid-template-columns: 56px 48px 1fr auto;
    font-size: 10.5px;
    gap: 8px;
  }
```

- [ ] **Step 2: Test landing page at 375px and 320px in DevTools**

Check:
- No horizontal scrollbar at 375px
- Hero title is readable (not huge, not tiny)
- Pricing cards stack vertically, all text readable
- Footer stacks cleanly (two rows: copyright | links)
- Ticker bar doesn't cause overflow

- [ ] **Step 3: Fix any remaining overflows found in Step 2**

If DevTools shows any element causing `overflow-x`, add `overflow: hidden` or `max-width: 100%` to the offending class in `mobile.css`. Common culprits: `pre`, code blocks with long lines, fixed-width flex children.

- [ ] **Step 4: Commit**

```bash
git add public/mobile.css
git commit -m "feat(mobile): fix landing page overflow at 320-480px"
```

---

## Task 4: Cross-browser check and final polish

**Files:**
- Modify: `public/mobile.css` (any fixes found during testing)

- [ ] **Step 1: Test on iOS Safari (or simulator)**

Key iOS-specific issues to check:
- `position: sticky` on `.mob-top-bar` — Safari requires `-webkit-sticky` for older versions. Add:
  ```css
  .mob-top-bar { position: -webkit-sticky; position: sticky; }
  ```
  Add this to the `.mob-top-bar` block in `mobile.css`.

- Tap highlight: add to `mobile.css` inside `@media (max-width: 768px)`:
  ```css
  .mob-tab, .mob-more-item { -webkit-tap-highlight-color: transparent; }
  ```

- [ ] **Step 2: Verify `font-size: 16px` on inputs prevents iOS zoom**

On iOS, any `input` with `font-size < 16px` triggers auto-zoom on focus. Confirm `input.inp` override in `mobile.css` is present:
```css
input.inp, select.inp, textarea.inp { font-size: 16px !important; min-height: 44px; }
```
This is already in Task 1's mobile.css — just verify it wasn't accidentally removed.

- [ ] **Step 3: Test the More sheet scroll on short phones (iPhone SE = 667px tall)**

On very short phones, the More sheet may overlap the bottom nav or get cut off. If this happens, add `max-height: 60vh; overflow-y: auto` to `.mob-more-sheet` in `mobile.css`.

- [ ] **Step 4: Commit any fixes**

```bash
git add public/mobile.css
git commit -m "fix(mobile): iOS Safari sticky + tap highlight fixes"
```

---

## Task 5: Push branch and open PR

- [ ] **Step 1: Run tests to confirm nothing broken**

```bash
npm test
```

Expected: same test count as baseline (mobile changes are CSS/HTML only, no server logic touched).

- [ ] **Step 2: Push branch**

```bash
git push -u origin feat/usage-stats
```

- [ ] **Step 3: Open PR**

```bash
gh pr create \
  --title "feat(mobile): responsive layout for dashboard + landing page" \
  --body "## Summary
- New \`public/mobile.css\` — shared mobile overrides for both pages (768px + 480px breakpoints)
- Dashboard: sidebar hidden on mobile, replaced by sticky top bar + fixed bottom tab nav (Monitors / Feed / Settings / More)
- More sheet: slide-up panel with Drafts, Help, Sign Out
- Landing page: hero title clamp fixed for small phones, footer stacks, ticker overflow prevented
- All tap targets ≥44px, inputs set to 16px to prevent iOS auto-zoom

## Test plan
- [ ] Dashboard at 375px (iPhone SE): sidebar hidden, bottom nav present, all 4 tabs switch correctly
- [ ] Dashboard at 375px: More sheet opens/closes, Drafts/Help/Sign Out work
- [ ] Landing page at 375px: no horizontal scroll, hero title readable, pricing cards stacked
- [ ] Landing page at 320px: feed rows don't overflow, footer stacks
- [ ] Desktop (1280px): no regression — sidebar visible, bottom nav hidden, landing unchanged
- [ ] iOS Safari: sticky top bar works, no input zoom on focus

## Schema impact
None — CSS/HTML only changes."
```
