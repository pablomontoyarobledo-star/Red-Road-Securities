// Lists all historical IB data pulls from ib-history/*.json in Vercel Blob
import { list } from "@vercel/blob";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    // List all blobs under ib-history/ prefix
    const { blobs } = await list({ prefix: "ib-history/", limit: 500 });

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
