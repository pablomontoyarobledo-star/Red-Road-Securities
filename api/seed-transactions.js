// ONE-TIME: moves hardcoded trade history into fund-data.json
// Safe to run multiple times — deduplicates by date+ticker+shares+price
import { put } from "@vercel/blob";

const BLOB_BASE = "https://yt6mbeqqdx5ifzj3.public.blob.vercel-storage.com/";

const SEED_TRADES = [
  {"date":"2026-06-08","ticker":"VTI","type":"buy","shares":220,       "price":367.49,      "notes":""},
  {"date":"2026-06-08","ticker":"BND","type":"buy","shares":400,       "price":72.875,      "notes":""},
  {"date":"2026-06-08","ticker":"VTI","type":"buy","shares":270.8884,  "price":367.529916,  "notes":""},
  {"date":"2026-06-08","ticker":"BND","type":"buy","shares":690,       "price":72.865,      "notes":""},
  {"date":"2026-06-03","ticker":"BND","type":"dividend","shares":null, "price":0.247259,    "notes":"Cash dividend"},
  {"date":"2026-05-19","ticker":"BND","type":"buy","shares":730,       "price":72.5,        "notes":""},
  {"date":"2026-05-19","ticker":"BND","type":"buy","shares":30,        "price":72.505,      "notes":""},
  {"date":"2026-05-19","ticker":"BND","type":"buy","shares":6,         "price":72.4893,     "notes":""},
  {"date":"2026-05-19","ticker":"VTI","type":"buy","shares":110,       "price":360.9,       "notes":""},
  {"date":"2026-05-19","ticker":"VTI","type":"buy","shares":9,         "price":360.74,      "notes":""},
  {"date":"2026-05-19","ticker":"VTI","type":"buy","shares":5,         "price":360.7,       "notes":""},
  {"date":"2026-05-18","ticker":"VTI","type":"buy","shares":1,         "price":363.34,      "notes":""},
  {"date":"2026-05-05","ticker":"BND","type":"dividend","shares":null, "price":0.241713,    "notes":"Cash dividend"},
  {"date":"2026-05-01","ticker":"BND","type":"buy","shares":350,       "price":73.438,      "notes":""},
  {"date":"2026-05-01","ticker":"BND","type":"buy","shares":10,        "price":73.4393,     "notes":""},
  {"date":"2026-05-01","ticker":"VTI","type":"buy","shares":205,       "price":356.41,      "notes":""},
  {"date":"2026-04-09","ticker":"BND","type":"buy","shares":4,         "price":73.7493,     "notes":""},
  {"date":"2026-04-06","ticker":"BND","type":"dividend","shares":null, "price":0.250016,    "notes":"Cash dividend"},
  {"date":"2026-04-01","ticker":"BND","type":"buy","shares":10,        "price":73.44,       "notes":""},
  {"date":"2026-04-01","ticker":"BND","type":"sell","shares":1,        "price":73.4307,     "notes":""},
  {"date":"2026-03-31","ticker":"VTI","type":"dividend","shares":null, "price":0.9982,      "notes":"Cash dividend"},
  {"date":"2026-03-31","ticker":"BND","type":"sell","shares":77,       "price":73.66,       "notes":""},
  {"date":"2026-03-31","ticker":"VTI","type":"buy","shares":17,        "price":316.5593,    "notes":""},
  {"date":"2026-03-31","ticker":"VTI","type":"buy","shares":1,         "price":316.22,      "notes":""},
  {"date":"2026-03-18","ticker":"BND","type":"buy","shares":360,       "price":73.9,        "notes":""},
  {"date":"2026-03-18","ticker":"BND","type":"buy","shares":10,        "price":73.8793,     "notes":""},
  {"date":"2026-03-18","ticker":"BND","type":"buy","shares":2,         "price":73.88,       "notes":""},
  {"date":"2026-03-18","ticker":"VTI","type":"buy","shares":220,       "price":329.41,      "notes":""},
  {"date":"2026-03-12","ticker":"BND","type":"buy","shares":2,         "price":73.655,      "notes":""},
  {"date":"2026-03-04","ticker":"BND","type":"dividend","shares":null, "price":0.227824,    "notes":"Cash dividend"},
  {"date":"2026-02-24","ticker":"BND","type":"buy","shares":3,         "price":74.9293,     "notes":""},
  {"date":"2026-02-04","ticker":"BND","type":"dividend","shares":null, "price":0.24547,     "notes":"Cash dividend"},
  {"date":"2026-02-03","ticker":"BND","type":"buy","shares":338,       "price":73.86,       "notes":""},
  {"date":"2026-02-03","ticker":"BND","type":"sell","shares":6,        "price":73.86,       "notes":""},
  {"date":"2026-02-03","ticker":"VTI","type":"buy","shares":220,       "price":343.02,      "notes":""},
  {"date":"2026-01-07","ticker":"BND","type":"buy","shares":335,       "price":74.3,        "notes":""},
  {"date":"2026-01-07","ticker":"VTI","type":"buy","shares":43,        "price":341.36,      "notes":""},
  {"date":"2026-01-07","ticker":"VTI","type":"buy","shares":1.5,       "price":341.2533,    "notes":""},
  {"date":"2026-01-06","ticker":"VTI","type":"buy","shares":85,        "price":338.9486,    "notes":""},
  {"date":"2026-01-06","ticker":"VTI","type":"buy","shares":6,         "price":338.9485,    "notes":""},
  {"date":"2026-01-05","ticker":"VTI","type":"buy","shares":85,        "price":339.25,      "notes":""},
  {"date":"2026-01-05","ticker":"VTI","type":"sell","shares":2,        "price":339.2809,    "notes":""},
  {"date":"2025-12-23","ticker":"VTI","type":"buy","shares":2.5,       "price":338.788,     "notes":""},
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const r = await fetch(`${BLOB_BASE}fund-data.json?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) return res.status(502).json({ error: "Could not load fund-data.json" });
  const fundData = await r.json();

  const existing = fundData.transactions || [];
  const existingKeys = new Set(existing.map(t => `${t.date}_${t.ticker}_${t.shares}_${t.price}`));

  const toAdd = SEED_TRADES.filter(t => !existingKeys.has(`${t.date}_${t.ticker}_${t.shares}_${t.price}`));
  fundData.transactions = [...existing, ...toAdd].sort((a, b) => b.date.localeCompare(a.date));

  await put("fund-data.json", JSON.stringify(fundData), {
    access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
  });

  return res.status(200).json({ ok: true, added: toAdd.length, total: fundData.transactions.length });
}
