# UX Audit Report — Red Road Securities Investor Portal

**Date:** 2026-07-31
**Scope:** Production app at https://red-road-securities.vercel.app — a single-page,
password-gated investor portal (`index.html`, ~270KB, no client-side router).
Audited as one public "route" (login) plus 8 authenticated dashboard tabs, a
Settings screen, and an Admin screen, reached via in-app JS state rather than URLs.
Logged in as an admin investor account for the authenticated portion.

**Not audited:** the Admin → "Log deposit" write flow was excluded on purpose to
avoid inserting real records into the production financial database (see Phase 3
report). Local `vercel dev` testing wasn't possible because the linked Vercel
"development" environment has no database credentials configured (see Phase 0/1).

Full evidence trail: `scripts/audit/results/` (Lighthouse/axe/health-check JSON,
30 screenshots, Playwright flow results) and phase reports `phase1`–`phase4`.

---

## 1. Executive summary

The portal's core experience — logging in, reading fund performance, downloading
statements — works reliably and looks clean on desktop. The problems are concentrated
in a few specific, fixable spots rather than being spread evenly across the app:

**Top 5 issues by impact:**
1. **Login page loads slowly (Lighthouse Performance 58/100, LCP 7.7s)** — caused by
   an 845KB icon webfont and PDF/chart libraries loading before the login form is
   even usable, on the very first screen every investor sees.
2. **The FX (USD→COP) exchange rate is silently broken** — blocked by CORS on every
   session, but the UI still displays "Updated [time]" as if it succeeded, misleading
   any investor viewing values in COP.
3. **A JS error fires on every single login** (`populateAdminFields` TypeError) —
   silently swallowed, but it means whatever that function was supposed to populate
   never happens.
4. **Data tables are unusable on mobile** — Performance, Positions, and Transactions
   tables cut off their rightmost column(s) with no visual hint that they scroll
   sideways.
5. **A stray debug/version tag overlaps real content** on 6 of 10 mobile/tablet
   screens (e.g. covering the TWR figure, a field label, a transaction amount).

None of these are "the app is broken" — they're all things a focused fix session
would clear in a day or two.

---

## 2. Scorecard

### Lighthouse (login screen only — see note in Phase 1 on why authenticated states aren't Lighthouse-scored)
| Category | Score | Threshold | Status |
|---|---|---|---|
| Performance | 58 | 80 | FLAG |
| Accessibility | 88 | 90 | FLAG |
| Best Practices | 96 | 90 | Pass |
| SEO | 90 | 90 | Pass |

### Accessibility (axe-core) violation counts across all 10 states
| Severity | Count (distinct issue types) | States affected |
|---|---|---|
| Critical | 2 (`select-name`, `label`) | dashboard-ownership, admin |
| Serious | 3 (`color-contrast`, `scrollable-region-focusable`, `label-title-only`) | all states |
| Moderate/minor | several (see `axe-results.json`) | all states |

### Heuristic scorecard (Phase 4)
**Average 3.3 / 5.** Lowest: Help users recognize/recover from errors (2/5).
Full table: `scripts/audit/results/phase4-heuristic-scorecard.md`.

---

## 3. Prioritized issue list

### Critical
*(none — no data loss, no broken auth, no flow that fails outright)*

### High
| Issue | Where | Evidence | Suggested fix |
|---|---|---|---|
| Login LCP 7.7s, Performance 58/100 | login, all viewports | `results/lighthouse-login.json`; 845KB icon webfont + jsPDF (94KB) + Chart.js (59KB) all load before login is interactive | Defer/lazy-load the icon webfont, jsPDF, and Chart.js until after successful login — none are needed to render the login form itself. |
| FX rate silently stale (CORS-blocked fetch, but UI shows "Updated") | all dashboard tabs (Overview card) | `phase1-summary.md` §1c #2; console: `Access to fetch ... frankfurter.app ... blocked by CORS` | Proxy the FX rate call through `/api/*` (same pattern as the other data endpoints) instead of calling `frankfurter.app` directly from the browser, and show a visible "rate unavailable" state instead of a stale "Updated" timestamp when the fetch fails. |
| Data tables clip on mobile with no scroll affordance | dashboard-performance, dashboard-positions, dashboard-transactions (mobile) | `phase2-visual-notes.md` issue #2; axe `scrollable-region-focusable` on `.table-scroll` | Add a visible scroll-shadow/fade on `.table-scroll` edges and `tabindex="0"` so it's both discoverable and keyboard-accessible. |
| Critical a11y: unlabeled form controls | dashboard-ownership (`#dep-filter-month`), admin (`#a-dep-date`) | `results/axe-results.json` (`select-name`, `label`) | Add `aria-label` or a visible `<label for>` to both controls. |

### Medium
| Issue | Where | Evidence | Suggested fix |
|---|---|---|---|
| `populateAdminFields` throws on every login | all authenticated states | `phase1-summary.md` §1c #1, `index.html:2441` | Fix the null-element access — likely a field that doesn't exist yet at call time; guard or reorder the call in `_launchApp`. |
| Debug version tag overlaps content | 6 mobile/tablet screens | `phase2-visual-notes.md` issue #1 | Reposition to a spot that can't collide with card content, or hide it outside of admin/dev contexts. |
| Accessibility 88/100 on login (below 90) | login | `results/lighthouse-login.json` | Driven by the same contrast issue below; fixing it should clear this threshold. |
| Admin form fields not exercised for validation | admin | `phase3-flow-report.md` scope note | Follow-up audit against a staging DB to verify deposit-form validation without risking production data. |

### Low
| Issue | Where | Evidence | Suggested fix |
|---|---|---|---|
| `color-contrast` on EN/ES language toggle | login (persists elsewhere) | `results/axe-results.json` | Darken the inactive tab text/background to meet WCAG AA contrast. |
| Tab bar truncates first tab label on mobile with no scroll affordance | dashboard-ownership mobile | `phase2-visual-notes.md` issue #3 | Add a subtle edge fade to the tab strip, same treatment as the table fix above. |

---

## 4. Quick wins (< 30 min each)
- Add `aria-label` to `#dep-filter-month` and a `<label>` for `#a-dep-date` (critical a11y fix, trivial change).
- Fix the `populateAdminFields` null-reference error.
- Reposition/hide the `v2026-07-03-b` debug tag.
- Darken the inactive language-toggle button for contrast compliance.

## 5. Larger recommendations (needs discussion, not just a code fix)
- **FX rate architecture**: routing `frankfurter.app` through a backend proxy is a
  design change (new `/api/fx` endpoint, caching strategy) worth scoping properly
  rather than a quick patch — decide whether COP conversion is even accurate enough
  to keep showing to investors while it's broken.
- **Login performance**: deferring heavy libraries changes load order across the
  whole app; needs a pass to confirm nothing on the dashboard depends on jsPDF/Chart.js
  being present at page-load time before auth completes.
- **Mobile table strategy**: rather than patching scroll affordances table-by-table,
  worth deciding on one reusable responsive-table pattern (card-based layout on
  mobile vs. horizontal scroll) and applying it consistently across Performance,
  Positions, Transactions, and Ownership.
- **Local/dev environment**: the Vercel "development" environment has no database
  credentials, which blocked local testing entirely for this audit and will keep
  blocking any future local development against real data flows. Worth deciding
  whether to provision a staging DB or formally adopt "test against production,
  read-only" as the standing approach.

---

*Phase 6 (implementing fixes) was not started — this report is for review first, per the audit brief.*
