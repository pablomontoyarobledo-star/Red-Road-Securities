// Lists available investor backups (GET) or restores one (POST ?backup=<url>)
import { list, put } from "@vercel/blob";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    const { blobs } = await list({ prefix: "backups/investors-", limit: 100 });
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    return res.status(200).json({ backups: blobs.map(b => ({ url: b.url, uploadedAt: b.uploadedAt })) });
  }

  if (req.method === "POST") {
    const { backupUrl } = req.body || {};
    if (!backupUrl) return res.status(400).json({ error: "backupUrl required" });
    const r = await fetch(backupUrl);
    if (!r.ok) return res.status(502).json({ error: "Could not fetch backup" });
    const data = await r.json();
    if (!Array.isArray(data.investors)) return res.status(400).json({ error: "Invalid backup format" });
    await put("investors.json", JSON.stringify(data), {
      access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
    });
    return res.status(200).json({ ok: true, restored: data.investors.length, from: backupUrl });
  }

  return res.status(405).end();
}
