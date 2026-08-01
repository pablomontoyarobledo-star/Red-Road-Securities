// Lists all historical IB data pulls, now stored as rows in the Neon
// `snapshots` table (folder "ib-history") instead of ib-history/*.json blobs.
//
//   GET (authorized)            → { pulls: [{ id, timestamp, url, ...summary }] }
//   GET ?pull=<public_id>       → the full snapshot JSON for one pull
//
// The ?pull view backs the dashboard's "open pull in new tab" link. A new tab
// can't send the admin header, so — matching the old public-blob behaviour —
// single-snapshot reads are served without auth (operational data: positions,
// totals; the same figures a logged-in investor already sees). It's keyed by
// the snapshot's random public_id (a uuid), not the internal sequential id
// used everywhere else in this file — that id is enumerable, and an
// unauthenticated route keyed by it would let anyone walk every historical
// pull just by incrementing a number.
import { listSnapshotsWithData, readSnapshotByPublicId } from "../lib/store.js";
import { isAdminRequest } from "../lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Single-snapshot view (opened in a new browser tab from the pulls table).
  if (req.query?.pull) {
    const snap = await readSnapshotByPublicId(req.query.pull);
    if (!snap) return res.status(404).json({ error: "Not found" });
    return res.status(200).json(snap.data);
  }

  if (!(await isAdminRequest(req))) return res.status(401).json({ error: "Unauthorized" });
  try {
    const rows = await listSnapshotsWithData("ib-history", { limit: 500 });
    const pulls = rows.map(row => {
      const d = row.data || {};
      return {
        id:          row.id,
        timestamp:   row.created_at,
        url:         `/api/ib-pulls?pull=${row.public_id}`,
        totalValue:  d.totalValue  ?? d.equityTotal ?? null,
        cashBalance: d.cashBalance ?? null,
        nav:         d.nav         ?? null,
        twr:         d.twr         ?? null,
        positions:   Array.isArray(d.positions)    ? d.positions.length    : null,
        trades:      Array.isArray(d.transactions) ? d.transactions.length : null,
        source:      d.source      ?? "cron",
      };
    });
    return res.status(200).json({ pulls });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
