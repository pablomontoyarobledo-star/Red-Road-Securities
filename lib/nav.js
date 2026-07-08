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
// more after their record date) and settle the units there, so units never get
// counted before their cash — which is what makes NAV collapse then "recover".
//
// A jump matches a deposit when it lands within 10% of the cash amount. This
// tight, deposit-relative tolerance is deliberate: matching on a fraction of
// the whole portfolio instead lets a small deposit "match" an unrelated
// market-driven swing, mis-dating the settlement. Unmatched deposits fall back
// to their own date. Returns { "YYYY-MM-DD": unitsAdded }.
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
    if (change > 500) jumps.push({ date: series[i].date, amount: change, matched: false });
  }

  // A wire settles within a few days of its record date, never weeks later —
  // cap the search window so a deposit can't latch onto a coincidental
  // same-size market swing far in the future (which would leave the fund with
  // zero units in the interim and corrupt every point until it "settles").
  const MAX_LAG_DAYS = 12;
  const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 86400000;

  const schedule = {};
  for (const [depDate, info] of Object.entries(groups).sort()) {
    const jump = jumps.find(j =>
      !j.matched && j.date >= depDate && daysBetween(depDate, j.date) <= MAX_LAG_DAYS &&
      Math.abs(j.amount - info.cash) / info.cash < 0.10
    );
    if (jump) jump.matched = true;
    const effectiveDate = jump ? jump.date : depDate;
    schedule[effectiveDate] = (schedule[effectiveDate] || 0) + info.units;
  }
  return schedule;
}

// Price the mint NAV on IB-detected deposits (records carrying ibDesc).
//
// Core invariant: a deposit is struck at the NAV that exists the moment before
// its cash is counted, and must never move the NAV per unit. The correct mint
// price is therefore the last known NAV strictly before the deposit's date —
// the pre-money NAV. (An IB-detected deposit's stored NAV is initially the
// post-cash figure, which is inflated because the cash is in the numerator but
// the new units aren't yet in the denominator; that must be corrected.)
//
// Using the prior point's NAV — rather than reverse-engineering a cash "jump"
// out of IB's daily totals — is robust: daily market moves swamp a small
// deposit, so jump-matching mis-identifies the settlement day. Pure math over
// existing data, no IB call. Returns count of navs changed.
export function fixIbDepositNavs(deposits, series) {
  if (!series?.length) return 0;
  let changed = 0;
  const ibDeps = (deposits || []).filter(d => d.ibDesc && d.amount > 0);

  for (const dep of ibDeps) {
    let priorNav = null;
    for (const pt of series) {
      if (pt.date < dep.date && pt.nav > 0) priorNav = pt.nav;
      else if (pt.date >= dep.date) break;
    }
    if (priorNav && Math.abs(priorNav - (dep.nav || 0)) > 1e-6) {
      dep.nav = Math.round(priorNav * 1e8) / 1e8;
      changed++;
    }
  }
  return changed;
}

// Recompute nav/units/twr for every point from IB's intact daily total values
// and the deposit ledger. Units accumulate on their settlement dates (via
// buildUnitSchedule), and NAV = totalValue / units — the same method IB's own
// NAV-history rebuild uses, applied to the totalValues already stored in the
// series (which stay correct even when nav/units drift). Because units settle
// only when their cash lands, this reproduces the authoritative series with no
// IB call. Points before the first settlement keep their prior values.
// Mutates the series in place; returns count of points whose NAV changed.
export function recomputeNavSeries(series, deposits, inceptionNav = INCEPTION_NAV) {
  if (!series?.length) return 0;
  const schedule = buildUnitSchedule(deposits, series);

  let units = 0;
  let changed = 0;
  for (const pt of series) {
    if (schedule[pt.date]) units += schedule[pt.date];
    if (units <= 0) continue;
    const nav  = pt.totalValue / units;
    const navR = Math.round(nav * 1e8) / 1e8;
    if (Math.abs(navR - pt.nav) > 1e-8) changed++;
    pt.nav        = navR;
    pt.totalUnits = Math.round(units * 1e4) / 1e4;
    pt.twr        = Math.round((navR / inceptionNav) * 100 * 1e4) / 1e4;
  }

  for (let i = 1; i < series.length; i++) {
    const p = series[i - 1], c = series[i];
    c.dailyReturnPct = Math.round(((c.nav / p.nav) - 1) * 100 * 1e4) / 1e4;
    c.dailyPnlUsd    = Math.round((c.nav - p.nav) * c.totalUnits * 1e2) / 1e2;
  }
  return changed;
}
