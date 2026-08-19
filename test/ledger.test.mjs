// Unit tests for lib/ledger.js's pure math — assertBalanced and flipLines
// are deliberately DB-free (see lib/ledger.js's header comment) so the
// core double-entry invariant is testable without a database.
//
// Run with:  node --test test/

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assertBalanced, flipLines, LedgerImbalanceError } from "../lib/ledger.js";

describe("assertBalanced", () => {
  test("accepts a balanced two-line entry", () => {
    assert.doesNotThrow(() => assertBalanced([
      { accountCode: "1000", debit: 100, credit: 0 },
      { accountCode: "4000", debit: 0, credit: 100 },
    ]));
  });

  test("accepts a balanced multi-line entry (the two-leg monthly fee shape)", () => {
    assert.doesNotThrow(() => assertBalanced([
      { accountCode: "5200", investorId: "inv_fernando", debit: 120.50, credit: 0 },
      { accountCode: "4300", investorId: "pablo_montoya", debit: 0, credit: 120.50 },
      { accountCode: "5200", investorId: "inv_dario", debit: 279.50, credit: 0 },
      { accountCode: "4300", investorId: "pablo_montoya", debit: 0, credit: 279.50 },
    ]));
  });

  test("rejects an entry where total debits don't equal total credits", () => {
    assert.throws(() => assertBalanced([
      { accountCode: "1000", debit: 100, credit: 0 },
      { accountCode: "4000", debit: 0, credit: 99 },
    ]), LedgerImbalanceError);
  });

  test("rejects a line with both debit and credit set", () => {
    assert.throws(() => assertBalanced([
      { accountCode: "1000", debit: 100, credit: 100 },
    ]), LedgerImbalanceError);
  });

  test("rejects a line with neither debit nor credit set", () => {
    assert.throws(() => assertBalanced([
      { accountCode: "1000", debit: 0, credit: 0 },
      { accountCode: "4000", debit: 0, credit: 100 },
    ]), LedgerImbalanceError);
  });

  test("rejects an empty line list", () => {
    assert.throws(() => assertBalanced([]), LedgerImbalanceError);
  });

  test("tolerates floating-point noise within a cent", () => {
    assert.doesNotThrow(() => assertBalanced([
      { accountCode: "1000", debit: 0.1 + 0.2, credit: 0 }, // 0.30000000000000004
      { accountCode: "4000", debit: 0, credit: 0.3 },
    ]));
  });
});

describe("flipLines", () => {
  test("swaps debit and credit on every line", () => {
    const flipped = flipLines([
      { accountCode: "1000", debit: 100, credit: 0 },
      { accountCode: "4000", debit: 0, credit: 100 },
    ]);
    assert.deepEqual(flipped, [
      { accountCode: "1000", debit: 0, credit: 100 },
      { accountCode: "4000", debit: 100, credit: 0 },
    ]);
  });

  test("a reversal of a reversal restores the original", () => {
    const original = [
      { accountCode: "5100", debit: 42.5, credit: 0 },
      { accountCode: "1000", debit: 0, credit: 42.5 },
    ];
    const twiceFlipped = flipLines(flipLines(original));
    assert.deepEqual(twiceFlipped, original);
  });

  test("the flipped entry itself still balances", () => {
    const flipped = flipLines([
      { accountCode: "1100", debit: 500, credit: 0 },
      { accountCode: "1000", debit: 0, credit: 500 },
    ]);
    assert.doesNotThrow(() => assertBalanced(flipped));
  });
});
