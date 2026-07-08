// Shared NAV/unit-count math used by both the IB cron pull (api/ib-data.js)
// and the deposit-repair action (api/allocate-deposit.js) — kept in one
// place so the two never drift out of sync with each other.

export const INCEPTION_NAV = 1.0;

const DEPOSIT_META_KEYS = new Set([
  "date", "amount", "source", "nav", "investor", "ibDesc", "currency", "description",
]);

// Total units outstanding as of a given date, from the fund's deposit ledger.
// Handles both deposit record shapes: {investor:"key", amount:N} and the
// legacy per-investor-key shape {fernando:N, dario:N, ...}.
export function computeTotalUnitsAtDate(deposits, dateStr) {
  return (deposits || [])
    .filter(d => d.date <= dateStr)
    .reduce((sum, d) => {
      const nav = d.nav > 0 ? d.nav : INCEPTION_NAV;
      if (d.investor) {
        return sum + (d.amount || 0) / nav;
      }
      const invTotal = Object.entries(d)
        .filter(([k, v]) => !DEPOSIT_META_KEYS.has(k) && typeof v === "number" && v > 0)
        .reduce((s, [, v]) => s + v, 0);
      return sum + invTotal / nav;
    }, 0);
}

// Recompute totalUnits/nav/twr for every point in a nav-history series using
// the CURRENT deposit ledger, then cascade daily P&L deltas. Pure math —
// no IB call, so safe to run any time (repair action, cron pull, etc.)
// without touching IB's rate limit. Mutates and returns the series.
export function recomputeNavSeries(series, deposits, inceptionNav = INCEPTION_NAV) {
  let changed = 0;
  for (const pt of series) {
    const correctUnits = computeTotalUnitsAtDate(deposits, pt.date);
    if (correctUnits > 0 && Math.abs(correctUnits - pt.totalUnits) > 0.01) {
      pt.totalUnits = Math.round(correctUnits * 1e4) / 1e4;
      pt.nav        = Math.round((pt.totalValue / correctUnits) * 1e8) / 1e8;
      pt.twr        = Math.round((pt.nav / inceptionNav) * 100 * 1e4) / 1e4;
      changed++;
    }
  }
  for (let i = 1; i < series.length; i++) {
    const p = series[i - 1], c = series[i];
    c.dailyReturnPct = Math.round(((c.nav / p.nav) - 1) * 100 * 1e4) / 1e4;
    c.dailyPnlUsd    = Math.round((c.nav - p.nav) * c.totalUnits * 1e2) / 1e2;
  }
  return changed;
}
