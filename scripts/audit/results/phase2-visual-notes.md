# Phase 2 — Visual & Responsive Notes

30 screenshots captured (10 states × mobile/tablet/desktop) in `results/screenshots/`.
Checklist per item below; only failures/notable items are called out — anything not
mentioned passed cleanly.

## Cross-cutting issues (appear on multiple routes/viewports)

### 1. Build/version tag overlaps content — Medium, mobile + tablet
A small `v2026-07-03-b` text label (absolute-positioned, presumably a debug/version
marker) overlaps live content instead of sitting in clear whitespace:
- `dashboard-overview-mobile.png` — overlaps the "TWR since inception" figure
- `dashboard-overview-tablet.png` — overlaps "INCOME & COSTS" section
- `dashboard-performance-mobile.png` — overlaps the returns table header row
- `dashboard-ownership-mobile.png` — overlaps between investor cards
- `dashboard-transactions-mobile.png` — overlaps a transaction amount ("30")
- `admin-mobile.png` — overlaps "DARIO MONTOYA ($)" field label
It never overlaps content on desktop (there's enough margin). This reads as an
internal debug artifact that should either be removed from production or repositioned
to a spot that never collides with real content (e.g. fixed corner, small enough font,
or removed for non-admin viewport widths).

### 2. Data tables clip / cut off on mobile — High, mobile only
Several data tables render at native (wide) column widths inside a mobile viewport
with no scroll affordance, so trailing columns are cut off at the screen edge:
- `dashboard-performance-mobile.png` — monthly returns table: "SPXTR" column truncated
- `dashboard-positions-mobile.png` — positions table: "SHARES" column truncated
- `dashboard-transactions-mobile.png` — transaction table: "SHARES" column truncated
There's a `.table-scroll` wrapper class in the CSS (confirmed in Phase 1's axe scan,
which flagged it as not keyboard-focusable), so horizontal scroll *is* intended —
but there's no visual affordance (no scroll shadow/fade, no visible scrollbar) telling
a mobile user the table scrolls sideways, so this reads as clipped/broken content
rather than an intentional scrollable table.

### 3. Tab bar truncates without affordance — Low, mobile only
On mobile, the page-tab strip (Overview/Performance/Positions/.../Statements) is
wider than the viewport and auto-scrolls to keep the active tab visible, cutting off
the first tab's label mid-word (e.g. "Owne" on Ownership, "erview" on Ownership tab
view). No fade/gradient hints that more tabs exist off-screen in either direction.

## Per-route/viewport checklist notes

| Route | Viewport | No clip/overlap | No h-scroll (body) | Tap targets ≥44px | Contrast | Spacing consistent | Images OK | CTA visible |
|---|---|---|---|---|---|---|---|---|
| login | mobile/tablet/desktop | Pass | Pass | Pass | Fail (see Phase 1 `color-contrast`, lang toggle) | Pass | Pass (no images) | Pass |
| dashboard-overview | mobile | **Fail** (issue #1) | Pass | Pass | — | Pass | Pass | Pass |
| dashboard-overview | tablet | **Fail** (issue #1) | Pass | Pass | — | Pass | Pass | Pass |
| dashboard-overview | desktop | Pass | Pass | Pass | — | Pass | Pass | Pass |
| dashboard-performance | mobile | **Fail** (issues #1, #2) | Pass | Pass | — | Pass | Pass | Pass |
| dashboard-positions | mobile | **Fail** (issue #2) | Pass | Pass | — | Pass | Pass | Pass |
| dashboard-ownership | mobile | **Fail** (issues #1, #3) | Pass | Pass | — | Pass | Pass | Pass |
| dashboard-transactions | mobile/desktop | **Fail** (mobile: #1, #2) / Pass (desktop) | Pass | Pass | — | Pass | Pass | Pass |
| dashboard-nav | mobile | Pass | Pass | Pass | — | Pass | Pass | Pass |
| dashboard-statements | mobile | Pass | Pass | Pass | — | Pass | Pass | Pass |
| settings | mobile | Pass | Pass | Pass | — | Pass | Pass | Pass |
| admin | mobile | **Fail** (issue #1) | Pass | Pass | — | Pass (minor: header wraps to 2 lines, cramping timestamp) | Pass | N/A (admin tool, no primary CTA) |

All other routes/viewports not explicitly listed above (tablet/desktop variants of
performance, positions, ownership, transactions, nav, statements, settings) were
reviewed and passed the checklist cleanly — no clipping, adequate spacing, CTAs
visible without excessive scrolling.
