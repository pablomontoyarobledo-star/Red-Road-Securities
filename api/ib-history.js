import { list } from "@vercel/blob";

export default async function handler(req, res) {
  const auth = req.headers["x-sync-secret"];
  if (auth !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { blobs } = await list({ prefix: "ib-history/" });
    // Return newest first, include url + timestamp parsed from filename
    const entries = blobs
      .map(b => ({
        url:         b.url,
        pathname:    b.pathname,
        pulledAt:    b.pathname.replace("ib-history/", "").replace(".json", "").replace(/T(\d{2})-(\d{2})-(\d{2})-\d+Z/, "T$1:$2:$3Z").replace(/-(?=\d{2}:)/, "T"),
        size:        b.size,
        uploadedAt:  b.uploadedAt,
      }))
      .sort((a, b) => b.uploadedAt - a.uploadedAt);

    return res.status(200).json({ count: entries.length, entries });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
