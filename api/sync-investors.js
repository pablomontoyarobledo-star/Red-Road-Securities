// Investor data sync, plus backup listing/restore (folded in from the old
// restore-investors.js to stay under Vercel's per-deployment function cap).
//
//   GET                    → current investors.json
//   GET  ?backups=1        → list investor backups (Neon `snapshots` table)
//   POST { investors }     → overwrite investors.json (auto-backs up first)
//   POST { restoreBackupId } → restore investors.json from a given backup
import { readDoc, backupAndWrite, writeDoc, writeAuditLog, listSnapshots, readSnapshot } from "../lib/store.js";
import { isAdminRequest, identifyActor } from "../lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-sync-secret, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    // Return investors — PII, so secret required (clients use /api/data)
    if (!(await isAdminRequest(req))) return res.status(401).json({ error: "Unauthorized" });

    if (req.query?.backups) {
      const rows = await listSnapshots("backups", { limit: 100, namePrefix: "investors-" });
      return res.status(200).json({
        backups: rows.map(b => ({ id: b.id, name: b.name, uploadedAt: b.created_at })),
      });
    }

    try {
      const data = await readDoc("investors.json");
      if (!data) return res.status(404).json({ investors: [] });
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST") {
    if (!(await isAdminRequest(req))) return res.status(401).json({ error: "Unauthorized" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    if (body?.restoreBackupId) {
      const snap = await readSnapshot(body.restoreBackupId);
      if (!snap) return res.status(404).json({ error: "Backup not found" });
      const data = snap.data;
      if (!Array.isArray(data?.investors)) return res.status(400).json({ error: "Invalid backup format" });
      await writeDoc("investors.json", data);
      await writeAuditLog({
        actor: await identifyActor(req), action: "investors.restore",
        target: String(body.restoreBackupId), detail: { from: snap.name, count: data.investors.length },
      });
      return res.status(200).json({ ok: true, restored: data.investors.length, from: snap.name });
    }

    if (!Array.isArray(body?.investors)) {
      return res.status(400).json({ error: "Body must be { investors: [...] }" });
    }

    const payload = {
      investors:  body.investors,
      updatedAt:  new Date().toISOString(),
    };

    // backupAndWrite snapshots the current investors doc before overwriting.
    await backupAndWrite("investors.json", payload);

    await writeAuditLog({
      actor: await identifyActor(req), action: "investors.sync",
      detail: { count: body.investors.length },
    });

    return res.status(200).json({ ok: true, count: body.investors.length, updatedAt: payload.updatedAt });
  }

  return res.status(405).end();
}
