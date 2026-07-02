// One-time endpoint: seeds nav-history.json from Pablo's confirmed historical TWR series.
// Called once via POST /api/seed-nav (admin secret required).
// After seeding, every IB pull appends automatically — this never needs to run again
// unless you want to re-seed (it overwrites).

import { put } from "@vercel/blob";

const INCEPTION_DATE = "2025-12-18";
const INCEPTION_NAV  = 1.0;

// Pablo's confirmed month-end TWR series (indexed to 100 at inception Dec 18 2025)
const SEED_SERIES = [
  { date: "2025-12-31" },
  { date: "2026-01-31" },
  { date: "2026-02-28" },
  { date: "2026-03-31" },
  { date: "2026-04-30" },
  { date: "2026-05-31" },
  { date: "2026-06-30" },
];

// TWR index values for each month-end (base 100 = inception NAV $1.00)
const SEED_TWR = [100.00, 100.73, 100.70, 96.64, 104.23, 108.50, 105.47];

function computeTotalUnitsAtDate(deposits, dateStr) {
  return deposits
    .filter(d => d.date <= dateStr)
    .reduce((sum, d) => {
      const nav = d.nav > 0 ? d.nav : INCEPTION_NAV;
      return sum + ((d.fernando || 0) + (d.dario || 0)) / nav;
    }, 0);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const auth = req.headers["x-sync-secret"];
  if (auth !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const blobUrl = process.env.FUND_DATA_BLOB_URL;
  if (!blobUrl) return res.status(500).json({ error: "FUND_DATA_BLOB_URL not set" });

  let fundData;
  try {
    const r = await fetch(`${blobUrl}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`Blob fetch failed: ${r.status}`);
    fundData = await r.json();
  } catch (err) {
    return res.status(500).json({ error: "Could not load fund-data.json: " + err.message });
  }

  const deposits = fundData.deposits || [];

  const series = SEED_SERIES.map(({ date }, i) => {
    const twr        = SEED_TWR[i];
    const nav        = (twr / 100) * INCEPTION_NAV;
    const totalUnits = computeTotalUnitsAtDate(deposits, date);
    const totalValue = totalUnits * nav;
    return { date, nav, totalValue, totalUnits, twr, source: "seed" };
  });

  const navHistory = {
    inception:  { date: INCEPTION_DATE, nav: INCEPTION_NAV },
    series,
    seededAt:   new Date().toISOString(),
  };

  const blobBase = blobUrl.replace("fund-data.json", "");
  await put("nav-history.json", JSON.stringify(navHistory), {
    access: "public",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
  });

  return res.status(200).json({
    ok: true,
    points: series.length,
    series: series.map(e => ({ date: e.date, nav: e.nav.toFixed(6), totalUnits: Math.round(e.totalUnits), totalValue: Math.round(e.totalValue) })),
  });
}
