import { readDoc, writeDoc, writeSnapshot } from "../lib/store.js";

const CACHE_FILE = "price-cache.json";
const CACHE_TTL  = 3 * 60 * 1000; // 3 minutes

const YF_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin":          "https://finance.yahoo.com",
  "Referer":         "https://finance.yahoo.com/",
};

async function fetchYahooPrice(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
  const r   = await fetch(url, { headers: YF_HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!price || price <= 0) throw new Error("no price in response");
  return price;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  // TEMP: token-gated dedupe of deposits by IB transactionID + drop already-
  // allocated pending entries. Backs up before writing. dry=1 previews only.
  if (req.query.diag === "dedupe" && req.query.k === "rrs-7x2p9q") {
    const fd = await readDoc("fund-data.json");
    const pd = (await readDoc("pending-deposits.json")) || { deposits: [] };
    if (!fd) return res.status(200).json({ ok: false, reason: "no fund-data" });

    const seen = new Set();
    const removedFd = [];
    const keptDeposits = (fd.deposits || []).filter(d => {
      if (!d.txId) return true;                    // legacy records (no txId) untouched
      if (seen.has(d.txId)) { removedFd.push(d); return false; } // duplicate wire
      seen.add(d.txId); return true;               // first occurrence kept
    });
    const allocatedTx = new Set(keptDeposits.filter(d => d.txId).map(d => d.txId));
    const removedPend = [];
    const keptPending = (pd.deposits || []).filter(d => {
      if (d.txId && allocatedTx.has(d.txId)) { removedPend.push(d); return false; }
      return true;
    });

    if (req.query.dry === "1") return res.status(200).json({ ok: true, dryRun: true, removedFd, removedPend });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try { await writeSnapshot("backups", `fund-data-dedupe-${stamp}.json`, fd); } catch {}
    try { await writeSnapshot("backups", `pending-dedupe-${stamp}.json`, pd); } catch {}
    fd.deposits = keptDeposits;
    pd.deposits = keptPending;
    await writeDoc("fund-data.json", fd);
    await writeDoc("pending-deposits.json", pd);
    return res.status(200).json({ ok: true, removedFd, removedPend, remainingDeposits: fd.deposits.length });
  }

  const tickersParam = req.query.tickers || "VTI,BND";
  const tickers = tickersParam.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);

  // Try cache first
  try {
    const cached = await readDoc(CACHE_FILE);
    if (cached) {
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < CACHE_TTL && tickers.every(t => cached.prices[t] != null)) {
        return res.status(200).json({ prices: cached.prices, fromCache: true, ageSeconds: Math.round(age / 1000) });
      }
    }
  } catch {}

  // Fetch live prices — try both Yahoo query1 and query2 for each ticker
  const prices = {};
  await Promise.all(tickers.map(async ticker => {
    // Try query1 first, then query2
    for (const host of ["query1", "query2"]) {
      try {
        const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
        const r   = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(5000) });
        if (!r.ok) continue;
        const data  = await r.json();
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (price && price > 0) { prices[ticker] = price; return; }
      } catch {}
    }
    // Also try the v7 quote endpoint as last resort
    try {
      const url   = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}&fields=regularMarketPrice`;
      const r     = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const data  = await r.json();
        const price = data?.quoteResponse?.result?.[0]?.regularMarketPrice;
        if (price && price > 0) { prices[ticker] = price; return; }
      }
    } catch {}
  }));

  // Cache result
  try {
    await writeDoc(CACHE_FILE, { prices, fetchedAt: new Date().toISOString() });
  } catch {}

  const missing = tickers.filter(t => !prices[t]);
  return res.status(200).json({
    prices,
    fromCache: false,
    fetchedAt: new Date().toISOString(),
    ...(missing.length ? { partial: true, missing } : {}),
  });
}
