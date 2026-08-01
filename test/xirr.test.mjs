// Unit tests for lib/xirr.js — the money-weighted-return (XIRR) solver used
// by the investor statement email and the dashboard ownership cards.
//
// Run with:  node --test test/

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { xirr } from "../lib/xirr.js";

const day = (s) => new Date(s + "T12:00:00Z");

describe("xirr", () => {
  test("returns null for fewer than two cash flows", () => {
    assert.equal(xirr([]), null);
    assert.equal(xirr([{ date: day("2026-01-01"), amount: -1000 }]), null);
  });

  test("single deposit, exact annualized gain matches simple compounding", () => {
    const r = xirr([
      { date: day("2025-07-31"), amount: -1000 },
      { date: day("2026-07-31"), amount: 1100 },
    ]);
    assert.ok(Math.abs(r - 0.10) < 1e-4);
  });

  test("total wipeout (final value exactly $0) is -100%", () => {
    // No positive cash flow anywhere, so no finite rate zeroes the NPV —
    // the -100% floor is a special case, not something bisection can find.
    const r = xirr([
      { date: day("2025-07-31"), amount: -1000 },
      { date: day("2026-07-31"), amount: 0 },
    ]);
    assert.equal(r, -1);
  });

  test("single deposit, partial loss over one year", () => {
    const r = xirr([
      { date: day("2025-07-31"), amount: -1000 },
      { date: day("2026-07-31"), amount: 500 },
    ]);
    assert.ok(Math.abs(r - -0.5) < 1e-4);
  });

  test("two deposits at different dates weight the later, shorter-lived one less", () => {
    // $1000 two years ago, $1000 one year ago, worth $2500 today.
    const r = xirr([
      { date: day("2024-07-31"), amount: -1000 },
      { date: day("2025-07-31"), amount: -1000 },
      { date: day("2026-07-31"), amount: 2500 },
    ]);
    // NPV at that rate should be ~0 — the defining property of XIRR.
    const years = (d) => (d - day("2024-07-31")) / (365 * 86400000);
    const npv =
      -1000 / Math.pow(1 + r, years(day("2024-07-31"))) +
      -1000 / Math.pow(1 + r, years(day("2025-07-31"))) +
      2500 / Math.pow(1 + r, years(day("2026-07-31")));
    assert.ok(Math.abs(npv) < 1e-4);
    assert.ok(r > 0); // net gain overall
  });

  test("cash flows out of chronological order are handled the same", () => {
    const ordered = xirr([
      { date: day("2025-01-01"), amount: -1000 },
      { date: day("2026-01-01"), amount: 1200 },
    ]);
    const reversed = xirr([
      { date: day("2026-01-01"), amount: 1200 },
      { date: day("2025-01-01"), amount: -1000 },
    ]);
    assert.ok(Math.abs(ordered - reversed) < 1e-9);
  });
});
