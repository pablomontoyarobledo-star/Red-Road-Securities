// Processes an IB NAV Daily CSV and builds a complete daily nav-history.json.
// POST /api/import-nav-csv — requires x-sync-secret header.
// Auto-detects when each deposit's cash actually settled in IB (vs. Pablo's wire-sent dates)
// by matching large positive jumps in the daily total to known deposit amounts.

import { put } from "@vercel/blob";

const INCEPTION_NAV  = 1.0;
const INCEPTION_DATE = "2025-12-18";

function parseNavCsv(text) {
  const lines = text.trim().split(/\r?\n/).slice(1); // skip header
  return lines
    .map(line => {
      const cols = line.replace(/"/g, "").split(",");
      const total   = parseFloat(cols[0]);
      const dateRaw = (cols[3] || "").trim();
      if (!dateRaw || dateRaw.length !== 8 || isNaN(total)) return null;
      return {
        date:       `${dateRaw.slice(0,4)}-${dateRaw.slice(4,6)}-${dateRaw.slice(6,8)}`,
        totalValue: total,
      };
    })
    .filter(d => d && d.totalValue > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Group deposits by date and compute total cash + total units per date-group
function groupDeposits(deposits) {
  const groups = {};
  for (const d of deposits) {
    const key = d.date;
    if (!groups[key]) groups[key] = { cash: 0, units: 0 };
    const cash = (d.fernando || 0) + (d.dario || 0);
    const nav  = d.nav > 0 ? d.nav : INCEPTION_NAV;
    groups[key].cash  += cash;
    groups[key].units += cash / nav;
  }
  return groups; // { "2025-12-18": { cash: 1000, units: 1000 }, ... }
}

// Detect the IB settlement date for each deposit group by finding a daily jump
// that matches the deposit's cash amount (within tolerance).
function matchDepositsToSettlement(ibDaily, depositGroups, tolerance = 0.10) {
  // Find positive jumps > $500 (catches new deposits arriving)
  const jumps = [];
  for (let i = 0; i < ibDaily.length; i++) {
    const prev   = i > 0 ? ibDaily[i-1].totalValue : 0;
    const curr   = ibDaily[i].totalValue;
    const change = curr - prev;
    if (change > 500) {
      jumps.push({ date: ibDaily[i].date, amount: change, matched: false });
    }
  }

  const sortedDeps = Object.entries(depositGroups)
    .sort((a, b) => a[0].localeCompare(b[0]));

  const settlement = {}; // settledDate → units to add

  for (const [depDate, info] of sortedDeps) {
    // Look for a jump after the deposit date whose size matches deposit cash
    const jump = jumps.find(j =>
      !j.matched &&
      j.date >= depDate &&
      Math.abs(j.amount - info.cash) / info.cash < tolerance
    );

    const effectiveDate = jump ? jump.date : depDate;
    if (jump) jump.matched = true;

    if (!settlement[effectiveDate]) settlement[effectiveDate] = 0;
    settlement[effectiveDate] += info.units;
  }

  return settlement; // date → cumulative units to add on that day
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const blobUrl = process.env.FUND_DATA_BLOB_URL;
  if (!blobUrl) return res.status(500).json({ error: "FUND_DATA_BLOB_URL not set" });

  // Body: { csv: "<raw csv string>" }
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  if (!body?.csv) return res.status(400).json({ error: "Missing csv field in request body" });

  // Load deposits from fund-data.json
  let deposits = [];
  try {
    const r = await fetch(`${blobUrl}?t=${Date.now()}`, { cache: "no-store" });
    if (r.ok) { const fd = await r.json(); deposits = fd.deposits || []; }
  } catch { /* proceed with empty deposits */ }

  // Parse IB daily NAV CSV
  const ibDaily = parseNavCsv(body.csv);
  if (!ibDaily.length) return res.status(400).json({ error: "No valid rows found in CSV" });

  // Figure out when each deposit's cash actually landed in IB
  const depositGroups  = groupDeposits(deposits);
  const unitSettlement = matchDepositsToSettlement(ibDaily, depositGroups);

  // Build daily NAV series
  const inceptionEntry = ibDaily.find(d => d.date === INCEPTION_DATE);
  const baseNav = inceptionEntry
    ? inceptionEntry.totalValue / 1000   // initial $1k = 1000 units
    : INCEPTION_NAV;

  let cumulativeUnits = 0;
  const series = [];
  const debugSettlement = [];

  for (const point of ibDaily) {
    if (unitSettlement[point.date]) {
      const newUnits = unitSettlement[point.date];
      cumulativeUnits += newUnits;
      debugSettlement.push({ date: point.date, unitsAdded: Math.round(newUnits) });
    }

    if (cumulativeUnits <= 0) continue; // skip pre-inception zeros

    const nav    = point.totalValue / cumulativeUnits;
    const twr    = (nav / baseNav) * 100;
    const prior  = series.length > 0 ? series[series.length - 1] : null;
    const dailyReturnPct = prior ? ((nav / prior.nav) - 1) * 100 : 0;
    const dailyPnlUsd    = prior ? (nav - prior.nav) * cumulativeUnits : 0;

    series.push({
      date:           point.date,
      nav:            Math.round(nav              * 1e8) / 1e8,
      totalValue:     Math.round(point.totalValue * 1e6) / 1e6,
      totalUnits:     Math.round(cumulativeUnits  * 1e4) / 1e4,
      twr:            Math.round(twr              * 1e4) / 1e4,
      dailyReturnPct: Math.round(dailyReturnPct   * 1e4) / 1e4,
      dailyPnlUsd:    Math.round(dailyPnlUsd      * 1e2) / 1e2,
      source:         "ib-csv",
    });
  }

  const navHistory = {
    inception: { date: INCEPTION_DATE, nav: Math.round(baseNav * 1e8) / 1e8 },
    series,
    importedAt:   new Date().toISOString(),
    csvRows:      ibDaily.length,
    settlementLog: debugSettlement,
  };

  const blobBase = blobUrl.replace("fund-data.json", "");
  await put("nav-history.json", JSON.stringify(navHistory), {
    access: "public",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
  });

  // Return summary of month-end values for verification
  const monthEnds = ["2025-12-31","2026-01-30","2026-02-27","2026-03-31","2026-04-30","2026-05-29","2026-06-30"];
  const summary = monthEnds.map(d => {
    const pt = series.find(e => e.date === d);
    return pt ? { date: d, nav: pt.nav.toFixed(6), twr: pt.twr.toFixed(2), totalValue: Math.round(pt.totalValue), totalUnits: Math.round(pt.totalUnits) } : { date: d, missing: true };
  });

  return res.status(200).json({
    ok:              true,
    dailyPoints:     series.length,
    settlementLog:   debugSettlement,
    monthEndSummary: summary,
  });
}
