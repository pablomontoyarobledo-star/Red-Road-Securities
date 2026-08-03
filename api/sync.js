// Cloud sync for admin-owned documents — folds sync-data.js and
// sync-investors.js into one file to stay under Vercel's per-deployment
// Serverless Function cap. Route by ?target=fund|investors.
//
//   POST ?target=fund       { ...fund-data fields }    → overwrite fund-data.json (auto-backs up first)
//   GET  ?target=investors                             → current investors.json
//   GET  ?target=investors&backups=1                   → list investor backups (Neon `snapshots` table)
//   POST ?target=investors  { investors }               → overwrite investors.json (auto-backs up first)
//   POST ?target=investors  { restoreBackupId }          → restore investors.json from a given backup

import { readDoc, backupAndWrite, writeDoc, writeAuditLog, listSnapshots, readSnapshot } from "../lib/store.js";
import { isAdminRequest, identifyActor } from "../lib/auth.js";

async function handleFund(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await isAdminRequest(req))) return res.status(401).json({ error: "Unauthorized" });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  // backupAndWrite snapshots the current fund-data.json (deposit ledger,
  // positions, transactions) before overwriting — this endpoint replaces the
  // whole document from whatever the client currently holds, so a stale tab
  // or a client-side bug must not be able to destroy history with no
  // rollback trail (every other fund-data.json writer already does this).
  const payload = { ...body, syncedAt: new Date().toISOString() };
  await backupAndWrite("fund-data.json", payload);

  await writeAuditLog({ actor: await identifyActor(req), action: "fund-data.sync" });

  return res.status(200).json({ ok: true, syncedAt: payload.syncedAt });
}

async function handleInvestors(req, res) {
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-sync-secret, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const target = req.query?.target;
  if (target === "fund") return handleFund(req, res);
  if (target === "investors") return handleInvestors(req, res);
  return res.status(400).json({ error: "Unknown or missing ?target= (expected fund|investors)" });
}
