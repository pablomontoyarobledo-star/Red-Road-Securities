import { put } from "@vercel/blob";

function isAuthorized(req) {
  const syncSecret = process.env.SYNC_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  if (syncSecret && req.headers["x-sync-secret"] === syncSecret) return true;
  if (cronSecret && req.headers["authorization"] === `Bearer ${cronSecret}`) return true;
  return false;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    // Return investors from blob
    const blobUrl = process.env.FUND_DATA_BLOB_URL;
    if (!blobUrl) return res.status(500).json({ error: "FUND_DATA_BLOB_URL not set" });
    const blobBase = blobUrl.replace("fund-data.json", "");
    try {
      const r = await fetch(`${blobBase}investors.json?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return res.status(404).json({ investors: [] });
      return res.status(200).json(await r.json());
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST") {
    if (!isAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });
    const blobUrl = process.env.FUND_DATA_BLOB_URL;
    if (!blobUrl) return res.status(500).json({ error: "FUND_DATA_BLOB_URL not set" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!Array.isArray(body?.investors)) {
      return res.status(400).json({ error: "Body must be { investors: [...] }" });
    }

    const payload = {
      investors:  body.investors,
      updatedAt:  new Date().toISOString(),
    };

    // Backup before overwrite
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await put(`backups/investors-${stamp}.json`, JSON.stringify(payload), {
        access: "public", contentType: "application/json", addRandomSuffix: false,
      });
    } catch {}

    await put("investors.json", JSON.stringify(payload), {
      access: "public",
      contentType: "application/json",
      allowOverwrite: true,
      addRandomSuffix: false,
    });

    return res.status(200).json({ ok: true, count: body.investors.length, updatedAt: payload.updatedAt });
  }

  return res.status(405).end();
}
