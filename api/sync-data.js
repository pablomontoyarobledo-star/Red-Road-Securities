import { put } from "@vercel/blob";
import { bname } from "../lib/store.js";
import { isAdminRequest } from "../lib/auth.js";

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

  const payload = JSON.stringify({ ...body, syncedAt: new Date().toISOString() });

  const blob = await put(bname("fund-data.json"), payload, {
    access: "public",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
  });

  return res.status(200).json({ ok: true, url: blob.url });
}
