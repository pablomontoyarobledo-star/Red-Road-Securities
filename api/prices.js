import { readDoc, writeDoc } from "../lib/store.js";

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
