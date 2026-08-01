import { backupAndWrite, writeAuditLog } from "../lib/store.js";
import { isAdminRequest, identifyActor } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await isAdminRequest(req))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

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
