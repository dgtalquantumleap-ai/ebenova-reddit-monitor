# Mobile Responsive Design

**Date:** 2026-05-06
**Scope:** `public/index.html` (landing page) + `public/dashboard.html` (app dashboard)
**Trigger:** User feedback — mobile users struggling with layout on phones

---

## Approach

Separate `public/mobile.css` file linked from both HTML files, containing all `@media (max-width: 768px)` overrides. No new npm packages. No build step changes. A small inline JS block added to `dashboard.html` for bottom nav interactivity.

---

## Dashboard Changes

### Layout

- Fixed 236px left sidebar is hidden at ≤768px via `display: none`
- A **slim top bar** (height ~48px, background `#0F172A`) replaces it — shows current section name on the left, contextual action button on the right. Button per section: Monitors → "+ New Monitor"; Feed → filter icon; Settings → none; More → none
- A **bottom tab bar** (height ~56px, background `#0F172A`) is added as a fixed element at the bottom of the viewport

### Bottom Tab Bar

Four tabs, in order:

| Tab      | Icon | Section                    |
| -------- | ---- | -------------------------- |
| Monitors | 📡   | Monitors list              |
| Feed     | 📬   | Live feed / matches        |
| Settings | ⚙️   | Monitor + account settings |
| More     | •••  | Slide-up sheet             |

- Active tab highlighted in `#FF6B35`
- Minimum tap target: 44px height per tab
- Feed is the **default active tab** when arriving on mobile

### More Sheet

Tapping "More" opens a slide-up sheet (semi-transparent dark overlay + white/navy panel from bottom) containing:

- Help / product guide
- Billing & plan
- Profile
- Logout

Sheet dismisses on tap outside the panel or via an explicit "✕" close button in the top-right of the sheet. No swipe gesture (avoids vanilla JS complexity).

### Content Area

- Cards go full-width (`width: 100%`, remove any fixed or percentage widths)
- Match detail / reply draft panels open as a full-screen overlay (100vw × 100vh) with a back button top-left
- Horizontal-overflow tables get `overflow-x: auto` wrapper
- All interactive elements (buttons, inputs, dropdowns) minimum 44px height
- Font sizes: headings reduce by ~2px, body text stays at 14px minimum
- Padding tightened: section padding 16px (from 24-32px on desktop)

### JS additions (inline in dashboard.html)

- `showTab(name)` — updates active tab highlight, shows/hides section content
- `toggleMoreSheet()` — opens/closes the slide-up More sheet
- Both are pure vanilla JS, no new dependencies

---

## Landing Page Changes (`index.html`)

### Navigation

- At ≤768px: hide all nav links, show only logo + "Get started" CTA button
- CTA button stays full-width-friendly (min-width removed)

### Hero Section

- Two-column grid (copy left, terminal demo right) collapses to single column
- Order: copy first, terminal demo below
- Hero heading font size reduces: `clamp(2rem, 8vw, 3.5rem)`
- CTA buttons stack vertically on mobile

### Pricing Section

- Three-column card grid stacks to single column
- Each card full-width
- Growth (recommended) card stays visually highlighted

### Comparison Table

- Wrap in `overflow-x: auto` container
- Table itself keeps its structure — just becomes swipeable

### How It Works / Anatomy / Other Sections

- Multi-column layouts collapse to single column
- Section padding reduces to 40px vertical (from 80px)
- Platform selector tabs wrap or scroll horizontally

### Ticker Bar

- Reduce animation speed on mobile (less distracting)
- Ensure it doesn't cause horizontal overflow

---

## File Plan

| File                     | Change                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `public/mobile.css`      | New file — all media query overrides for both pages                                                                                          |
| `public/index.html`      | Add `<link rel="stylesheet" href="/mobile.css">` in `<head>`                                                                                 |
| `public/dashboard.html`  | Add `<link rel="stylesheet" href="/mobile.css">` in `<head>`; add bottom tab bar HTML; add More sheet HTML; add small inline JS toggle block |

---

## Breakpoints

| Breakpoint | Target |
| ---------- | ------ |
| `≤768px` | Primary mobile breakpoint (phones + small tablets) |
| `≤480px` | Secondary, tighten padding further for small phones |

---

## Out of Scope

- Tablet-specific layout (768px–1024px) — existing desktop layout degrades acceptably
- Dark mode
- PWA / add-to-homescreen
- Animation polish on the More sheet (basic show/hide is sufficient)
