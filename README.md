# Red Road Securities

Investor portal for a small investment fund: a single-page app for investors to view
fund performance and statements, plus a set of Vercel serverless functions that pull
positions/NAV data from Interactive Brokers, store it in Postgres, and generate
PDF financial statements.

- **Live URL:** https://red-road-securities.vercel.app
- **Frontend:** `index.html` — vanilla JS/HTML/CSS, no build step, no framework.
  Client-side PDF generation via jsPDF + jsPDF-AutoTable (loaded from CDN).
- **Backend:** Vercel serverless functions in `api/`, shared logic in `lib/`.
- **Data store:** Neon (serverless Postgres). Each dataset (`fund-data`,
  `investors`, `nav-history`, ...) is stored as a JSONB document, plus a
  `snapshots` table for timestamped backups and historical IB data pulls.

## Repo layout

```
index.html          Entire frontend (investor + admin views, PDF generation)
api/                 Vercel serverless functions (HTTP handlers)
  data.js              Authenticated data gateway (login + whitelisted dataset reads)
  ib-data.js           Daily cron: pulls IB Flex positions, recomputes NAV
  ib-nav-history.js    Daily cron: pulls IB Flex NAV history, merges into nav-history
  ib-pulls.js          Lists/reads historical IB data pull snapshots
  allocate-deposit.js  Admin: allocate a pending deposit to an investor
  import-ib-xml.js     Admin: manually import an IB Flex XML statement
  prices.js            Cached security price lookups (Yahoo Finance)
  spx-history.js       Benchmark index history (S&P 500, EFA, VT)
  restore-investors.js Admin: list/restore investor data backups
  send-statements.js   Monthly cron: emails investor statements
  sync-data.js         Admin: write an arbitrary dataset
  sync-investors.js    Read/write the investors dataset
lib/
  auth.js              Admin auth (session tokens, sync secret, cron secret)
  nav.js               Shared NAV/unit-count math
  store.js             Neon Postgres document + snapshot storage
scripts/
  init-db.mjs              Create the Postgres schema
  migrate-blobs-to-neon.mjs  One-off migration from Vercel Blob to Neon
  audit/                   Playwright-based smoke tests / accessibility audit
vercel.json          Cron schedules
```

## Setup

```bash
npm install
```

Requires a `.env` (or Vercel project env vars) with:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string |
| `SESSION_HMAC_SECRET` | HMAC secret for signing/verifying admin session tokens (falls back to `SYNC_SECRET` if unset — set this explicitly) |
| `SYNC_SECRET` | Bypass secret for the `x-sync-secret` header (scripts/manual calls) |
| `CRON_SECRET` | Bearer token Vercel cron uses to call protected endpoints |
| `IB_FLEX_TOKEN`, `IB_FLEX_QUERY_ID`, `IB_NAV_QUERY_ID` | Interactive Brokers Flex Query credentials |
| `RESEND_API_KEY` | Sending monthly statement emails |
| `BLOB_READ_WRITE_TOKEN`, `BLOB_SUFFIX` | Legacy Vercel Blob storage (migration only) |
| `AUDIT_EMAIL`, `AUDIT_PASSWORD`, `BASE_URL` | Used by the Playwright audit scripts |

Initialize the database schema once:

```bash
node scripts/init-db.mjs
```

## Local development

```bash
vercel dev
```

## Deploy

```bash
vercel --prod
```

Vercel cron (`vercel.json`) handles the daily IB data/NAV pulls (weekdays 22:00 UTC)
and the monthly investor statement email (13:00 UTC on the last day of the month).

## Testing

```bash
node scripts/audit/smoke-test.js
```
