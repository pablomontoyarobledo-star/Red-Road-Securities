# Red Road Securities — Returns Accuracy & Data Integrity Audit

**Scope:** `red-road-securities` — single-fund, multi-LP investor portal (Vercel
serverless + Neon Postgres + single-file vanilla-JS SPA). This audit covers
(A) correctness of every return figure shown to investors, and (B) structural
integrity of transaction/price/position storage. It is **separate from and
complementary to** the existing security audit in
[audit-report.md](audit-report.md) / [issues-and-fixes.md](issues-and-fixes.md),
most of which has already been remediated (session revocation, audit log,
scoped deposits, rate limiting, etc. all now exist in the code).

**Audit date:** 2026-08-01. **Method:** full static read of every file that
computes, stores, or displays a return or a financial record (`lib/nav.js`,
`lib/store.js`, all `api/*.js`, `index.html`'s render functions, `test/`).
No live database was queried — findings about live data shape are inferred
from code that explicitly handles multiple record shapes (see §A1) and from
git history (commit messages, diffs).

---

## System map

**Architecture:** Fund ONE is a single pooled vehicle, not per-investor
brokerage accounts. Investors own **units**; a fund-wide **NAV per unit**
(inception $1.00, 2025-12-18) is the sole return primitive. There is no
per-position TWR/MWR split, no lot-level per-investor cost basis — an
investor's dollar return is derived entirely from `(their units × NAV) vs
their deposited cash`.

**Where returns are calculated:**
- [lib/nav.js](lib/nav.js) — the authoritative, single-sourced NAV/unit engine.
  Shared by three call sites so they can't disagree: the daily cron
  ([api/ib-data.js](api/ib-data.js)), the NAV-history rebuild
  ([api/ib-nav-history.js](api/ib-nav-history.js)), and the deposit-repair
  admin action ([api/allocate-deposit.js](api/allocate-deposit.js)).
- Client-side, [index.html](index.html) recomputes period returns (MTD/QTD/
  YTD/inception, `renderPeriodReturns` L3835), monthly returns
  (`_computeFundMonthlyReturns` L4024), ownership/ROI (`renderOwnership`
  L2270, `renderMetrics` L2239), and a full realized/unrealized tax estimate
  (`renderTaxes` L3616) — all derived from the same `nav-history.json` /
  `fund-data.json` the server sends, not recomputed independently server-side.
- [api/send-statements.js](api/send-statements.js) — a **separate,
  independent reimplementation** of investor-level unit/deposit/return math
  for the monthly emailed PDF-equivalent HTML statement. This is the one
  place the shared logic isn't reused, and it's where the Critical finding
  below lives.

**Where returns are displayed:** Overview/Performance page (chart + period
cards + monthly-vs-benchmark table), Ownership cards, Taxes page, the
in-browser PDF statement generator (`index.html`'s `_generateBalanceSheetPDF`/
`_generateIncomeStatementPDF`, per `CLAUDE_CONTEXT.md`), and the monthly
emailed HTML statement (`send-statements.js`).

**Data model / where data enters:**
- **Neon Postgres**, one JSONB row per logical document
  (`fund-data.json` [positions, cashBalance, deposits[], transactions[]],
  `investors.json`, `nav-history.json` [series[]], `pending-deposits.json`,
  `trades-history.json`) — see [lib/store.js](lib/store.js).
- **IB Flex Web Service** — daily cron pulls positions/trades/cash
  transactions/NAV ([api/ib-data.js](api/ib-data.js),
  [api/ib-nav-history.js](api/ib-nav-history.js)).
- **Manual IB XML paste** — admin-triggered
  ([api/import-ib-xml.js](api/import-ib-xml.js)).
- **Admin deposit allocation** — [api/allocate-deposit.js](api/allocate-deposit.js).
- **Raw admin sync** — [api/sync-data.js](api/sync-data.js), overwrites
  `fund-data.json` wholesale from whatever JSON the client sends.
- **Yahoo Finance** — live prices ([api/prices.js](api/prices.js)) and
  benchmark index history ([api/spx-history.js](api/spx-history.js)).
- **Append-only snapshots** table for pre-write backups (`backupAndWrite`)
  and IB-pull history; **audit_log** table for actor-attributed mutation
  records — both added since the last audit and functioning as designed
  where used (see §B below for where they're *not* used).

**Test coverage:** [test/nav.test.mjs](test/nav.test.mjs) covers
`lib/nav.js` thoroughly (unit settlement, pre-money re-pricing, plausibility
checks, pending-cash folding) with hand-verifiable fixtures — this is genuinely
good coverage of the hardest math in the app. **Nothing else has test
coverage**: the client-side period/monthly-return math, the tax lot
accounting, and `send-statements.js`'s independent return calculation are all
unverified by any automated test — which is exactly where this audit found
its worst bug.

---

## Findings table

| ID | Area | Location | Description | Scenario | Severity |
|----|------|----------|-------------|----------|----------|
| A1 | Returns | [api/send-statements.js:33-43,206-212](api/send-statements.js:33) | Monthly statement email computes each investor's units/deposited/gain/return with a different (and incomplete) key-matching function than the rest of the app | Wrong $ figures mailed directly to an LP | **Critical** |
| B1 | Storage | [api/sync-data.js:20-21](api/sync-data.js:20) | Admin "sync" endpoint overwrites all of `fund-data.json` (the deposit ledger) with `writeDoc`, no pre-write snapshot | One bad/stale push permanently destroys deposit history, no rollback | **High** |
| B2 | Storage | [lib/store.js](lib/store.js) `documents` table; deposits stored as an array inside one JSONB blob | No DB-level uniqueness/idempotency constraint on individual deposit records — dedup is 100% application code | A bug (present or future) in app-code dedup can silently duplicate or drop a capital contribution with no schema guardrail | **High** |
| B3 | Storage/Returns | `fund-data.json.deposits` (see A1) | Two incompatible deposit-record shapes coexist in the live ledger (`{investor:key,amount}` legacy vs `{key:amount}` current) with no migration ever normalizing old rows | Root cause of A1; any future code touching deposits must remember to special-case both, indefinitely | **High** |
| A2 | Returns | [index.html:3910](index.html:3910) vs [index.html:4107](index.html:4107) / [api/spx-history.js](api/spx-history.js) | The primary "Fund vs S&P 500" chart benchmarks against `^GSPC` (price-only index), while the monthly returns table correctly benchmarks against `^SP500TR` (total return) | Fund's total return (dividends included via NAV) is compared against a benchmark missing dividends in the chart investors see first — systematically flatters relative performance, undisclosed | Medium |
| B4 | Storage | [api/import-ib-xml.js:169-172](api/import-ib-xml.js:169) | Manual XML import overwrites `positions`/`cashBalance` unconditionally, no plausibility check (unlike the cron path's `checkPlausibleTotalValue`); also never touches `nav-history.json` | A garbled/partial manual paste silently corrupts live position data; NAV can drift out of sync with positions until the next cron run | Medium |
| A3 | Returns | [index.html:3637-3657](index.html:3637) `renderTaxes()` | Realized-gain average-cost lot tracks one `firstBuy` date per ticker; buying more of an already-held ticker doesn't correctly reset the holding-period clock per lot | Can misclassify a short-term gain as long-term after a top-up purchase, understating the tax estimate shown to investors | Medium |
| B5 | Storage | [api/ib-data.js:101-107](api/ib-data.js:101) `appendTrades()` | Trade dedup keys on `tradeId`; if IB omits an ID for an execution, the falsy check never treats it as "already known" | A trade lacking an IB trade ID gets duplicated on every re-pull/re-import that includes it | Low-Medium |
| A4 | Returns | [test/](test/) directory | No test coverage for client-side period/monthly return math, the tax lot-accounting logic, or `send-statements.js`'s return calculation | The one untested area is exactly where A1 was found — regressions here have no safety net | Medium (process gap, not a live bug) |

---

## Findings in detail (worst first)

### A1 — [Critical] Monthly investor statements can show wrong per-investor figures

`send-statements.js` is a hand-rolled second implementation of the
unit/deposit math that `lib/nav.js` and `index.html`'s `calcUnits()` already
share correctly. Compare:

- **`index.html`'s `calcUnits()`** ([index.html:1849-1866](index.html:1849))
  and **`lib/nav.js`'s `depositCash()`** both explicitly handle *two* deposit
  record shapes — the legacy `{investor: "juana_robledo", amount: 4490}` and
  the current `{juana_robledo: 4490}` — with a comment in `index.html`
  naming the legacy shape as coming from `allocate-deposit.js`'s own prior
  output. Matching also falls back through `inv.id`, `inv.id` with the
  `"inv_"` prefix stripped, so any investor's key resolves correctly
  regardless of when their record was created.
- **`send-statements.js`'s `computeInvestorUnits`/`depositKey`**
  ([api/send-statements.js:33-40](api/send-statements.js:33)) does neither:
  ```js
  function depositKey(inv) { return inv.firstName.toLowerCase(); }
  function computeInvestorUnits(deposits, key) {
    return deposits.reduce((sum, d) => {
      const nav = parseFloat(d.nav) || 1;
      return sum + (parseFloat(d[key]) || 0) / nav;   // only ever reads d[key]
    }, 0);
  }
  ```
  This silently returns **0** for: (a) any deposit stored in the legacy
  `{investor:"key"}` shape — `d[key]` is `undefined` on that record no matter
  what `key` is; (b) any investor whose actual deposit key isn't simply their
  lowercased first name — which is exactly what happens for every investor
  added through `allocate-deposit.js`'s `newInvestor` path, which mints
  `firstname_lastname` as the id/key
  ([api/allocate-deposit.js:127](api/allocate-deposit.js:127)), and for any
  two investors who happen to share a first name (silent cross-attribution,
  not just zeroing).

  Every number in the "Your Returns"/"Your Ownership"/"Capital Account"
  sections of the emailed statement (`myUnits`, `myDeposited`, `myValue`,
  `myGL`, `myReturn`, `myPct`) derives from this function. For an affected
  investor the email will show **$0 deposited, $0 value, 0% ownership,
  0%/"—" return** — or, in the name-collision case, one investor's statement
  showing another's numbers — while the in-app dashboard (which uses the
  correct, shared `calcUnits()`) shows the right figures. This is a direct,
  externally-mailed factual misstatement of an LP's capital account, not
  just an internal display bug.

  This is not hypothetical: the git history (`d36d703`, "Remove per-investor
  MWRR/XIRR") references "Pablo/Lucia's July 28 deposits" as a real, recent
  event — i.e. real deposits exist today for at least one investor
  ("Lucia") whose id would not reduce to a bare first-name key under
  `allocate-deposit.js`'s `firstname_lastname` convention.

**Fix direction:** delete `send-statements.js`'s private `depositKey`/
`computeInvestorUnits`/`computeTotalUnits` and import `depositCash` /
`computeTotalUnitsAtDate` from `lib/nav.js` (same functions the rest of the
app already trusts), keyed off `investor.id` with the same `"inv_"`-stripping
fallback used everywhere else. This also closes B3 as a side effect for this
call site, though B3 itself needs a real migration (see remediation plan).

### B1 — [High] `sync-data.js` can destroy the deposit ledger with no backup

Every other endpoint that overwrites `fund-data.json` —
`allocate-deposit.js`, `import-ib-xml.js` — calls `backupAndWrite()`, which
snapshots the prior document into the `snapshots` table before overwriting
(see [lib/store.js:56-62](lib/store.js:56)). `sync-data.js` does not:

```js
const payload = { ...body, syncedAt: new Date().toISOString() };
await writeDoc("fund-data.json", payload);   // no backupAndWrite
```

This is the endpoint an admin's browser calls for a manual "sync to cloud"
push of the *entire* client-side state — the deposit ledger, positions, and
transactions all at once. A stale tab, a client-side bug that drops an array
before syncing, or simply a race with a concurrent cron write, permanently
replaces the authoritative deposit history with whatever the client happened
to hold, with **zero** snapshot to recover from. Given `fund-data.json`
carries the one thing this whole audit cares most about protecting — the
deposit ledger every investor's capital account is built from — this is the
single highest-leverage storage-integrity gap in the codebase.

**Fix:** change `writeDoc("fund-data.json", payload)` to
`backupAndWrite("fund-data.json", payload)`. One-line fix, no schema change.

### B2/B3 — [High] Deposits have no structural integrity guarantee, and two record shapes coexist untracked

The audit brief's standard is that duplication/loss must be **structurally
impossible**, not just handled by careful code. Today:

- `fund-data.json.deposits` is a JSON array inside a single JSONB column.
  There is no per-deposit row, no unique index, no constraint of any kind.
  Every place that prevents a double-insert (`detectNewDeposits`'s
  `knownTxIds`/`knownCount` multiset in
  [api/ib-data.js:373-396](api/ib-data.js:373), the dedup logic in
  `import-ib-xml.js`) is applied *before* one whole-document write, entirely
  in application code. If two of those code paths ever race, or a future
  contributor writes a new deposit-producing path without copying the same
  dedup logic, nothing at the storage layer stops a duplicate or a silent
  loss (the same "read-whole-document, mutate, write-whole-document" race
  the code's own comments in `lib/store.js:64-73` identify as *already
  having happened once* for `pending-deposits.json`, which is why that one
  document got atomic `jsonb_set` mutations — `fund-data.json.deposits` never
  got the same treatment).
- Compounding this, the deposit-record schema itself has drifted: the
  `{investor:"key", amount}` shape and the `{key: amount}` shape both exist
  in the live ledger today (per A1's evidence), with no migration ever run to
  normalize old rows onto the current shape. This isn't just a returns bug —
  it's a sign the data model has no enforced shape at all, so every future
  reader must reverse-engineer and special-case history.

**Fix direction (see remediation plan):** this is the one finding in this
audit that genuinely warrants a schema change — a real `deposits` table
(one row per deposit, `investor_id` foreign key, unique constraint on a
dedup key such as `(coalesce(tx_id,''), date, amount, investor_id)`) rather
than a JSON array. That's a bigger lift than the rest of this list, so it's
sequenced last in the remediation plan despite being High severity — see the
"prerequisites" note there.

### A2 — [Medium] Chart benchmark uses price return, table benchmark uses total return

`index.html`'s overview chart (the first, most prominent performance visual)
fetches `/api/spx-history?dates=...`, which — per
[api/spx-history.js:55-92](api/spx-history.js:55) — tracks `^GSPC`, the
**price-only** S&P 500 index (no dividends). The monthly returns table
below it fetches `/api/spx-history?mode=monthly`, which correctly uses
`^SP500TR`, the **total-return** index. Fund ONE's own NAV-based TWR already
includes dividends (they flow into `totalValue` via IB's
`EquitySummaryInBase.total`). So the chart investors see first compares
Fund ONE's *total* return against the S&P's *price* return — a real,
unlabeled apples-to-oranges gap of roughly the index's dividend yield
(~1.3-1.5%/year for the S&P), always in the fund's favor, that the monthly
table one section down silently corrects without explanation.

**Fix:** switch the daily chart's benchmark source to a total-return series
(fetch `^SP500TR` daily closes the same way `spx-history.js`'s `?mode=monthly`
branch already does, or reuse those closes at daily granularity) so both
views use the same benchmark definition.

### B4 — [Medium] Manual XML import bypasses the plausibility guard and skips NAV

`import-ib-xml.js` unconditionally does
`fundData.positions = parsed.positions; fundData.cashBalance = parsed.cashBalance ?? ...`
with no equivalent of `checkPlausibleTotalValue` (which the automated cron
path in `ib-data.js` applies specifically to catch a garbled/partial IB
response before it mints a wrong NAV for everyone). A bad manual paste — a
truncated copy, wrong statement pasted, IB format hiccup that still parses —
silently becomes the live position snapshot. Separately, this import path
never calls `recomputeNavSeries`/`fixIbDepositNavs`/appends a NAV point at
all, so `nav-history.json` (what every return figure is actually computed
from) can end up describing a fund that no longer matches `fund-data.json`'s
positions until the next automated cron run reconciles it.

**Fix:** run `checkPlausibleTotalValue` against the parsed `totalValue`
before accepting it (same threshold/behavior as the cron path — flag, don't
block), and call the same NAV-point-append logic `ib-data.js` uses so a
manual import updates `nav-history.json` in lockstep with `fund-data.json`.

### A3 — [Medium] Tax-estimate holding-period test doesn't track per-lot dates correctly

`renderTaxes()`'s realized-gain replay ([index.html:3637-3657](index.html:3637))
keeps one `firstBuy` date per ticker in `lot[tk]`, set only when the ticker
is first seen, and averages cost across every subsequent buy without ever
updating that date. The long-term/short-term test then compares *every*
share's holding period against that single original date
(`_monthsBetween(L.firstBuy, saleDate)`), including shares from a purchase
made yesterday. Since the app already advertises "cost-basis matching uses
average cost per holding" (a documented simplification investors are told
about, [index.html:654](index.html:654)), average-cost itself isn't the
issue — but silently treating a same-week purchase as long-term-eligible
because the ticker was first bought a year ago understates the estimated
tax due, which is exactly the number this feature exists to get right.

**Fix:** track a cash-weighted average purchase date per lot (or at minimum
re-anchor `firstBuy` to a shares-weighted blend on each buy) rather than
freezing it at the first purchase.

### B5 — [Low-Medium] Trade dedup silently fails for trades without an IB trade ID

`appendTrades()`'s `if (t.tradeId && existingIds.has(t.tradeId)) continue;`
means a trade whose `tradeId` is `""` (IB omitted it) is *never* recognized
as already-stored, because the left side of the `&&` is falsy. Every re-pull
or re-import that includes such a trade appends another copy of it into
`trades-history.json`, inflating trade counts and any activity/income
figures that sum from that array.

**Fix:** fall back to a composite dedup key (date+ticker+shares+price) when
`tradeId` is empty, mirroring the pattern `detectNewDeposits` already uses
for deposits with a missing `txId`.

### A4 — [Medium, process] The one untested surface is where the bug was

`test/nav.test.mjs` is genuinely good coverage of `lib/nav.js`. Nothing
covers `send-statements.js`'s return math, the client-side period-return/
monthly-return functions, or `renderTaxes()`'s lot accounting — and A1 was
found by manual code reading precisely because there was no test that would
have caught a per-investor return coming back as `$0`.

---

## Remediation plan (priority order)

1. **B1 — add `backupAndWrite` to `sync-data.js`.** Zero risk, one line,
   closes the single biggest "silent permanent loss" exposure immediately.
   Do this first regardless of anything else.
2. **A1 — fix `send-statements.js` to use `lib/nav.js`'s shared
   `depositCash`/unit logic.** This is the active, externally-visible bug;
   fix it before touching anything else that depends on deposit shape, so a
   before/after comparison against real investor data is meaningful. Add a
   unit test asserting a `{investor:"key"}`-shaped and a compound-key
   investor both come out non-zero — this is the regression test A4 flags as
   missing.
3. **B4 — add the plausibility guard + NAV append to `import-ib-xml.js`.**
   Independent of the above; do it once B1's backup safety net is in place
   so a bad manual import is provably recoverable while this ships.
4. **A2 — switch the overview chart's benchmark to total-return.** Purely
   additive (new data source for one chart), no dependency on the others.
5. **A3 — fix the tax lot holding-period tracking.** Independent; sequence
   after A1 since both touch "how do we read the deposit/trade ledger"
   territory and are easier to review together than interleaved with
   unrelated work.
6. **B5 — fall back to a composite key for trade dedup.** Small, independent,
   any time.
7. **B2/B3 — migrate `deposits` from a JSON array to a real table.** This is
   the only item that needs a **data-preserving migration** (write a script
   that reads every existing `fund-data.json.deposits` entry — in both
   shapes — and backfills a new `deposits` table with a normalized shape and
   a unique dedup constraint; dry-run against a copy of the real document
   before cutting over). Sequence this **last**, after A1 is fixed, so the
   migration script and the fixed statement code agree on how to interpret
   the legacy shape — fixing A1 first is a prerequisite for writing this
   migration correctly, not the other way around. Every other finding above
   is fixable without touching the storage shape; this one alone justifies
   the bigger lift.

Per the audit brief: no code changes have been made. This report is the
Phase 1/2 deliverable — implementation (Phase 3) should proceed one fix per
commit, in the order above, with before/after numbers on real data for A1 in
particular given it's the one with a demonstrable live-data explanation.
