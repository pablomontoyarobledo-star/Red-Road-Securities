// Unit tests for lib/nav.js — the fund's NAV/unit-settlement math, shared by
// the daily IB cron pull, the NAV-history rebuild, and the deposit-repair
// action specifically so those three paths can never disagree (see the
// header comment in lib/nav.js).
//
// Run with:  node --test test/
//
// Uses Node's built-in test runner (node:test) — no new dependency required.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  depositCash,
  computeTotalUnitsAtDate,
  buildUnitSchedule,
  fixIbDepositNavs,
  applyPendingToLatest,
  recomputeNavSeries,
  checkPlausibleTotalValue,
  investorKeysFor,
  depositBelongsTo,
  computeInvestorUnitsAtDate,
  depositedByInvestorAtDate,
  INCEPTION_NAV,
} from "../lib/nav.js";

describe("depositCash", () => {
  test("single-investor format", () => {
    assert.equal(depositCash({ investor: "dario", amount: 1000 }), 1000);
  });

  test("per-investor-keyed format sums numeric non-meta fields", () => {
    assert.equal(depositCash({ date: "2026-01-01", fernando: 500, dario: 300, nav: 1.2 }), 800);
  });

  test("ignores non-positive and non-numeric fields", () => {
    assert.equal(depositCash({ date: "2026-01-01", fernando: -50, note: "oops", nav: 1 }), 0);
  });
});

describe("computeTotalUnitsAtDate", () => {
  test("sums cash/nav across deposits on or before the date", () => {
    const deposits = [
      { investor: "a", amount: 1000, date: "2026-01-01", nav: 1.0 },
      { investor: "b", amount: 500,  date: "2026-01-05", nav: 1.25 },
      { investor: "a", amount: 200,  date: "2026-02-01", nav: 1.5 }, // after cutoff
    ];
    const units = computeTotalUnitsAtDate(deposits, "2026-01-10");
    assert.equal(units, 1000 / 1.0 + 500 / 1.25);
  });

  test("falls back to INCEPTION_NAV when a deposit has no nav", () => {
    const deposits = [{ investor: "a", amount: 500, date: "2026-01-01" }];
    assert.equal(computeTotalUnitsAtDate(deposits, "2026-01-01"), 500 / INCEPTION_NAV);
  });

  test("empty deposits yields zero units", () => {
    assert.equal(computeTotalUnitsAtDate([], "2026-01-01"), 0);
  });
});

describe("buildUnitSchedule", () => {
  test("settles a clean deposit on the day its cash lands (within 10%)", () => {
    const deposits = [{ investor: "a", amount: 1000, date: "2026-01-01", nav: 1.0 }];
    const series = [
      { date: "2025-12-31", totalValue: 10000 },
      { date: "2026-01-02", totalValue: 11005 }, // +1005, within 10% of 1000
    ];
    const schedule = buildUnitSchedule(deposits, series);
    assert.deepEqual(Object.keys(schedule), ["2026-01-02"]);
    assert.ok(Math.abs(schedule["2026-01-02"] - 1000) < 1e-9);
  });

  test("falls back to the deposit's own date when no matching jump exists", () => {
    const deposits = [{ investor: "a", amount: 1000, date: "2026-01-01", nav: 1.0 }];
    const series = [{ date: "2025-12-31", totalValue: 10000 }, { date: "2026-01-02", totalValue: 10001 }];
    const schedule = buildUnitSchedule(deposits, series);
    assert.deepEqual(Object.keys(schedule), ["2026-01-01"]);
  });

  test("a jump outside the 12-day settlement window is not matched", () => {
    const deposits = [{ investor: "a", amount: 1000, date: "2026-01-01", nav: 1.0 }];
    const series = [
      { date: "2025-12-31", totalValue: 10000 },
      { date: "2026-01-20", totalValue: 11000 }, // 20 days later — outside MAX_LAG_DAYS
    ];
    const schedule = buildUnitSchedule(deposits, series);
    // Falls back to the deposit's own date, not the far-future jump.
    assert.deepEqual(Object.keys(schedule), ["2026-01-01"]);
  });

  test("two same-day deposits settle as one grouped jump", () => {
    const deposits = [
      { investor: "a", amount: 600, date: "2026-01-01", nav: 1.0 },
      { investor: "b", amount: 400, date: "2026-01-01", nav: 1.0 },
    ];
    const series = [
      { date: "2025-12-31", totalValue: 10000 },
      { date: "2026-01-01", totalValue: 11000 },
    ];
    const schedule = buildUnitSchedule(deposits, series);
    assert.ok(Math.abs(schedule["2026-01-01"] - 1000) < 1e-9);
  });
});

describe("fixIbDepositNavs", () => {
  test("re-prices an IB-detected deposit to the prior point's NAV", () => {
    const deposits = [{ investor: "a", amount: 1000, date: "2026-01-02", ibDesc: "WIRE", nav: 1.5 }];
    const series = [
      { date: "2026-01-01", nav: 1.2 },
      { date: "2026-01-02", nav: 1.5 },
    ];
    const changed = fixIbDepositNavs(deposits, series);
    assert.equal(changed, 1);
    assert.equal(deposits[0].nav, 1.2);
  });

  test("leaves deposits without ibDesc untouched", () => {
    const deposits = [{ investor: "a", amount: 1000, date: "2026-01-02", nav: 1.5 }];
    const series = [{ date: "2026-01-01", nav: 1.2 }];
    assert.equal(fixIbDepositNavs(deposits, series), 0);
    assert.equal(deposits[0].nav, 1.5);
  });

  test("no-op when the deposit's nav already matches the prior point", () => {
    const deposits = [{ investor: "a", amount: 1000, date: "2026-01-02", ibDesc: "WIRE", nav: 1.2 }];
    const series = [{ date: "2026-01-01", nav: 1.2 }];
    assert.equal(fixIbDepositNavs(deposits, series), 0);
  });
});

describe("applyPendingToLatest", () => {
  test("folds pending cash into the latest point at a neutral NAV", () => {
    const series = [{ date: "2026-01-01", totalValue: 11000, totalUnits: 10000, nav: 1.1 }];
    applyPendingToLatest(series, 1000, 1.0);
    const latest = series[0];
    // Fair NAV excludes the pending cash: (11000 - 1000) / 10000 = 1.0
    assert.equal(latest.nav, 1.0);
    assert.equal(latest.pendingCash, 1000);
  });

  test("no-op when there's no pending cash", () => {
    const series = [{ date: "2026-01-01", totalValue: 11000, totalUnits: 10000, nav: 1.1 }];
    applyPendingToLatest(series, 0, 1.0);
    assert.equal(series[0].nav, 1.1);
    assert.equal(series[0].pendingCash, undefined);
  });

  test("no-op when the series is empty", () => {
    const series = [];
    assert.doesNotThrow(() => applyPendingToLatest(series, 1000, 1.0));
  });
});

describe("recomputeNavSeries", () => {
  test("recomputes nav/units for every point from the deposit ledger", () => {
    const deposits = [{ investor: "a", amount: 1000, date: "2026-01-01", nav: 1.0 }];
    const series = [
      { date: "2026-01-01", totalValue: 1000, nav: 999, totalUnits: 1 },
      { date: "2026-01-02", totalValue: 1100, nav: 999, totalUnits: 1 },
    ];
    const changed = recomputeNavSeries(series, deposits, 1.0);
    assert.ok(changed > 0);
    assert.equal(series[0].nav, 1.0);   // 1000 totalValue / 1000 units
    assert.equal(series[1].nav, 1.1);   // 1100 totalValue / 1000 units
  });

  test("points before the first settlement are left untouched", () => {
    const deposits = [{ investor: "a", amount: 1000, date: "2026-01-05", nav: 1.0 }];
    const series = [{ date: "2026-01-01", totalValue: 500, nav: 42, totalUnits: 7 }];
    recomputeNavSeries(series, deposits, 1.0);
    assert.equal(series[0].nav, 42); // untouched — no units have settled yet
  });
});

// Regression coverage for the bug found in api/send-statements.js: its
// private depositKey()/computeInvestorUnits() read only d[firstName.toLowerCase()],
// which silently returned 0 for (a) deposits stored in the legacy
// {investor:"key"} shape, and (b) any investor whose key isn't simply their
// first name — e.g. a compound "firstname_lastname" id minted by
// allocate-deposit.js's newInvestor path. These tests pin the shared
// lib/nav.js helpers send-statements.js now uses instead.
describe("investor-scoped deposit helpers", () => {
  const compoundInvestor = { id: "juana_robledo", firstName: "Juana", lastName: "Robledo" };
  const legacyKeyInvestor = { id: "inv_dario", firstName: "Dario", lastName: "Montoya" };

  test("investorKeysFor includes id, inv_-stripped id, and lowercased first name", () => {
    const keys = investorKeysFor(legacyKeyInvestor);
    assert.ok(keys.has("inv_dario"));
    assert.ok(keys.has("dario"));
  });

  test("computeInvestorUnitsAtDate credits a legacy {investor:\"key\"} deposit — the shape the buggy version ignored entirely", () => {
    const deposits = [{ investor: "juana_robledo", amount: 4490, date: "2026-01-01", nav: 1.0 }];
    const units = computeInvestorUnitsAtDate(deposits, compoundInvestor, "2026-01-10");
    assert.equal(units, 4490 / 1.0);
  });

  test("computeInvestorUnitsAtDate credits a compound-key deposit that a bare-firstName key would miss", () => {
    // The buggy version read d["juana"] (firstName.toLowerCase()); the real
    // key allocate-deposit.js mints for a new investor is "firstname_lastname".
    const deposits = [{ juana_robledo: 4490, date: "2026-01-01", nav: 1.0 }];
    const units = computeInvestorUnitsAtDate(deposits, compoundInvestor, "2026-01-10");
    assert.equal(units, 4490 / 1.0);
    assert.equal(depositedByInvestorAtDate(deposits, compoundInvestor, "2026-01-10"), 4490);
  });

  test("computeInvestorUnitsAtDate does not attribute another investor's deposit", () => {
    const deposits = [{ dario: 1000, date: "2026-01-01", nav: 1.0 }];
    assert.equal(computeInvestorUnitsAtDate(deposits, compoundInvestor, "2026-01-10"), 0);
    assert.equal(depositedByInvestorAtDate(deposits, compoundInvestor, "2026-01-10"), 0);
  });

  test("per-investor units sum to the fund total across mixed deposit shapes", () => {
    const deposits = [
      { investor: "juana_robledo", amount: 4490, date: "2026-01-01", nav: 1.0 },
      { dario: 1000, date: "2026-01-02", nav: 1.0 },
    ];
    const total = computeTotalUnitsAtDate(deposits, "2026-01-10");
    const juana = computeInvestorUnitsAtDate(deposits, compoundInvestor, "2026-01-10");
    const dario = computeInvestorUnitsAtDate(deposits, legacyKeyInvestor, "2026-01-10");
    assert.ok(Math.abs(total - (juana + dario)) < 1e-9);
  });

  test("depositBelongsTo respects an explicit dateStr cutoff via the *AtDate wrappers", () => {
    const deposits = [{ juana_robledo: 4490, date: "2026-02-01", nav: 1.0 }];
    assert.equal(computeInvestorUnitsAtDate(deposits, compoundInvestor, "2026-01-10"), 0);
    assert.equal(computeInvestorUnitsAtDate(deposits, compoundInvestor, "2026-02-01"), 4490);
  });
});

describe("checkPlausibleTotalValue", () => {
  test("flags a swing that today's deposits don't explain", () => {
    const result = checkPlausibleTotalValue(15000, 10000, 0); // +50% with no deposit
    assert.equal(result.suspect, true);
  });

  test("does not flag a swing fully explained by deposits", () => {
    const result = checkPlausibleTotalValue(11000, 10000, 1000); // exactly matches the deposit
    assert.equal(result.suspect, false);
  });

  test("does not flag an ordinary day-to-day market move", () => {
    const result = checkPlausibleTotalValue(10300, 10000, 0); // +3%
    assert.equal(result.suspect, false);
  });

  test("skips the check when there's no prior point", () => {
    assert.equal(checkPlausibleTotalValue(10000, null, 0).suspect, false);
  });
});
