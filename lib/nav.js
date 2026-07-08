// Shared NAV/unit-count math used by the IB cron pull (api/ib-data.js), the
// NAV-history rebuild (api/ib-nav-history.js), and the deposit-repair action
// (api/allocate-deposit.js) — kept in one place so they can never disagree.

export const INCEPTION_NAV = 1.0;

const DEPOSIT_META_KEYS = new Set([
  "date", "amount", "source", "nav", "investor", "ibDesc", "currency", "description",
]);

// Cash amount of a deposit record, whichever shape it uses:
// {investor:"key", amount:N} or per-investor keys {fernando:N, juana_robledo:N, ...}
export function depositCash(d) {
  if (d.investor) return d.amount || 0;
  return Object.entries(d)
    .filter(([k, v]) => !DEPOSIT_META_KEYS.has(k) && typeof v === "number" && v > 0)
    .reduce((s, [, v]) => s + v, 0);
}

// Total units outstanding as of a given date (deposit-date convention).
// Used where all relevant deposits have already settled, e.g. pricing a new
// allocation against the latest snapshot.
export function computeTotalUnitsAtDate(deposits, dateStr) {
  return (deposits || [])
    .filter(d => d.date <= dateStr)
    .reduce((sum, d) => {
      const nav = d.nav > 0 ? d.nav : INCEPTION_NAV;
      return sum + depositCash(d) / nav;
    }, 0);
}

// Build a unit-settlement schedule: for each deposit date, find the day the
// cash actually appears in IB's reported total (wires often credit a day or
// more after their report date) and settle the units there. A jump matches a
// deposit when it lands within 10% of the cash OR within 2% of the portfolio
// value (daily market moves pollute the jump for small deposits, so a pure
// percent-of-deposit tolerance misses them). Unmatched deposits settle on
// their own date. Returns { "YYYY-MM-DD": unitsAdded }.
export function buildUnitSchedule(deposits, series) {
  const groups = {};
  for (const d of deposits || []) {
    const cash = depositCash(d);
    if (cash <= 0) continue;
    const nav = d.nav > 0 ? d.nav : INCEPTION_NAV;
    if (!groups[d.date]) groups[d.date] = { cash: 0, units: 0 };
    groups[d.date].cash  += cash;
    groups[d.date].units += cash / nav;
  }

  const jumps = [];
  for (let i = 1; i < (series || []).length; i++) {
    const change = series[i].totalValue - series[i - 1].totalValue;
    if (change > 500) jumps.push({ date: series[i].date, amount: change, value: series[i].totalValue, matched: false });
  }

  const schedule = {};
  for (const [depDate, info] of Object.entries(groups).sort()) {
    const jump = jumps.find(j =>
      !j.matched && j.date >= depDate &&
      Math.abs(j.amount - info.cash) < Math.max(info.cash * 0.10, j.value * 0.02)
    );
    if (jump) jump.matched = true;
    const effectiveDate = jump ? jump.date : depDate;
    schedule[effectiveDate] = (schedule[effectiveDate] || 0) + info.units;
  }
  return schedule;
}

// Correct the mint NAV on IB-detected deposits (records carrying ibDesc).
//
// When a wire is allocated, the nav-history's latest NAV already includes the
// new cash in totalValue but not the new units — so pricing the deposit at
// that NAV is inflated and mints too few units for the depositor. The fair
// price is pre-money: (V_credit − amount) / units_before, where the credit
// point is the first series entry on/after the deposit date whose totalValue
// visibly jumped by the arriving cash. Deposits are processed chronologically
// so later fixes use earlier ones. Pure math over existing data — no IB call.
// Returns count of navs changed.
export function fixIbDepositNavs(deposits, series) {
  if (!series?.length) return 0;
  let changed = 0;
  const ibDeps = (deposits || [])
    .filter(d => d.ibDesc && d.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const dep of ibDeps) {
    let credit = null;
    for (let i = 0; i < series.length; i++) {
      if (series[i].date < dep.date) continue;
      const prev = i > 0 ? series[i - 1].totalValue : 0;
      const jump = series[i].totalValue - prev;
      if (Math.abs(jump - dep.amount) < Math.max(dep.amount * 0.10, series[i].totalValue * 0.02)) {
        credit = series[i];
        break;
      }
    }
    if (!credit) continue;

    const others = deposits.filter(d => d !== dep);
    const unitsBefore = computeTotalUnitsAtDate(others, credit.date);
    if (unitsBefore <= 0) continue;

    const fairNav = Math.round(((credit.totalValue - dep.amount) / unitsBefore) * 1e8) / 1e8;
    if (fairNav > 0 && Math.abs(fairNav - (dep.nav || 0)) > 1e-6) {
      dep.nav = fairNav;
      changed++;
    }
  }
  return changed;
}

// Recompute totalUnits/nav/twr for every point in a nav-history series from
// the current deposit ledger, settling units on cash-arrival dates, then
// cascade daily P&L deltas. Pure math — no IB call, so safe to run any time
// (repair action, cron pull) without touching IB's rate limit.
// Mutates the series in place; returns count of points whose units changed.
export function recomputeNavSeries(series, deposits, inceptionNav = INCEPTION_NAV) {
  if (!series?.length) return 0;
  const schedule = buildUnitSchedule(deposits, series);

  let units = 0;
  let changed = 0;
  for (const pt of series) {
    if (schedule[pt.date]) units += schedule[pt.date];
    if (units <= 0) continue;
    const rounded = Math.round(units * 1e4) / 1e4;
    if (Math.abs(rounded - pt.totalUnits) > 0.01) changed++;
    pt.totalUnits = rounded;
    pt.nav        = Math.round((pt.totalValue / units) * 1e8) / 1e8;
    pt.twr        = Math.round((pt.nav / inceptionNav) * 100 * 1e4) / 1e4;
  }
  for (let i = 1; i < series.length; i++) {
    const p = series[i - 1], c = series[i];
    c.dailyReturnPct = Math.round(((c.nav / p.nav) - 1) * 100 * 1e4) / 1e4;
    c.dailyPnlUsd    = Math.round((c.nav - p.nav) * c.totalUnits * 1e2) / 1e2;
  }
  return changed;
}
