import { readDoc, backupAndWrite, writeAuditLog } from "../lib/store.js";
import { isAdminRequest, identifyActor } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    // Return investors — PII, so secret required (clients use /api/data)
    if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const data = await readDoc("investors.json");
      if (!data) return res.status(404).json({ investors: [] });
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST") {
    if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
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
      actor: identifyActor(req), action: "investors.sync",
      detail: { count: body.investors.length },
    });

    return res.status(200).json({ ok: true, count: body.investors.length, updatedAt: payload.updatedAt });
  }

  return res.status(405).end();
}
