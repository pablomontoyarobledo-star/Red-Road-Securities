# Phase 1 — Automated Technical Checks

**Target:** https://red-road-securities.vercel.app (production — local `vercel dev`
could not be used because the linked Vercel "development" environment has no
database credentials configured, only `BLOB_READ_WRITE_TOKEN`; see Phase 0 notes).
Login account used: `pablomontoyarobledo@gmail.com` (admin account).

States tested (this is a single-page app; "routes" are in-app view states, not URLs — see `routes.json`):
login, dashboard-overview, dashboard-performance, dashboard-positions,
dashboard-ownership, dashboard-transactions, dashboard-nav, dashboard-statements,
settings, admin.

## 1a. Lighthouse

Lighthouse can only audit a fresh, unauthenticated page load (no scripted-session
support without extra plumbing), so it was run against the public login screen only.
Authenticated states are covered by axe-core (1b) and the health check (1c) instead.

| Category | Score | Threshold | Status |
|---|---|---|---|
| Performance | 58 | 80 | **FLAG** |
| Accessibility | 88 | 90 | **FLAG** |
| Best Practices | 96 | 90 | Pass |
| SEO | 90 | 90 | Pass |

Raw report: `results/lighthouse-login.json`

**Performance (58) is the headline issue** — well below threshold on the very first
screen every investor sees. Needs a deeper look at LCP/TBT diagnostics in the raw
report before prioritizing a fix (see Phase 5).

## 1b. Accessibility (axe-core)

Violation counts by severity, per state:

| State | critical | serious | moderate | minor |
|---|---|---|---|---|
| login | – | 1 | 2 | – |
| dashboard-overview | – | 1 | 3 | – |
| dashboard-performance | – | 1 | 3 | – |
| dashboard-positions | – | 1 | 3 | – |
| dashboard-ownership | 1 | 2 | 3 | – |
| dashboard-transactions | 1 | 1 | 3 | 1 |
| dashboard-nav | – | 1 | 3 | – |
| dashboard-statements | 1 | 1 | 3 | – |
| settings | – | 1 | 3 | – |
| admin | 2 | 2 | 3 | – |

**Distinct critical/serious violation types found (flagged per policy — impact serious or critical):**

1. **`color-contrast` (serious)** — e.g. the EN/ES language toggle buttons on the
   login screen (`#login-lang-es`) don't meet minimum contrast. Present across states.
2. **`scrollable-region-focusable` (serious)** — `.table-scroll` containers (used for
   all the data tables: ownership, transactions, etc.) are scrollable but not
   keyboard-focusable, so keyboard users can't scroll them.
3. **`select-name` (critical)** — `#dep-filter-month` `<select>` on the Ownership tab
   has no accessible name (screen readers announce it as unlabeled).
4. **`label` (critical)** — `#a-dep-date` date input on the Admin screen has no
   associated `<label>`.
5. **`label-title-only` (serious)** — `#statement-as-of` date input relies on a
   `title` attribute instead of a visible/programmatic label.

Full data: `results/axe-results.json`

## 1c. Console errors & failed requests

Every authenticated state (dashboard-*, settings, admin) surfaced the same 3 console
errors and 1 failed network request, because they all fire once at login/`_launchApp`
time and persist across tab switches:

1. **JS error on every login:**
   `populateAdminFields TypeError: Cannot set properties of null (setting 'value')`
   at `index.html:2441`, thrown from `_launchApp` → `tryLogin`. This runs for every
   admin login and fails silently (caught by the wrapping `try/catch`, so the user
   never sees it, but whatever field `populateAdminFields` was supposed to populate
   is silently skipped).
2. **Blocked cross-origin request:** `https://api.frankfurter.app/latest?from=USD&to=COP`
   is blocked by CORS policy (`net::ERR_FAILED`). This is the FX-rate fetch
   (`fetchFXRate()`) — it fails on every session, meaning USD→COP conversion is
   silently broken/stale for any investor viewing values in COP.
3. No other console errors or 4xx/5xx API responses were observed across any state.

Full data: `results/health-check.json`

## Flagged issues summary (carried into Phase 5)

| # | Issue | Severity | Where |
|---|---|---|---|
| 1 | Performance score 58/100 on login (below 80 threshold) | High | login |
| 2 | `populateAdminFields` throws on every login | Medium | all authenticated states |
| 3 | FX rate fetch (`frankfurter.app`) blocked by CORS — COP conversion broken | High | all authenticated states (financial data accuracy) |
| 4 | `select-name` / `label` critical a11y violations (unlabeled form controls) | High | dashboard-ownership, admin |
| 5 | `scrollable-region-focusable` — data tables not keyboard-scrollable | Medium | all dashboard tabs |
| 6 | `color-contrast` on language toggle | Low | login (and persists elsewhere) |
| 7 | Accessibility score 88/100 on login (below 90 threshold) | Medium | login |
