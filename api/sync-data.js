import { writeDoc, writeAuditLog } from "../lib/store.js";
import { isAdminRequest, identifyActor } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const payload = { ...body, syncedAt: new Date().toISOString() };
  await writeDoc("fund-data.json", payload);

  await writeAuditLog({ actor: identifyActor(req), action: "fund-data.sync" });

  return res.status(200).json({ ok: true, syncedAt: payload.syncedAt });
}
