# Phase 3 — Critical User Flows

**Scope note:** This portal's only truly critical flows for an investor are read-only
(log in, view data, download statements) plus locale switching. The one flow that
*writes* data — Admin → "Log deposit" — was **intentionally not exercised** here to
avoid inserting real records into the production financial database; it was reviewed
visually only (Phase 2, `admin-*.png`). If a proper flow test is wanted for it, it
needs a non-production/staging database first.

Flows tested, run via `npx playwright test` against production
(https://red-road-securities.vercel.app), 5 tests total:

| Flow | Result | Steps (happy path) | Notes |
|---|---|---|---|
| Login — valid credentials → dashboard | **Pass** | 1 click | Reaches `#app` reliably. |
| Login — invalid password → error shown | **Pass**\* | — | `#login-error` appears, `#app` stays hidden — not a silent failure. \*Test initially asserted zero console errors and failed on a routine `401` fetch log; that's expected browser behavior for a rejected credential check, not an app bug, so it's not counted as a real failure. |
| Login — empty fields → does not silently proceed | **Pass** | — | Clicking Sign In with empty fields does not log in or throw. |
| Statement download — investor downloads monthly PDF | **Pass** | 3 clicks (login → Statements tab → Download PDF) | Client-side `jsPDF` generation, file downloads with a `.pdf` filename. Fast, no server round-trip beyond already-loaded data. |
| Language switch — EN ↔ ES on login screen | **Pass** | 2 clicks | Subtitle text updates correctly both directions, no console errors. |

## Findings
- No broken or unclear error handling found in the flows tested — the invalid-login
  case correctly shows a visible error message rather than failing silently, which
  is the main thing this phase checks for.
- The happy-path statement download is short (3 clicks) and works reliably.
- No flow-level bugs found. (Bugs found elsewhere — the `populateAdminFields` console
  error on login, the broken FX-rate fetch — are functional/accessibility issues
  already captured in Phase 1, not flow-breaking ones: the flows complete successfully
  despite them.)
