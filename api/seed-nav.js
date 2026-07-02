// One-time endpoint: seeds nav-history.json from IB-computed historical TWR series.
// Called once via POST /api/seed-nav (admin secret required).
// Values derived from IB NAV Daily CSV — uses actual IB settlement dates, not wire-sent dates.
// After seeding, every IB pull appends automatically — this never needs to run again
// unless you want to re-seed (it overwrites).
// NOTE: Prefer /api/import-nav-csv for a full daily series. This seeds month-end points only.

import { put } from "@vercel/blob";

const INCEPTION_DATE = "2025-12-18";
// Inception NAV: $1,000 IB total / 1,000 units on Dec 18, 2025
const INCEPTION_NAV  = 1.0;   // $1.00 per unit

// Month-end dates are last IB trading days per IB NAV Daily export
// TWR base = Dec 31, 2025 (NAV = $990.21 / 1,000 units = $0.99021/unit = 100)
const SEED_SERIES = [
  { date: "2025-12-31", ibTotal: 990.21     },
  { date: "2026-01-30", ibTotal: 100241.73  },
  { date: "2026-02-27", ibTotal: 199792.02  },
  { date: "2026-03-31", ibTotal: 289795.23  },
  { date: "2026-04-30", ibTotal: 312557.02  },
  { date: "2026-05-29", ibTotal: 530838.62  },
  { date: "2026-06-30", ibTotal: 792144.58  },
];

// IB-derived TWR (base 100 = Dec 31 NAV, computed using actual cash settlement dates)
// Dec 29/30/Jan 2 deposits settled Jan 5/6/7; Jan 28 → Feb 3; Mar 12 → Mar 18;
// Apr 27 → May 1; May 11 → May 15; Jun 8 → Jun 8
const SEED_TWR = [100.00, 100.73, 100.50, 96.64, 104.22, 108.32, 107.82];

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
