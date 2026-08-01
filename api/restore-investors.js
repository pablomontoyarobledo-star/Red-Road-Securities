// Lists available investor backups (GET) or restores one (POST { backupId }).
// Backups now live as rows in the Neon `snapshots` table (folder "backups",
// name "investors-<timestamp>.json") instead of blob files.
import { listSnapshots, readSnapshot, writeDoc, writeAuditLog } from "../lib/store.js";
import { isAdminRequest, identifyActor } from "../lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-sync-secret, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!(await isAdminRequest(req))) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    const rows = await listSnapshots("backups", { limit: 100, namePrefix: "investors-" });
    return res.status(200).json({
      backups: rows.map(b => ({ id: b.id, name: b.name, uploadedAt: b.created_at })),
    });
  }

  if (req.method === "POST") {
    const { backupId } = req.body || {};
    if (!backupId) return res.status(400).json({ error: "backupId required" });
    const snap = await readSnapshot(backupId);
    if (!snap) return res.status(404).json({ error: "Backup not found" });
    const data = snap.data;
    if (!Array.isArray(data?.investors)) return res.status(400).json({ error: "Invalid backup format" });
    await writeDoc("investors.json", data);
    await writeAuditLog({
      actor: await identifyActor(req), action: "investors.restore",
      target: String(backupId), detail: { from: snap.name, count: data.investors.length },
    });
    return res.status(200).json({ ok: true, restored: data.investors.length, from: snap.name });
  }

  return res.status(405).end();
}
