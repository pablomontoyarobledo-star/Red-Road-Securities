// Shared NAV-point ingestion — appends one entry to nav-history.json from a
// freshly-observed totalValue, applying the plausibility check, pre-money
// deposit re-pricing self-heal, and pending-cash folding identically no
// matter which path observed the value. Originally lived only in the daily
// IB cron pull (api/ib-data.js); pulled out here so the manual XML import
// path (api/import-ib-xml.js) can append a NAV point the same way instead
// of updating fund-data.json's positions/cash while leaving nav-history.json
// — the document every return figure actually reads — stale until the next
// automated pull.
import { readDoc, writeDoc } from "./store.js";
import {
  INCEPTION_NAV,
  computeTotalUnitsAtDate,
  depositCash,
  checkPlausibleTotalValue,
  fixIbDepositNavs,
  recomputeNavSeries,
  applyPendingToLatest,
} from "./nav.js";

const INCEPTION_DATE = "2025-12-18";

export async function appendNavPoint({ totalValue, dateStr, deposits, pendingCash = 0 }) {
  let navHistory = { inception: { date: INCEPTION_DATE, nav: INCEPTION_NAV }, series: [] };
  try {
    const nh = await readDoc("nav-history.json");
    if (nh) navHistory = nh;
  } catch {}

  const totalUnits = computeTotalUnitsAtDate(deposits, dateStr);
  const nav        = totalUnits > 0 ? totalValue / totalUnits : INCEPTION_NAV;
  const twr        = (nav / (navHistory.inception?.nav || INCEPTION_NAV)) * 100;

  // Daily P&L — compare against the most recent prior entry
  const prior = [...navHistory.series].reverse().find(e => e.date < dateStr);
  const dailyReturnPct = prior ? ((nav / prior.nav) - 1) * 100 : 0;
  const dailyPnlUsd    = prior ? (nav - prior.nav) * totalUnits : 0;

  // Flag (don't block) an implausible day-over-day swing that today's net
  // deposits don't explain — likely a garbled/partial response (IB cron, or
  // a bad manual paste) rather than real performance.
  // See lib/nav.js#checkPlausibleTotalValue.
  const netDepositsToday = (deposits || [])
    .filter(d => d.date === dateStr)
    .reduce((s, d) => s + depositCash(d), 0);
  const plausibility = prior ? checkPlausibleTotalValue(totalValue, prior.totalValue, netDepositsToday) : { suspect: false };
  if (plausibility.suspect) {
    console.warn(`[navPoint] suspect NAV swing on ${dateStr}:`, plausibility);
  }

  const point = {
    date: dateStr,
    nav:           Math.round(nav        * 1e8) / 1e8,
    totalValue:    Math.round(totalValue * 1e6) / 1e6,
    totalUnits:    Math.round(totalUnits * 1e4) / 1e4,
    twr:           Math.round(twr        * 1e4) / 1e4,
    dailyReturnPct: Math.round(dailyReturnPct * 1e4) / 1e4,
    dailyPnlUsd:   Math.round(dailyPnlUsd    * 1e2) / 1e2,
    source: "ib-live",
    ...(plausibility.suspect ? { suspect: true, suspectDetail: plausibility } : {}),
  };

  const existing = navHistory.series.findIndex(e => e.date === dateStr);
  if (existing >= 0) {
    navHistory.series[existing] = point;
  } else {
    navHistory.series.push(point);
    navHistory.series.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Self-heal on every ingestion, no manual step:
  //  1. Re-price IB-detected deposits at fair pre-money NAV (a wire priced at
  //     the post-cash NAV mints too few units for the depositor).
  //  2. Recompute totalUnits/nav/twr for every point from the current ledger
  //     (a deposit excluded from a day's unit count when that point was first
  //     written — malformed date, late allocation — never self-corrects
  //     otherwise, silently inflating NAV for every investor).
  const depositsChanged = fixIbDepositNavs(deposits, navHistory.series) > 0;
  recomputeNavSeries(navHistory.series, deposits, navHistory.inception?.nav || INCEPTION_NAV);

  // Fold un-allocated pending-deposit cash into the latest point (neutral NAV).
  applyPendingToLatest(navHistory.series, pendingCash, navHistory.inception?.nav || INCEPTION_NAV);
  const latest = navHistory.series[navHistory.series.length - 1];

  await writeDoc("nav-history.json", navHistory);

  return { point: latest || point, depositsChanged, pendingCash };
}
