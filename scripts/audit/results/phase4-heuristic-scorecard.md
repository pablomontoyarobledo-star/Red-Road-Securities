# Phase 4 — Nielsen Heuristic Scorecard

Scale: 1 (poor) – 5 (excellent). Every score cites specific evidence from Phases 1–3.

| # | Heuristic | Score | Evidence |
|---|---|---|---|
| 1 | Visibility of system status | 3/5 | Good in principle — "Live prices as of 10:42 PM" and "Updated 10:42 PM" timestamps appear on Overview (`dashboard-overview-desktop.png`). But the USD/COP rate card claims to be "Updated" while its underlying fetch is silently blocked by CORS (`phase1-summary.md` §1c, finding #3) — the UI reports a status that isn't true, which is worse than showing no status at all. |
| 2 | Match between system and real world | 4/5 | Financial terminology (NAV, TWR, MTD/QTD/YTD) is used correctly for an investor audience, and the Statements tab explains each document in plain language ("Account Summary — Current value, month start value, change in dollars and %") — `dashboard-statements-mobile.png`. |
| 3 | User control and freedom | 4/5 | Clear "Back to dashboard" (admin/settings) and "Sign out" always visible in the top bar across all authenticated views (`dashboard-overview-desktop.png`, `admin-mobile.png`). Language toggle is reachable from every screen. |
| 4 | Consistency and standards | 3/5 | Card layout, color coding (green=positive/red=negative), and nav placement are consistent across all 8 dashboard tabs. Docked by the stray `v2026-07-03-b` version tag that appears in inconsistent positions and overlaps content on 6 of 10 mobile/tablet screenshots (`phase2-visual-notes.md` issue #1). |
| 5 | Error prevention | 3/5 | Login correctly refuses to proceed on empty fields without side effects (`phase3-flow-report.md`, "empty fields" test). No visible client-side validation messaging on the Admin deposit form was verified, since that form was intentionally not exercised to avoid writing production data — flagged as **not fully audited**. |
| 6 | Recognition rather than recall | 4/5 | Persistent investor badge ("Pablo Montoya — Manager") and always-visible tab bar mean the user never has to remember where they are or who they're logged in as (`dashboard-overview-desktop.png`). |
| 7 | Flexibility and efficiency of use | 4/5 | Transaction/deposit tables offer type filters (All/Buys/Sells/Dividends) and month/year filters (`dashboard-transactions-desktop.png`, `dashboard-ownership-mobile.png`), letting frequent users narrow data quickly. |
| 8 | Aesthetic and minimalist design | 3/5 | Desktop layouts are clean and well-spaced (`dashboard-overview-desktop.png`). Score is pulled down by two mobile-specific issues: the version-tag overlap (issue #1) and unindicated horizontally-clipped tables (issue #2), both in `phase2-visual-notes.md`. |
| 9 | Help users recognize, diagnose, and recover from errors | 2/5 | The one user-facing error (wrong password) is handled well — clear, visible message (`phase3-flow-report.md`). But two real errors are completely invisible to the user: the `populateAdminFields` TypeError on every login, and the FX-rate CORS failure that leaves COP conversion silently stale (`phase1-summary.md` §1c). A user has no way to know the displayed COP rate might be wrong. |
| 10 | Help and documentation | 3/5 | Contextual help exists exactly where it's most needed (the Statements "what's included" explainer, `dashboard-statements-mobile.png`), but there's no help/FAQ elsewhere in the app (no tooltips explaining TWR, NAV per unit, etc. outside that one section). |

**Average: 3.3 / 5**

Lowest-scoring heuristics (#9, #1, #4, #5, #8) all trace back to the same handful of
root issues documented in Phases 1–2: two silently-swallowed JS/network errors, and
a stray debug element clipping into mobile/tablet layouts. Fixing those few things
would lift several heuristic scores at once rather than being isolated one-off fixes.
