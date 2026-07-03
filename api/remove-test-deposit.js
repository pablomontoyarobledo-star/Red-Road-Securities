import { put } from "@vercel/blob";
const BLOB_BASE = process.env.FUND_DATA_BLOB_URL?.replace("fund-data.json", "") || "";
export default async function handler(req, res) {
  const r = await fetch(`${BLOB_BASE}fund-data.json?t=${Date.now()}`, { cache: "no-store" });
  const fd = await r.json();
  const before = (fd.deposits || []).length;
  fd.deposits = (fd.deposits || []).filter(d => !(d.amount === 12345 && d.date === "2026-07-03"));
  await put("fund-data.json", JSON.stringify(fd), { access:"public", contentType:"application/json", allowOverwrite:true, addRandomSuffix:false });
  return res.status(200).json({ removed: before - fd.deposits.length, deposits: fd.deposits });
}
