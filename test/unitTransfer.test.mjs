// Unit tests for the management-fee/bonus unit-transfer engine — the
// highest-value test file given the money math involved. Covers the
// Fernando/Dario split (lib/unitTransfer.js) and the transfer-aware unit
// math it depends on (lib/nav.js).
//
// Run with:  node --test test/

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeInvestorUnitsAtDate,
  computeInvestorUnitsAtDateWithTransfers,
  computeInvestorUnitTransferNet,
  computeTotalUnitsAtDate,
  unitTransferBelongsTo,
  investorKeysFor,
} from "../lib/nav.js";
import {
  computeMonthlyFeeSplit,
  firstOfMonthsThrough,
  FERNANDO_ID, DARIO_ID, JUANA_ID, LUCIA_ID, PABLO_ID,
} from "../lib/unitTransfer.js";

// A fund with the five real investors, deposited 2026-01-01 at nav=1.0, so
// units == dollars everywhere below (keeps the arithmetic legible).
const BASE_DEPOSITS = [
  { investor: "fernando",      amount: 1000, date: "2026-01-01", nav: 1.0 },
  { investor: "dario",         amount: 2000, date: "2026-01-01", nav: 1.0 },
  { investor: "juana_robledo", amount: 500,  date: "2026-01-01", nav: 1.0 },
  { investor: "lucia_montoya", amount: 500,  date: "2026-01-01", nav: 1.0 },
  { investor: "pablo_montoya", amount: 6000, date: "2026-01-01", nav: 1.0 },
];
const FLAT_NAV_SERIES = [
  { date: "2026-01-01", nav: 1.0 },
  { date: "2026-06-01", nav: 1.0 },
  { date: "2026-07-01", nav: 1.0 },
];

describe("computeMonthlyFeeSplit", () => {
  test("splits exactly $400 between Fernando and Dario's bucket, proportional to value", () => {
    const split = computeMonthlyFeeSplit({
      deposits: BASE_DEPOSITS, series: FLAT_NAV_SERIES, unitTransfers: [],
      effectiveDate: "2026-06-01", totalFeeUsd: 400,
    });
    // pool = fund(10000) - pablo(6000) = 4000; fernando 1000/4000 = 25% -> $100; dario absorbs the rest -> $300
    assert.equal(split.fernandoShare, 100);
    assert.equal(split.darioShare, 300);
    assert.equal(split.fernandoShare + split.darioShare, 400); // sums to exactly the fee, no rounding drift
    assert.equal(split.legs.length, 2);
    assert.deepEqual(split.legs[0], { from: FERNANDO_ID, to: PABLO_ID, amountUsd: 100, navPerUnit: 1.0, units: 100 });
    assert.deepEqual(split.legs[1], { from: DARIO_ID, to: PABLO_ID, amountUsd: 300, navPerUnit: 1.0, units: 300 });
  });

  test("the two shares always sum to exactly totalFeeUsd, even with an uneven split", () => {
    // Deliberately lopsided so fernandoValue/poolValue doesn't divide evenly.
    const deposits = [
      { investor: "fernando", amount: 333, date: "2026-01-01", nav: 1.0 },
      { investor: "dario",    amount: 667, date: "2026-01-01", nav: 1.0 },
      { investor: "pablo_montoya", amount: 1000, date: "2026-01-01", nav: 1.0 },
    ];
    const split = computeMonthlyFeeSplit({
      deposits, series: FLAT_NAV_SERIES, unitTransfers: [],
      effectiveDate: "2026-06-01", totalFeeUsd: 400,
    });
    assert.equal(Math.round((split.fernandoShare + split.darioShare) * 100) / 100, 400);
  });

  test("nets in prior unit transfers so a later month isn't split against stale ownership", () => {
    // June's fee (from the base fixture): Fernando pays $100, Dario pays
    // $300, both to Pablo. Then Fernando deposits another $1000 before July.
    const juneTransfers = [
      { date: "2026-06-01", type: "management_fee", from: FERNANDO_ID, to: PABLO_ID, units: 100 },
      { date: "2026-06-01", type: "management_fee", from: DARIO_ID,    to: PABLO_ID, units: 300 },
    ];
    const depositsWithJulyContribution = [
      ...BASE_DEPOSITS,
      { investor: "fernando", amount: 1000, date: "2026-06-15", nav: 1.0 },
    ];

    const splitWithNetting = computeMonthlyFeeSplit({
      deposits: depositsWithJulyContribution, series: FLAT_NAV_SERIES, unitTransfers: juneTransfers,
      effectiveDate: "2026-07-01", totalFeeUsd: 400,
    });
    // fernando units at July 1 = 1000 + 1000 - 100 = 1900; dario = 2000 - 300 = 1700
    // pool = fund(11000) - pablo(6400) = 4600; fernandoShare = 400 * 1900/4600
    assert.equal(splitWithNetting.fernandoShare, 165.22);
    assert.equal(splitWithNetting.darioShare, 234.78);

    // Sanity: computing the same July split while IGNORING June's transfer
    // (the bug this netting prevents) gives a different, wrong answer —
    // proving the netting actually changes the result, not just decoration.
    const splitWithoutNetting = computeMonthlyFeeSplit({
      deposits: depositsWithJulyContribution, series: FLAT_NAV_SERIES, unitTransfers: [],
      effectiveDate: "2026-07-01", totalFeeUsd: 400,
    });
    assert.notEqual(splitWithoutNetting.fernandoShare, splitWithNetting.fernandoShare);
    assert.equal(splitWithoutNetting.fernandoShare, 160);
    assert.equal(splitWithoutNetting.darioShare, 240);
  });

  test("returns null when the non-Pablo pool is empty (degenerate — nothing to split)", () => {
    const deposits = [{ investor: "pablo_montoya", amount: 6000, date: "2026-01-01", nav: 1.0 }];
    const split = computeMonthlyFeeSplit({
      deposits, series: FLAT_NAV_SERIES, unitTransfers: [],
      effectiveDate: "2026-06-01", totalFeeUsd: 400,
    });
    assert.equal(split, null);
  });

  test("returns null when there's no NAV point at or before the effective date", () => {
    const split = computeMonthlyFeeSplit({
      deposits: BASE_DEPOSITS, series: [{ date: "2026-08-01", nav: 1.0 }], unitTransfers: [],
      effectiveDate: "2026-06-01", totalFeeUsd: 400,
    });
    assert.equal(split, null);
  });
});

describe("firstOfMonthsThrough", () => {
  test("returns every 1st-of-month from start through today, inclusive", () => {
    assert.deepEqual(
      firstOfMonthsThrough("2026-06-01", "2026-08-15"),
      ["2026-06-01", "2026-07-01", "2026-08-01"]
    );
  });

  test("returns just the start month when today is within it", () => {
    assert.deepEqual(firstOfMonthsThrough("2026-06-01", "2026-06-05"), ["2026-06-01"]);
  });

  test("returns nothing when today is before the start date", () => {
    assert.deepEqual(firstOfMonthsThrough("2026-06-01", "2026-05-15"), []);
  });

  test("rolls over the year boundary", () => {
    assert.deepEqual(
      firstOfMonthsThrough("2026-11-01", "2027-01-10"),
      ["2026-11-01", "2026-12-01", "2027-01-01"]
    );
  });
});

describe("computeInvestorUnitsAtDateWithTransfers (lib/nav.js)", () => {
  const fernando = { id: FERNANDO_ID };
  const dario    = { id: DARIO_ID };
  const pablo    = { id: PABLO_ID };
  const transfers = [
    { date: "2026-06-01", type: "management_fee", from: FERNANDO_ID, to: PABLO_ID, units: 100 },
    { date: "2026-06-01", type: "management_fee", from: DARIO_ID,    to: PABLO_ID, units: 300 },
  ];

  test("the payer's units decrease by the transferred amount", () => {
    const plain     = computeInvestorUnitsAtDate(BASE_DEPOSITS, fernando, "2026-07-01");
    const withXfers = computeInvestorUnitsAtDateWithTransfers(BASE_DEPOSITS, transfers, fernando, "2026-07-01");
    assert.equal(plain - withXfers, 100);
  });

  test("the payee's units increase by the total transferred", () => {
    const plain     = computeInvestorUnitsAtDate(BASE_DEPOSITS, pablo, "2026-07-01");
    const withXfers = computeInvestorUnitsAtDateWithTransfers(BASE_DEPOSITS, transfers, pablo, "2026-07-01");
    assert.equal(withXfers - plain, 400); // 100 from Fernando + 300 from Dario
  });

  test("a transfer dated after the cutoff is excluded", () => {
    const withXfers = computeInvestorUnitsAtDateWithTransfers(BASE_DEPOSITS, transfers, fernando, "2026-05-31");
    const plain     = computeInvestorUnitsAtDate(BASE_DEPOSITS, fernando, "2026-05-31");
    assert.equal(withXfers, plain); // June 1 transfer not yet in effect
  });

  test("an uninvolved investor (Juana) is unaffected", () => {
    const juana = { id: JUANA_ID };
    const plain     = computeInvestorUnitsAtDate(BASE_DEPOSITS, juana, "2026-07-01");
    const withXfers = computeInvestorUnitsAtDateWithTransfers(BASE_DEPOSITS, transfers, juana, "2026-07-01");
    assert.equal(plain, withXfers);
  });

  // The core invariant: a unit transfer only reallocates ownership, it never
  // mints or destroys fund value. If this ever fails, the fee mechanism is
  // silently changing total units outstanding — which would corrupt NAV/unit
  // for every investor, not just the two involved in the transfer.
  test("total units across every investor is unchanged before and after applying transfers", () => {
    const investors = [fernando, dario, { id: JUANA_ID }, { id: LUCIA_ID }, pablo];
    const totalPlain = investors.reduce((s, inv) => s + computeInvestorUnitsAtDate(BASE_DEPOSITS, inv, "2026-07-01"), 0);
    const totalWithXfers = investors.reduce((s, inv) => s + computeInvestorUnitsAtDateWithTransfers(BASE_DEPOSITS, transfers, inv, "2026-07-01"), 0);
    assert.ok(Math.abs(totalPlain - totalWithXfers) < 1e-9);
    // Also matches the fund-wide total computed independently of any
    // per-investor enumeration.
    const fundTotal = computeTotalUnitsAtDate(BASE_DEPOSITS, "2026-07-01");
    assert.ok(Math.abs(totalWithXfers - fundTotal) < 1e-9);
  });
});

describe("computeInvestorUnitTransferNet / unitTransferBelongsTo", () => {
  test("net is negative for a payer, positive for a payee", () => {
    const transfers = [{ date: "2026-06-01", from: "inv_fernando", to: "pablo_montoya", units: 50 }];
    assert.equal(computeInvestorUnitTransferNet(transfers, { id: "inv_fernando" }, "2026-06-01"), -50);
    assert.equal(computeInvestorUnitTransferNet(transfers, { id: "pablo_montoya" }, "2026-06-01"), 50);
  });

  test("unitTransferBelongsTo matches either side of a transfer", () => {
    const t = { from: "inv_fernando", to: "pablo_montoya" };
    assert.ok(unitTransferBelongsTo(t, investorKeysFor({ id: "inv_fernando" })));
    assert.ok(unitTransferBelongsTo(t, investorKeysFor({ id: "pablo_montoya" })));
    assert.ok(!unitTransferBelongsTo(t, investorKeysFor({ id: "juana_robledo" })));
  });
});
