// Lists all historical IB data pulls from ib-history/*.json in Vercel Blob
import { list } from "@vercel/blob";
import { bprefix } from "../lib/store.js";

function isAuthorized(req) {
  const syncSecret = process.env.SYNC_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  if (syncSecret && req.headers["x-sync-secret"] === syncSecret) return true;
  if (cronSecret && req.headers["authorization"] === `Bearer ${cronSecret}`) return true;
  return false;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!isAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    // List all blobs under ib-history/ prefix (old + suffixed locations)
    const [oldList, newList] = await Promise.all([
      list({ prefix: "ib-history/", limit: 500 }),
      bprefix("ib-history/") !== "ib-history/" ? list({ prefix: bprefix("ib-history/"), limit: 500 }) : Promise.resolve({ blobs: [] }),
    ]);
    const blobs = [...oldList.blobs, ...newList.blobs];

    // Sort newest first
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

    // Fetch each blob and extract summary fields
    const pulls = await Promise.all(blobs.map(async blob => {
      try {
        const r = await fetch(`${blob.url}?t=${Date.now()}`, { cache: "no-store" });
        if (!r.ok) return null;
        const d = await r.json();
        return {
          timestamp:   blob.uploadedAt,
          url:         blob.url,
          totalValue:  d.totalValue  ?? d.equityTotal ?? null,
          cashBalance: d.cashBalance ?? null,
          nav:         d.nav         ?? null,
          twr:         d.twr         ?? null,
          positions:   Array.isArray(d.positions)    ? d.positions.length    : null,
          trades:      Array.isArray(d.transactions) ? d.transactions.length : null,
          source:      d.source      ?? "cron",
        };
      } catch { return null; }
    }));

    return res.status(200).json({ pulls: pulls.filter(Boolean) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
